import type { DocumentStatus } from "@octopus/knowledge-contracts";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

export type DocumentVisibilityStatus = "hidden" | "visible" | "deleted";

export type KnowledgeDocumentRecord = TenantScope & {
  documentId: string;
  spaceId: string;
  title: string;
  documentType?: string | null;
  status: DocumentStatus;
  visibilityStatus: DocumentVisibilityStatus;
  currentVersionId?: string | null;
  currentVersionNumber?: number | null;
  aclHash: string;
  aclVersion: number;
  sourceSha256?: string | null;
  sourceFilename?: string | null;
  createdBy: string;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface KnowledgeDocumentStore {
  create(document: KnowledgeDocumentRecord, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord>;
  get(scope: TenantScope, documentId: string, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null>;
  findBySourceSha256(scope: TenantScope, spaceId: string, sourceSha256: string, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null>;
  updateStatus(scope: TenantScope, documentId: string, status: DocumentStatus, visibilityStatus?: DocumentVisibilityStatus, now?: Date, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null>;
  updateAcl(scope: TenantScope, documentId: string, aclHash: string, aclVersion: number, now?: Date, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null>;
  updateCurrentVersion(scope: TenantScope, documentId: string, versionId: string, versionNumber: number, now?: Date, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null>;
  softDelete(scope: TenantScope, documentId: string, now?: Date, tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null>;
  /**
   * 批量软删某 space 下所有非 deleted 状态的文档。
   * SpaceDeletionService 在同事务中调用，返回受影响行数。
   */
  softDeleteBySpace(scope: TenantScope, spaceId: string, now?: Date, tx?: KnowledgeTxClient): Promise<number>;
  /**
   * 撤回某 space 下所有「曾被 softDeleteBySpace 标 deleted」的文档(空间 restore 流程)。
   * 把 status 改回 'ready'(或 created 时初始的 visibility),清 deletedAt。
   * Best-effort:无法精确还原原始 status,统一恢复为 'ready' + visibility='visible'。
   * 返回恢复行数。
   */
  restoreBySpace(scope: TenantScope, spaceId: string, now?: Date, tx?: KnowledgeTxClient): Promise<number>;
  /**
   * GC worker 内部使用：物理删除空间下所有 document 行（含已软删）。
   * 与 softDeleteBySpace 不同：不检查 status，直接 deleteMany。
   * 公开 API 已禁止硬删，只能通过 GC 走 retention 流程触发。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
  isVisible(scope: TenantScope, documentId: string, tx?: KnowledgeTxClient): Promise<boolean>;
  listBySpace(
    scope: TenantScope,
    spaceId: string,
    input?: { limit?: number; cursor?: string | null; includeDeleted?: boolean },
    tx?: KnowledgeTxClient,
  ): Promise<{ items: KnowledgeDocumentRecord[]; nextCursor: string | null }>;
}

export class InMemoryKnowledgeDocumentStore implements KnowledgeDocumentStore {
  private readonly documents = new Map<string, KnowledgeDocumentRecord>();

  constructor(seedDocuments: KnowledgeDocumentRecord[] = []) {
    for (const document of seedDocuments) {
      this.documents.set(this.key(document.sourceSystemId, document.tenantId, document.documentId), { ...document });
    }
  }

  async create(document: KnowledgeDocumentRecord, _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord> {
    requireTenantScope(document);
    const key = this.key(document.sourceSystemId, document.tenantId, document.documentId);
    if (this.documents.has(key)) {
      throw new Error(`document already exists: ${document.documentId}`);
    }
    this.documents.set(key, { ...document });
    return { ...document };
  }

  async get(scope: TenantScope, documentId: string, _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const document = this.documents.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, documentId));
    return document ? { ...document } : null;
  }

  async findBySourceSha256(scope: TenantScope, spaceId: string, sourceSha256: string, _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const document = [...this.documents.values()].find((item) =>
      item.sourceSystemId === safeScope.sourceSystemId
      && item.tenantId === safeScope.tenantId
      && item.spaceId === spaceId
      && item.sourceSha256?.toLowerCase() === sourceSha256.toLowerCase()
      && item.status !== "deleted"
      && !item.deletedAt,
    );
    return document ? { ...document } : null;
  }

  async updateAcl(scope: TenantScope, documentId: string, aclHash: string, aclVersion: number, now = new Date(), _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const document = this.documents.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, documentId));
    if (!document || document.status === "deleted") {
      return null;
    }
    document.aclHash = aclHash;
    document.aclVersion = aclVersion;
    document.updatedAt = now;
    return { ...document };
  }

  async updateStatus(scope: TenantScope, documentId: string, status: DocumentStatus, visibilityStatus?: DocumentVisibilityStatus, now = new Date(), _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const document = this.documents.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, documentId));
    if (!document || document.status === "deleted") {
      return null;
    }
    document.status = status;
    if (visibilityStatus) {
      document.visibilityStatus = visibilityStatus;
    }
    document.updatedAt = now;
    return { ...document };
  }

  async updateCurrentVersion(scope: TenantScope, documentId: string, versionId: string, versionNumber: number, now = new Date(), _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const document = this.documents.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, documentId));
    if (!document || document.status === "deleted") {
      return null;
    }
    document.currentVersionId = versionId;
    document.currentVersionNumber = versionNumber;
    document.updatedAt = now;
    return { ...document };
  }

  async softDelete(scope: TenantScope, documentId: string, now = new Date(), _tx?: KnowledgeTxClient): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const document = this.documents.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, documentId));
    if (!document) {
      return null;
    }
    document.status = "deleted";
    document.visibilityStatus = "deleted";
    document.deletedAt = now;
    document.updatedAt = now;
    return { ...document };
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, document] of this.documents) {
      if (
        document.sourceSystemId === safeScope.sourceSystemId
        && document.tenantId === safeScope.tenantId
        && document.spaceId === spaceId
      ) {
        this.documents.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async softDeleteBySpace(scope: TenantScope, spaceId: string, now: Date = new Date(), _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let affected = 0;
    for (const document of this.documents.values()) {
      if (
        document.sourceSystemId === safeScope.sourceSystemId
        && document.tenantId === safeScope.tenantId
        && document.spaceId === spaceId
        && document.status !== "deleted"
      ) {
        document.status = "deleted";
        document.visibilityStatus = "deleted";
        document.deletedAt = now;
        document.updatedAt = now;
        affected += 1;
      }
    }
    return affected;
  }

  async restoreBySpace(scope: TenantScope, spaceId: string, now: Date = new Date(), _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let affected = 0;
    for (const document of this.documents.values()) {
      if (
        document.sourceSystemId === safeScope.sourceSystemId
        && document.tenantId === safeScope.tenantId
        && document.spaceId === spaceId
        && document.status === "deleted"
      ) {
        // Best-effort:恢复为 searchable/visible。空间软删时没有保留原始文档状态快照。
        document.status = "searchable";
        document.visibilityStatus = "visible";
        document.deletedAt = null;
        document.updatedAt = now;
        affected += 1;
      }
    }
    return affected;
  }

  async isVisible(scope: TenantScope, documentId: string, _tx?: KnowledgeTxClient): Promise<boolean> {
    const document = await this.get(scope, documentId);
    return Boolean(document && document.visibilityStatus === "visible" && document.status !== "deleted" && !document.deletedAt);
  }

  async listBySpace(
    scope: TenantScope,
    spaceId: string,
    input: { limit?: number; cursor?: string | null; includeDeleted?: boolean } = {},
    _tx?: KnowledgeTxClient,
  ): Promise<{ items: KnowledgeDocumentRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = clampLimit(input.limit);
    const includeDeleted = input.includeDeleted === true;
    const filtered = [...this.documents.values()]
      .filter((doc) =>
        doc.sourceSystemId === safeScope.sourceSystemId
        && doc.tenantId === safeScope.tenantId
        && doc.spaceId === spaceId
        && (includeDeleted || (doc.status !== "deleted" && !doc.deletedAt)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.documentId.localeCompare(b.documentId));
    const startIndex = input.cursor ? Math.max(0, filtered.findIndex((d) => d.documentId === input.cursor) + 1) : 0;
    const page = filtered.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < filtered.length ? page[page.length - 1]?.documentId ?? null : null;
    return { items: page.map((doc) => ({ ...doc })), nextCursor };
  }

  snapshot(): KnowledgeDocumentRecord[] {
    return [...this.documents.values()].map((document) => ({ ...document }));
  }

  private key(sourceSystemId: string, tenantId: string, documentId: string): string {
    return `${sourceSystemId}:${tenantId}:${documentId}`;
  }
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 50;
  return Math.min(200, Math.floor(value));
}
