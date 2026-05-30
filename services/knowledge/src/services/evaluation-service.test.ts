import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeEvalDatasetStore, type EvalSample } from "../repositories/eval-dataset-store.js";
import { InMemoryKnowledgeEvalRunStore } from "../repositories/eval-run-store.js";
import type { EmbeddingAdapter } from "../embedding/embedding-adapter.js";
import type { RerankAdapter } from "../rerank/rerank-adapter.js";
import { KnowledgeEvaluationService } from "./evaluation-service.js";
import type { KnowledgeAnswerService } from "./answer-service.js";
import type { KnowledgeSearchService, SearchHit } from "./search-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

const embedding: EmbeddingAdapter = {
  metadata: { model: "mock-embed", version: "1.0.0", dimensions: 64 },
  async embedBatch() {
    return { status: "ok", vectors: [[]], metadata: { model: "mock-embed", version: "1.0.0", dimensions: 64 } };
  },
};

const reranker: RerankAdapter = {
  metadata: { model: "mock-rerank", version: "1.0.0" },
  async rerank() {
    return { status: "ok", ranked: [], metadata: { model: "mock-rerank", version: "1.0.0" } };
  },
};

function makeHit(docId: string, chunkId: string, anchorId: string): SearchHit {
  return {
    chunkId,
    documentId: docId,
    versionId: "ver_1",
    versionNumber: 1,
    spaceId: "space_1",
    text: `text for ${chunkId}`,
    headingPath: [],
    pageStart: 1,
    pageEnd: 1,
    score: 0.9,
    scores: { rrf: 0.5 },
    anchorId,
  };
}

function fakeSearch(byQuery: Record<string, SearchHit[]>): KnowledgeSearchService {
  return {
    async search(_scope, query) {
      return { ok: true, data: { hits: byQuery[query.query] ?? [] } };
    },
  } as unknown as KnowledgeSearchService;
}

function fakeAnswer(): KnowledgeAnswerService {
  return {
    async answer(_scope, query) {
      return {
        ok: true,
        data: {
          answer: `answer for ${query.query}`,
          citations: [
            { anchorId: "anchor_a", chunkId: "c1", documentId: "doc_1", page: 1, headingPath: [], snippet: "snip" },
          ],
        },
      };
    },
  } as unknown as KnowledgeAnswerService;
}

function makeService(opts: { search: KnowledgeSearchService; answer?: KnowledgeAnswerService }) {
  const datasets = new InMemoryKnowledgeEvalDatasetStore();
  const runs = new InMemoryKnowledgeEvalRunStore();
  const audit = new InMemoryKnowledgeAuditEventWriter();
  const service = new KnowledgeEvaluationService({
    datasets,
    runs,
    search: opts.search,
    answer: opts.answer,
    embedding,
    reranker,
    audit,
  });
  return { service, datasets, runs, audit };
}

const baseSamples: EvalSample[] = [
  { sampleId: "s1", query: "q1", expectedDocumentIds: ["doc_1"], expectedAnchorIds: ["anchor_a"] },
  { sampleId: "s2", query: "q2", expectedDocumentIds: ["doc_2"] },
  { sampleId: "s3", query: "q3", expectedDocumentIds: ["doc_3"] },
];

describe("KnowledgeEvaluationService", () => {
  it("runs end-to-end and computes metrics from search hits", async () => {
    const search = fakeSearch({
      q1: [makeHit("doc_1", "c1", "anchor_a")],
      q2: [makeHit("doc_x", "cx", "anchor_x"), makeHit("doc_2", "c2", "anchor_b")],
      q3: [],
    });
    const { service } = makeService({ search });
    const ds = await service.createDataset(scope, {
      name: "qa", version: "v1", annotator: "alice", samples: baseSamples, userId: "u",
    });
    expect(ds.ok).toBe(true);
    if (!ds.ok) return;
    const created = await service.createRun(scope, ds.data.dataset_id, { topK: 5, finalK: 5 }, "u");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const run = await service.runSync(scope, created.data.run_id);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data.status).toBe("succeeded");
    expect(run.data.metrics?.total_samples).toBe(3);
    // s1 hit at rank 1, s2 at rank 2, s3 miss -> recall@1=1/3, recall@5=2/3
    const r1 = run.data.metrics!.recall_at_k.find((r) => r.k === 1)!.value;
    const r5 = run.data.metrics!.recall_at_k.find((r) => r.k === 5)!.value;
    expect(r1).toBeCloseTo(1 / 3, 5);
    expect(r5).toBeCloseTo(2 / 3, 5);
    // MRR: (1 + 1/2 + 0) / 3
    expect(run.data.metrics!.mrr).toBeCloseTo((1 + 0.5) / 3, 5);
    expect(typeof run.data.metrics!.latency_p50_ms).toBe("number");
    expect(run.data.metrics!.grouped_by.embedding_model["mock-embed"]).toBeDefined();
    expect(run.data.metrics!.grouped_by.reranker_model["mock-rerank"]).toBeDefined();
  });

  it("yields recall@1=1 and MRR=1 when every sample's expected doc is rank 1", async () => {
    const search = fakeSearch({
      q1: [makeHit("doc_1", "c1", "anchor_a")],
      q2: [makeHit("doc_2", "c2", "anchor_b")],
      q3: [makeHit("doc_3", "c3", "anchor_c")],
    });
    const { service } = makeService({ search });
    const ds = await service.createDataset(scope, {
      name: "n", version: "v", annotator: "a", samples: baseSamples, userId: "u",
    });
    if (!ds.ok) throw new Error("create failed");
    const run = await service.createRun(scope, ds.data.dataset_id, {}, "u");
    if (!run.ok) throw new Error("run failed");
    const finished = await service.runSync(scope, run.data.run_id);
    if (!finished.ok) throw new Error("finish failed");
    expect(finished.data.metrics!.mrr).toBeCloseTo(1, 5);
    expect(finished.data.metrics!.recall_at_k.find((r) => r.k === 1)!.value).toBeCloseTo(1, 5);
  });

  it("yields zero recall and zero MRR when nothing matches", async () => {
    const search = fakeSearch({
      q1: [makeHit("doc_other", "c", "a")],
      q2: [],
      q3: [makeHit("doc_other", "c", "a")],
    });
    const { service } = makeService({ search });
    const ds = await service.createDataset(scope, {
      name: "n", version: "v", annotator: "a", samples: baseSamples, userId: "u",
    });
    if (!ds.ok) throw new Error("create failed");
    const run = await service.createRun(scope, ds.data.dataset_id, {}, "u");
    if (!run.ok) throw new Error("run failed");
    const finished = await service.runSync(scope, run.data.run_id);
    if (!finished.ok) throw new Error("finish failed");
    expect(finished.data.metrics!.mrr).toBe(0);
    for (const r of finished.data.metrics!.recall_at_k) {
      expect(r.value).toBe(0);
    }
  });

  it("captures citations_returned and computes citation_accuracy when runAnswer=true", async () => {
    const search = fakeSearch({
      q1: [makeHit("doc_1", "c1", "anchor_a")],
      q2: [makeHit("doc_2", "c2", "anchor_b")],
      q3: [],
    });
    const { service } = makeService({ search, answer: fakeAnswer() });
    const ds = await service.createDataset(scope, {
      name: "n", version: "v", annotator: "a", samples: baseSamples, userId: "u",
    });
    if (!ds.ok) throw new Error("create failed");
    const run = await service.createRun(scope, ds.data.dataset_id, { runAnswer: true }, "u");
    if (!run.ok) throw new Error("run failed");
    const finished = await service.runSync(scope, run.data.run_id);
    if (!finished.ok) throw new Error("finish failed");
    // s1 expects anchor_a, fakeAnswer returns anchor_a -> hit. Only s1 has expectedAnchorIds, so citation_accuracy = 1.
    expect(finished.data.metrics!.citation_accuracy).toBeCloseTo(1, 5);
    expect(finished.data.metrics!.answer_faithfulness).toBeCloseTo(1, 5);
  });

  it("scopes runs strictly: cross-tenant getRun is NOT_FOUND", async () => {
    const search = fakeSearch({ q1: [], q2: [], q3: [] });
    const { service } = makeService({ search });
    const ds = await service.createDataset(scope, {
      name: "n", version: "v", annotator: "a", samples: baseSamples, userId: "u",
    });
    if (!ds.ok) throw new Error();
    const run = await service.createRun(scope, ds.data.dataset_id, {}, "u");
    if (!run.ok) throw new Error();
    const cross = await service.getRun({ sourceSystemId: "octopus", tenantId: "tenant-other" }, run.data.run_id);
    expect(cross.ok).toBe(false);
    if (cross.ok) return;
    expect(cross.code).toBe("NOT_FOUND");
  });
});
