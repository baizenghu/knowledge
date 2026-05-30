import { createOpaqueId, type KnowledgeErrorCode } from "@octopus/knowledge-contracts";
import type { EmbeddingAdapter } from "../embedding/embedding-adapter.js";
import type { RerankAdapter } from "../rerank/rerank-adapter.js";
import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type {
  EvalDatasetRecord,
  EvalSample,
  KnowledgeEvalDatasetStore,
} from "../repositories/eval-dataset-store.js";
import type {
  EvalRunConfig,
  EvalRunMetrics,
  EvalRunMetricsGroup,
  EvalRunRecord,
  EvalRunStatus,
  EvalSampleHit,
  EvalSampleResult,
  KnowledgeEvalRunStore,
} from "../repositories/eval-run-store.js";
import { requireTenantScope, type TenantScope } from "../repositories/tenant-scope.js";
import type { KnowledgeAnswerService } from "./answer-service.js";
import type { KnowledgeSearchService, SearchContext } from "./search-service.js";

export type EvaluationServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: KnowledgeErrorCode; message: string };

const RECALL_KS = [1, 3, 5, 10];

const DEFAULT_TOP_K = 10;
const DEFAULT_FINAL_K = 5;

export type CreateDatasetInput = {
  name: string;
  version: string;
  annotator: string;
  samples: EvalSample[];
  metadata?: Record<string, unknown>;
  userId: string;
};

export class KnowledgeEvaluationService {
  constructor(private readonly deps: {
    datasets: KnowledgeEvalDatasetStore;
    runs: KnowledgeEvalRunStore;
    search: KnowledgeSearchService;
    answer?: KnowledgeAnswerService;
    embedding: EmbeddingAdapter;
    reranker?: RerankAdapter;
    audit: KnowledgeAuditEventWriter;
    now?: () => Date;
  }) {}

  private nowDate(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async createDataset(
    scope: TenantScope,
    input: CreateDatasetInput,
  ): Promise<EvaluationServiceResult<{ dataset_id: string }>> {
    const safeScope = requireTenantScope(scope);
    if (!input.name?.trim()) {
      return { ok: false, code: "BAD_REQUEST", message: "name is required" };
    }
    if (!input.version?.trim()) {
      return { ok: false, code: "BAD_REQUEST", message: "version is required" };
    }
    if (!input.annotator?.trim()) {
      return { ok: false, code: "BAD_REQUEST", message: "annotator is required" };
    }
    if (!Array.isArray(input.samples) || input.samples.length === 0) {
      return { ok: false, code: "BAD_REQUEST", message: "samples is required" };
    }
    const datasetId = createOpaqueId("eval");
    const record: EvalDatasetRecord = {
      ...safeScope,
      datasetId,
      name: input.name,
      version: input.version,
      annotator: input.annotator,
      samples: input.samples,
      metadata: input.metadata,
      createdAt: this.nowDate(),
    };
    await this.deps.datasets.create(record);
    await this.deps.audit.write({
      ...safeScope,
      userId: input.userId,
      action: "knowledge.eval_dataset.create",
      resourceType: "eval_dataset",
      resourceId: datasetId,
      success: true,
      details: { name: input.name, version: input.version, sample_count: input.samples.length },
    });
    return { ok: true, data: { dataset_id: datasetId } };
  }

  async createRun(
    scope: TenantScope,
    datasetId: string,
    config: EvalRunConfig,
    userId: string,
  ): Promise<EvaluationServiceResult<{ run_id: string; status: EvalRunStatus }>> {
    const safeScope = requireTenantScope(scope);
    const dataset = await this.deps.datasets.get(safeScope, datasetId);
    if (!dataset) {
      return { ok: false, code: "NOT_FOUND", message: "dataset not found" };
    }
    const now = this.nowDate();
    const runId = createOpaqueId("evalrun");
    const record: EvalRunRecord = {
      ...safeScope,
      runId,
      datasetId,
      status: "queued",
      config: { ...config },
      metrics: null,
      failedSamples: [],
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.runs.create(record);
    await this.deps.audit.write({
      ...safeScope,
      userId,
      action: "knowledge.eval_run.create",
      resourceType: "eval_run",
      resourceId: runId,
      success: true,
      details: { dataset_id: datasetId, config: redactConfig(config) },
    });
    return { ok: true, data: { run_id: runId, status: "queued" } };
  }

  async getRun(
    scope: TenantScope,
    runId: string,
  ): Promise<EvaluationServiceResult<EvalRunRecord>> {
    const safeScope = requireTenantScope(scope);
    const run = await this.deps.runs.get(safeScope, runId);
    if (!run) {
      return { ok: false, code: "NOT_FOUND", message: "run not found" };
    }
    return { ok: true, data: run };
  }

  async runSync(
    scope: TenantScope,
    runId: string,
  ): Promise<EvaluationServiceResult<EvalRunRecord>> {
    const safeScope = requireTenantScope(scope);
    const run = await this.deps.runs.get(safeScope, runId);
    if (!run) {
      return { ok: false, code: "NOT_FOUND", message: "run not found" };
    }
    const dataset = await this.deps.datasets.get(safeScope, run.datasetId);
    if (!dataset) {
      return { ok: false, code: "NOT_FOUND", message: "dataset not found" };
    }
    const startedAt = this.nowDate();
    await this.deps.runs.update(safeScope, runId, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });

    const topK = run.config.topK ?? DEFAULT_TOP_K;
    const finalK = run.config.finalK ?? DEFAULT_FINAL_K;
    const runAnswer = Boolean(run.config.runAnswer && this.deps.answer);

    const sampleResults: EvalSampleResult[] = [];
    try {
      for (const sample of dataset.samples) {
        const ctx: SearchContext = sample.contextOverride
          ? {
              tenantId: safeScope.tenantId,
              userId: sample.contextOverride.userId,
              departments: sample.contextOverride.departments ?? [],
              roles: sample.contextOverride.roles ?? [],
            }
          : {
              tenantId: safeScope.tenantId,
              userId: "eval-runner",
              departments: [],
              roles: [],
            };

        const started = Date.now();
        const searchResult = await this.deps.search.search(
          safeScope,
          {
            query: sample.query,
            topK,
            finalK,
            spaceIds: sample.expectedSpaceIds ?? undefined,
          },
          ctx,
        );
        if (!searchResult.ok) {
          sampleResults.push({
            sampleId: sample.sampleId,
            query: sample.query,
            status: "failed",
            reason: `search ${searchResult.code}: ${searchResult.message}`,
            hits: [],
            expected_document_ids: [...sample.expectedDocumentIds],
            expected_anchor_ids: sample.expectedAnchorIds ? [...sample.expectedAnchorIds] : undefined,
            recall_hit_rank: null,
            latency_ms: Date.now() - started,
          });
          continue;
        }
        const hits = searchResult.data.hits;
        const hitsOut: EvalSampleHit[] = hits.map((hit, idx) => ({
          document_id: hit.documentId,
          chunk_id: hit.chunkId,
          rank: idx + 1,
          score: hit.score,
        }));
        const expected = new Set(sample.expectedDocumentIds);
        const recallHitRank = hitsOut.find((hit) => expected.has(hit.document_id))?.rank ?? null;

        let citationsReturned: Array<{ anchor_id: string; document_id: string }> | undefined;
        if (runAnswer && this.deps.answer) {
          const answerResult = await this.deps.answer.answer(
            safeScope,
            { query: sample.query, finalK, spaceIds: sample.expectedSpaceIds ?? undefined },
            ctx,
          );
          if (answerResult.ok) {
            citationsReturned = answerResult.data.citations.map((c) => ({
              anchor_id: c.anchorId,
              document_id: c.documentId,
            }));
          }
        }

        sampleResults.push({
          sampleId: sample.sampleId,
          query: sample.query,
          status: "ok",
          hits: hitsOut,
          expected_document_ids: [...sample.expectedDocumentIds],
          expected_anchor_ids: sample.expectedAnchorIds ? [...sample.expectedAnchorIds] : undefined,
          citations_returned: citationsReturned,
          recall_hit_rank: recallHitRank,
          latency_ms: Date.now() - started,
        });
      }
    } catch (error) {
      const finishedAt = this.nowDate();
      await this.deps.runs.update(safeScope, runId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
      });
      await this.deps.audit.write({
        ...safeScope,
        action: "knowledge.eval_run.finished",
        resourceType: "eval_run",
        resourceId: runId,
        success: false,
        errorCode: "SERVICE_UNAVAILABLE",
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
      return { ok: false, code: "SERVICE_UNAVAILABLE", message: "evaluation run failed" };
    }

    const metrics = computeMetrics(sampleResults, {
      embeddingModel:
        run.config.embeddingModel ?? this.deps.embedding.metadata.model,
      rerankerModel:
        run.config.rerankerModel ?? this.deps.reranker?.metadata.model ?? null,
      runAnswer,
    });

    const failedSamples = sampleResults.filter((r) => r.status === "failed");
    const finishedAt = this.nowDate();
    const updated = await this.deps.runs.update(safeScope, runId, {
      status: "succeeded",
      metrics,
      failedSamples,
      finishedAt,
      updatedAt: finishedAt,
    });
    await this.deps.audit.write({
      ...safeScope,
      action: "knowledge.eval_run.finished",
      resourceType: "eval_run",
      resourceId: runId,
      success: true,
      details: {
        dataset_id: run.datasetId,
        sample_count: sampleResults.length,
        failed_sample_count: failedSamples.length,
        embedding_model: run.config.embeddingModel ?? this.deps.embedding.metadata.model,
      },
    });
    return { ok: true, data: updated! };
  }
}

function redactConfig(config: EvalRunConfig): Record<string, unknown> {
  return {
    top_k: config.topK,
    final_k: config.finalK,
    run_answer: config.runAnswer,
    parser_profile: config.parserProfile,
    embedding_model: config.embeddingModel,
    reranker_model: config.rerankerModel,
  };
}

function computeGroup(samples: EvalSampleResult[]): EvalRunMetricsGroup {
  const total = samples.length;
  const okSamples = samples.filter((s) => s.status === "ok");
  const latencies = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
  const recallAtK = RECALL_KS.map((k) => ({
    k,
    value:
      total === 0
        ? 0
        : okSamples.filter((s) => s.recall_hit_rank !== null && s.recall_hit_rank <= k).length / total,
  }));
  const mrr =
    total === 0
      ? 0
      : okSamples.reduce(
          (acc, s) => acc + (s.recall_hit_rank ? 1 / s.recall_hit_rank : 0),
          0,
        ) / total;

  const samplesWithExpectedAnchors = okSamples.filter(
    (s) => s.expected_anchor_ids && s.expected_anchor_ids.length > 0,
  );
  let citationAccuracy = 0;
  if (samplesWithExpectedAnchors.length > 0) {
    const hits = samplesWithExpectedAnchors.filter((s) => {
      const expected = new Set(s.expected_anchor_ids ?? []);
      const returned = s.citations_returned ?? [];
      return returned.some((c) => expected.has(c.anchor_id));
    });
    citationAccuracy = hits.length / samplesWithExpectedAnchors.length;
  }

  const emptyAnswerCount = okSamples.filter(
    (s) => s.hits.length === 0 || (s.citations_returned && s.citations_returned.length === 0),
  ).length;
  const emptyAnswerRate = total === 0 ? 0 : emptyAnswerCount / total;

  return {
    total_samples: total,
    recall_at_k: recallAtK,
    mrr,
    citation_accuracy: citationAccuracy,
    empty_answer_rate: emptyAnswerRate,
    latency_p50_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
  };
}

function computeMetrics(
  samples: EvalSampleResult[],
  context: { embeddingModel: string; rerankerModel: string | null; runAnswer: boolean },
): EvalRunMetrics {
  const base = computeGroup(samples);
  const grouped: Record<string, Record<string, EvalRunMetricsGroup>> = {
    embedding_model: {
      [context.embeddingModel]: computeGroup(samples),
    },
  };
  if (context.rerankerModel) {
    grouped["reranker_model"] = {
      [context.rerankerModel]: computeGroup(samples),
    };
  }

  // answer faithfulness: when runAnswer is true, count samples where expectedAnswer
  // has token overlap with at least one returned citation snippet (very simplified).
  // We don't have snippet here, so we expose the metric only when runAnswer is true
  // and citations were returned for at least one sample.
  let answerFaithfulness: number | null = null;
  if (context.runAnswer) {
    const okSamples = samples.filter((s) => s.status === "ok");
    if (okSamples.length > 0) {
      const withCitations = okSamples.filter(
        (s) => s.citations_returned && s.citations_returned.length > 0,
      ).length;
      answerFaithfulness = okSamples.length === 0 ? null : withCitations / okSamples.length;
    }
  }

  return {
    ...base,
    answer_faithfulness: answerFaithfulness,
    grouped_by: grouped,
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
