import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

export type KnowledgeChunkRecord = TenantScope & {
  chunkId: string;
  spaceId: string;
  documentId: string;
  versionId: string;
  versionNumber: number;
  chunkIndex: number;
  status: "active" | "shadow" | "deleted";
  text: string;
  textHash: string;
  tokenCount: number;
  nodeIds: string[];
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  bboxRefs: Array<{ nodeId: string; page: number; bbox?: { x0: number; y0: number; x1: number; y1: number } }>;
  aclHash: string;
  aclVersion: number;
  /**
   * Stable hash of (versionId + heading_path), used by section-level expansion
   * to group sibling chunks. Lazily computable from versionId + headingPath
   * but persisted at ingest for O(1) lookup.
   */
  sectionId: string;
  embeddingModel: string | null;
  embeddingVersion: string | null;
  vectorPointId: string | null;
  fulltextDocId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  deletedAt?: Date | null;
};

export type ChunkBulkInsert = Omit<KnowledgeChunkRecord, "createdAt" | "deletedAt"> & { createdAt?: Date };

export interface KnowledgeChunkStore {
  insertMany(scope: TenantScope, chunks: ChunkBulkInsert[], now?: Date): Promise<KnowledgeChunkRecord[]>;
  listForVersion(scope: TenantScope, versionId: string): Promise<KnowledgeChunkRecord[]>;
  promoteShadow(scope: TenantScope, versionId: string, now?: Date): Promise<number>;
  markDeletedForVersion(scope: TenantScope, versionId: string, now?: Date): Promise<number>;
  /**
   * Fetch chunks by id for retrieval-time hydration. Implementations MUST
   * enforce scope so chunk ids cannot be probed across tenants.
   */
  getMany(scope: TenantScope, chunkIds: string[]): Promise<KnowledgeChunkRecord[]>;
  /**
   * Small-to-Big retrieval helper. Returns active chunks of `versionId` whose
   * chunk_index falls in `[lo, hi]`, ordered by chunk_index. Used to expand
   * a matched chunk into a sibling window for richer LLM context.
   */
  listByIndexRange(scope: TenantScope, versionId: string, lo: number, hi: number): Promise<KnowledgeChunkRecord[]>;
  /**
   * Small-to-Big retrieval helper. Returns all active chunks belonging to the
   * given `sectionId` (= hash of `versionId + heading_path`), ordered by
   * chunk_index. Used for section-level expansion.
   */
  listForSection(scope: TenantScope, sectionId: string): Promise<KnowledgeChunkRecord[]>;
  /**
   * GC worker 内部使用：物理删除空间下所有 chunk 行（含已软删）。
   * 返回受影响行数。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
}

export class InMemoryKnowledgeChunkStore implements KnowledgeChunkStore {
  private readonly chunks = new Map<string, KnowledgeChunkRecord>();

  async insertMany(scope: TenantScope, chunks: ChunkBulkInsert[], now = new Date()): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const inserted: KnowledgeChunkRecord[] = [];
    for (const chunk of chunks) {
      const stored: KnowledgeChunkRecord = {
        ...chunk,
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        createdAt: chunk.createdAt ?? now,
      };
      this.chunks.set(this.key(stored.sourceSystemId, stored.tenantId, stored.chunkId), stored);
      inserted.push({ ...stored });
    }
    return inserted;
  }

  async listForVersion(scope: TenantScope, versionId: string): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    return [...this.chunks.values()]
      .filter((chunk) =>
        chunk.sourceSystemId === safeScope.sourceSystemId
        && chunk.tenantId === safeScope.tenantId
        && chunk.versionId === versionId
        && !chunk.deletedAt,
      )
      .map((chunk) => ({ ...chunk }));
  }

  async promoteShadow(scope: TenantScope, versionId: string, now = new Date()): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let promoted = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.sourceSystemId !== safeScope.sourceSystemId || chunk.tenantId !== safeScope.tenantId) continue;
      if (chunk.versionId !== versionId) continue;
      if (chunk.status !== "shadow") continue;
      chunk.status = "active";
      promoted += 1;
      void now;
    }
    return promoted;
  }

  async getMany(scope: TenantScope, chunkIds: string[]): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const out: KnowledgeChunkRecord[] = [];
    for (const chunkId of chunkIds) {
      const chunk = this.chunks.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, chunkId));
      if (chunk) {
        out.push({ ...chunk });
      }
    }
    return out;
  }

  async listByIndexRange(
    scope: TenantScope,
    versionId: string,
    lo: number,
    hi: number,
  ): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const out: KnowledgeChunkRecord[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.sourceSystemId !== safeScope.sourceSystemId || chunk.tenantId !== safeScope.tenantId) continue;
      if (chunk.versionId !== versionId) continue;
      if (chunk.status !== "active") continue;
      if (chunk.deletedAt) continue;
      if (chunk.chunkIndex < lo || chunk.chunkIndex > hi) continue;
      out.push({ ...chunk });
    }
    out.sort((a, b) => a.chunkIndex - b.chunkIndex);
    return out;
  }

  async listForSection(scope: TenantScope, sectionId: string): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const out: KnowledgeChunkRecord[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.sourceSystemId !== safeScope.sourceSystemId || chunk.tenantId !== safeScope.tenantId) continue;
      if (chunk.sectionId !== sectionId) continue;
      if (chunk.status !== "active") continue;
      if (chunk.deletedAt) continue;
      out.push({ ...chunk });
    }
    out.sort((a, b) => a.chunkIndex - b.chunkIndex);
    return out;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, chunk] of this.chunks) {
      if (
        chunk.sourceSystemId === safeScope.sourceSystemId
        && chunk.tenantId === safeScope.tenantId
        && chunk.spaceId === spaceId
      ) {
        this.chunks.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async markDeletedForVersion(scope: TenantScope, versionId: string, now = new Date()): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.sourceSystemId !== safeScope.sourceSystemId || chunk.tenantId !== safeScope.tenantId) continue;
      if (chunk.versionId !== versionId) continue;
      if (chunk.deletedAt) continue;
      chunk.deletedAt = now;
      chunk.status = "deleted";
      count += 1;
    }
    return count;
  }

  snapshot(): KnowledgeChunkRecord[] {
    return [...this.chunks.values()].map((chunk) => ({ ...chunk }));
  }

  private key(sourceSystemId: string, tenantId: string, chunkId: string): string {
    return `${sourceSystemId}:${tenantId}:${chunkId}`;
  }
}
