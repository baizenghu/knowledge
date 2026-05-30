import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

/**
 * Citation anchors. An anchor is an opaque, scoped pointer that retrieval
 * returns instead of leaking internal chunk/document/version ids. UI clicks on
 * an anchor → citation-resolver verifies ACL and returns snippet + page.
 *
 * Scope rule (critical): `get` / `getByChunk` MUST reject cross-scope reads by
 * returning null. Returning a different error code than NOT_FOUND for a wrong
 * scope would leak anchor existence; never do that.
 */
export type KnowledgeAnchorRecord = TenantScope & {
  anchorId: string;
  chunkId: string;
  documentId: string;
  versionId: string;
  spaceId: string;
  aclHash: string;
  aclVersion: number;
  page: number | null;
  bbox?: { x0: number; y0: number; x1: number; y1: number } | null;
  charSpan?: { start: number; end: number } | null;
  nodeIds: string[];
  headingPath: string[];
  createdAt: Date;
};

export interface KnowledgeAnchorStore {
  upsert(record: KnowledgeAnchorRecord): Promise<KnowledgeAnchorRecord>;
  get(scope: TenantScope, anchorId: string): Promise<KnowledgeAnchorRecord | null>;
  getByChunk(scope: TenantScope, chunkId: string): Promise<KnowledgeAnchorRecord | null>;
  /**
   * GC worker 内部使用：物理删除空间下所有 citation anchor。
   * 返回受影响行数。空间级 GC 在 FK 倒序中先调用 chunk/anchor 等子表。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
}

export class InMemoryKnowledgeAnchorStore implements KnowledgeAnchorStore {
  private readonly byAnchor = new Map<string, KnowledgeAnchorRecord>();

  async upsert(record: KnowledgeAnchorRecord): Promise<KnowledgeAnchorRecord> {
    const safeScope = requireTenantScope(record);
    const stored: KnowledgeAnchorRecord = {
      ...record,
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
    };
    this.byAnchor.set(this.key(stored.sourceSystemId, stored.tenantId, stored.anchorId), stored);
    return { ...stored };
  }

  async get(scope: TenantScope, anchorId: string): Promise<KnowledgeAnchorRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = this.byAnchor.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, anchorId));
    // Strict scope guard: if the anchor exists but the scope does not match,
    // do not even look at the record. Return null and let the caller report
    // NOT_FOUND so anchor ids cannot be enumerated cross-tenant.
    return record ? { ...record } : null;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, record] of this.byAnchor) {
      if (
        record.sourceSystemId === safeScope.sourceSystemId
        && record.tenantId === safeScope.tenantId
        && record.spaceId === spaceId
      ) {
        this.byAnchor.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async getByChunk(scope: TenantScope, chunkId: string): Promise<KnowledgeAnchorRecord | null> {
    const safeScope = requireTenantScope(scope);
    for (const record of this.byAnchor.values()) {
      if (record.sourceSystemId !== safeScope.sourceSystemId || record.tenantId !== safeScope.tenantId) continue;
      if (record.chunkId === chunkId) {
        return { ...record };
      }
    }
    return null;
  }

  snapshot(): KnowledgeAnchorRecord[] {
    return [...this.byAnchor.values()].map((record) => ({ ...record }));
  }

  private key(sourceSystemId: string, tenantId: string, anchorId: string): string {
    return `${sourceSystemId}:${tenantId}:${anchorId}`;
  }
}
