import { requireTenantScope, type TenantScope } from "./tenant-scope.js";

export type EvalRunStatus = "queued" | "running" | "succeeded" | "failed";

export type EvalRunMetricsGroup = {
  total_samples: number;
  recall_at_k: { k: number; value: number }[];
  mrr: number;
  citation_accuracy: number;
  empty_answer_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
};

export type EvalRunMetrics = EvalRunMetricsGroup & {
  answer_faithfulness?: number | null;
  grouped_by: Record<string, Record<string, EvalRunMetricsGroup>>;
};

export type EvalSampleHit = {
  document_id: string;
  chunk_id: string;
  rank: number;
  score: number;
};

export type EvalSampleResult = {
  sampleId: string;
  query: string;
  status: "ok" | "failed";
  reason?: string;
  hits: EvalSampleHit[];
  expected_document_ids: string[];
  expected_anchor_ids?: string[];
  citations_returned?: Array<{ anchor_id: string; document_id: string }>;
  recall_hit_rank: number | null;
  latency_ms: number;
};

export type EvalRunConfig = {
  topK?: number;
  finalK?: number;
  runAnswer?: boolean;
  parserProfile?: string;
  embeddingModel?: string;
  rerankerModel?: string;
};

export type EvalRunRecord = TenantScope & {
  runId: string;
  datasetId: string;
  status: EvalRunStatus;
  config: EvalRunConfig;
  metrics?: EvalRunMetrics | null;
  failedSamples: EvalSampleResult[];
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EvalRunPatch = Partial<
  Pick<EvalRunRecord, "status" | "metrics" | "failedSamples" | "startedAt" | "finishedAt" | "updatedAt">
>;

export interface KnowledgeEvalRunStore {
  create(record: EvalRunRecord): Promise<EvalRunRecord>;
  get(scope: TenantScope, runId: string): Promise<EvalRunRecord | null>;
  list(scope: TenantScope): Promise<EvalRunRecord[]>;
  update(scope: TenantScope, runId: string, patch: EvalRunPatch): Promise<EvalRunRecord | null>;
}

export class InMemoryKnowledgeEvalRunStore implements KnowledgeEvalRunStore {
  private readonly byId = new Map<string, EvalRunRecord>();

  async create(record: EvalRunRecord): Promise<EvalRunRecord> {
    const safeScope = requireTenantScope(record);
    const stored: EvalRunRecord = {
      ...record,
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      failedSamples: record.failedSamples.map((sample) => ({ ...sample })),
    };
    const key = this.key(stored.sourceSystemId, stored.tenantId, stored.runId);
    if (this.byId.has(key)) {
      throw new Error(`run already exists: ${stored.runId}`);
    }
    this.byId.set(key, stored);
    return cloneRun(stored);
  }

  async get(scope: TenantScope, runId: string): Promise<EvalRunRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = this.byId.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, runId));
    return record ? cloneRun(record) : null;
  }

  async list(scope: TenantScope): Promise<EvalRunRecord[]> {
    const safeScope = requireTenantScope(scope);
    return [...this.byId.values()]
      .filter((record) =>
        record.sourceSystemId === safeScope.sourceSystemId && record.tenantId === safeScope.tenantId,
      )
      .map(cloneRun);
  }

  async update(scope: TenantScope, runId: string, patch: EvalRunPatch): Promise<EvalRunRecord | null> {
    const safeScope = requireTenantScope(scope);
    const key = this.key(safeScope.sourceSystemId, safeScope.tenantId, runId);
    const record = this.byId.get(key);
    if (!record) return null;
    const next: EvalRunRecord = {
      ...record,
      ...patch,
      failedSamples: patch.failedSamples
        ? patch.failedSamples.map((sample) => ({ ...sample }))
        : record.failedSamples,
      metrics: patch.metrics !== undefined ? patch.metrics : record.metrics,
    };
    this.byId.set(key, next);
    return cloneRun(next);
  }

  private key(sourceSystemId: string, tenantId: string, runId: string): string {
    return `${sourceSystemId}:${tenantId}:${runId}`;
  }
}

function cloneRun(record: EvalRunRecord): EvalRunRecord {
  return {
    ...record,
    config: { ...record.config },
    failedSamples: record.failedSamples.map((sample) => ({ ...sample })),
    metrics: record.metrics
      ? {
          ...record.metrics,
          recall_at_k: record.metrics.recall_at_k.map((entry) => ({ ...entry })),
          grouped_by: cloneGroupedBy(record.metrics.grouped_by),
        }
      : record.metrics,
  };
}

function cloneGroupedBy(
  grouped: Record<string, Record<string, EvalRunMetricsGroup>>,
): Record<string, Record<string, EvalRunMetricsGroup>> {
  const out: Record<string, Record<string, EvalRunMetricsGroup>> = {};
  for (const [field, byValue] of Object.entries(grouped)) {
    out[field] = {};
    for (const [value, group] of Object.entries(byValue)) {
      out[field][value] = {
        ...group,
        recall_at_k: group.recall_at_k.map((entry) => ({ ...entry })),
      };
    }
  }
  return out;
}
