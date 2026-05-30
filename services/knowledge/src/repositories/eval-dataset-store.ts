import { requireTenantScope, type TenantScope } from "./tenant-scope.js";

export type EvalSampleContextOverride = {
  userId: string;
  departments?: string[];
  roles?: string[];
};

export type EvalSample = {
  sampleId: string;
  query: string;
  expectedDocumentIds: string[];
  expectedAnchorIds?: string[];
  expectedAnswer?: string | null;
  expectedSpaceIds?: string[] | null;
  contextOverride?: EvalSampleContextOverride;
  tags?: string[];
};

export type EvalDatasetRecord = TenantScope & {
  datasetId: string;
  name: string;
  version: string;
  annotator: string;
  samples: EvalSample[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export interface KnowledgeEvalDatasetStore {
  create(record: EvalDatasetRecord): Promise<EvalDatasetRecord>;
  get(scope: TenantScope, datasetId: string): Promise<EvalDatasetRecord | null>;
  list(scope: TenantScope): Promise<EvalDatasetRecord[]>;
}

export class InMemoryKnowledgeEvalDatasetStore implements KnowledgeEvalDatasetStore {
  private readonly byId = new Map<string, EvalDatasetRecord>();

  async create(record: EvalDatasetRecord): Promise<EvalDatasetRecord> {
    const safeScope = requireTenantScope(record);
    const stored: EvalDatasetRecord = {
      ...record,
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      samples: record.samples.map((sample) => ({ ...sample })),
    };
    const key = this.key(stored.sourceSystemId, stored.tenantId, stored.datasetId);
    if (this.byId.has(key)) {
      throw new Error(`dataset already exists: ${stored.datasetId}`);
    }
    this.byId.set(key, stored);
    return cloneDataset(stored);
  }

  async get(scope: TenantScope, datasetId: string): Promise<EvalDatasetRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = this.byId.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, datasetId));
    return record ? cloneDataset(record) : null;
  }

  async list(scope: TenantScope): Promise<EvalDatasetRecord[]> {
    const safeScope = requireTenantScope(scope);
    return [...this.byId.values()]
      .filter((record) =>
        record.sourceSystemId === safeScope.sourceSystemId && record.tenantId === safeScope.tenantId,
      )
      .map(cloneDataset);
  }

  private key(sourceSystemId: string, tenantId: string, datasetId: string): string {
    return `${sourceSystemId}:${tenantId}:${datasetId}`;
  }
}

function cloneDataset(record: EvalDatasetRecord): EvalDatasetRecord {
  return {
    ...record,
    samples: record.samples.map((sample) => ({ ...sample })),
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}
