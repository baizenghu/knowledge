import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

export type KnowledgeAssetRecord = TenantScope & {
  assetId: string;
  documentId: string | null;
  versionId: string | null;
  type: string;
  uri: string;
  sha256: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  pageNo?: number | null;
  bbox?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  deletedAt?: Date | null;
};

export interface KnowledgeAssetStore {
  upsert(asset: KnowledgeAssetRecord): Promise<KnowledgeAssetRecord>;
  listForVersion(scope: TenantScope, versionId: string): Promise<KnowledgeAssetRecord[]>;
  /**
   * GC worker 内部使用：物理删除空间下所有 asset 行。
   * KnowledgeAsset 表没有 spaceId 字段，按 documentId IN (space 下所有文档) 过滤。
   * 返回受影响行数。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
}

export class InMemoryKnowledgeAssetStore implements KnowledgeAssetStore {
  private readonly assets = new Map<string, KnowledgeAssetRecord>();
  /**
   * doc→space 映射。InMemory asset 表没有 spaceId 字段（Prisma schema 也没有），
   * GC worker 单测可通过 setDocumentSpace() 注入映射，让 hardDeleteBySpace 删干净。
   */
  private readonly documentSpace = new Map<string, string>();

  /** 测试辅助：把 documentId 注册到 spaceId，供 hardDeleteBySpace 使用。 */
  setDocumentSpace(documentId: string, spaceId: string): void {
    this.documentSpace.set(documentId, spaceId);
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, asset] of this.assets) {
      if (asset.sourceSystemId !== safeScope.sourceSystemId || asset.tenantId !== safeScope.tenantId) continue;
      const docSpace = asset.documentId ? this.documentSpace.get(asset.documentId) : null;
      if (docSpace !== spaceId) continue;
      this.assets.delete(key);
      count += 1;
    }
    return count;
  }

  async upsert(asset: KnowledgeAssetRecord): Promise<KnowledgeAssetRecord> {
    const safeScope = requireTenantScope(asset);
    // 去重键 = 版本内内容标识 (versionId, sha256, type)，与 Prisma 实现保持一致；
    // 命中已存行时复用其 assetId/createdAt，让重试幂等。
    const existing = [...this.assets.values()].find((a) =>
      a.sourceSystemId === safeScope.sourceSystemId
      && a.tenantId === safeScope.tenantId
      && a.versionId === asset.versionId
      && a.sha256 === asset.sha256
      && a.type === asset.type,
    );
    const assetId = existing?.assetId ?? asset.assetId;
    const stored: KnowledgeAssetRecord = {
      ...asset,
      ...safeScope,
      assetId,
      createdAt: existing?.createdAt ?? asset.createdAt,
    };
    this.assets.set(this.key(safeScope.sourceSystemId, safeScope.tenantId, assetId), stored);
    return { ...stored };
  }

  async listForVersion(scope: TenantScope, versionId: string): Promise<KnowledgeAssetRecord[]> {
    const safeScope = requireTenantScope(scope);
    return [...this.assets.values()]
      .filter((asset) =>
        asset.sourceSystemId === safeScope.sourceSystemId
        && asset.tenantId === safeScope.tenantId
        && asset.versionId === versionId
        && !asset.deletedAt,
      )
      .map((asset) => ({ ...asset }));
  }

  snapshot(): KnowledgeAssetRecord[] {
    return [...this.assets.values()].map((asset) => ({ ...asset }));
  }

  private key(sourceSystemId: string, tenantId: string, assetId: string): string {
    return `${sourceSystemId}:${tenantId}:${assetId}`;
  }
}
