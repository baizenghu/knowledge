import type { DocumentStatus } from "@octopus/knowledge-contracts";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

export type KnowledgeDocumentVersionRecord = TenantScope & {
  versionId: string;
  documentId: string;
  versionNumber: number;
  status: DocumentStatus;
  contentSha256: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface KnowledgeDocumentVersionStore {
  create(version: KnowledgeDocumentVersionRecord): Promise<KnowledgeDocumentVersionRecord>;
  get(scope: TenantScope, versionId: string): Promise<KnowledgeDocumentVersionRecord | null>;
  updateStatus(scope: TenantScope, versionId: string, status: DocumentStatus, now?: Date): Promise<KnowledgeDocumentVersionRecord | null>;
  /**
   * GC worker 内部使用：物理删除空间下所有 version 行。
   * KnowledgeDocumentVersion 表没有 spaceId 字段，按 documentId IN (space 下所有文档) 过滤。
   * Prisma 实现内部先 findMany 取 documentId 再 deleteMany。
   * InMemory 实现通过 setDocumentSpace 注入 doc→space 映射。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
}

export class InMemoryKnowledgeDocumentVersionStore implements KnowledgeDocumentVersionStore {
  private readonly versions = new Map<string, KnowledgeDocumentVersionRecord>();
  /** 测试辅助：doc→space 映射，让 hardDeleteBySpace 找到行。 */
  private readonly documentSpace = new Map<string, string>();

  setDocumentSpace(documentId: string, spaceId: string): void {
    this.documentSpace.set(documentId, spaceId);
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, version] of this.versions) {
      if (version.sourceSystemId !== safeScope.sourceSystemId || version.tenantId !== safeScope.tenantId) continue;
      if (this.documentSpace.get(version.documentId) !== spaceId) continue;
      this.versions.delete(key);
      count += 1;
    }
    return count;
  }

  async create(version: KnowledgeDocumentVersionRecord): Promise<KnowledgeDocumentVersionRecord> {
    requireTenantScope(version);
    const key = this.key(version.sourceSystemId, version.tenantId, version.versionId);
    if (this.versions.has(key)) {
      throw new Error(`document version already exists: ${version.versionId}`);
    }
    this.versions.set(key, { ...version });
    return { ...version };
  }

  async get(scope: TenantScope, versionId: string): Promise<KnowledgeDocumentVersionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const version = this.versions.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, versionId));
    return version ? { ...version } : null;
  }

  async updateStatus(scope: TenantScope, versionId: string, status: DocumentStatus, now = new Date()): Promise<KnowledgeDocumentVersionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const version = this.versions.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, versionId));
    if (!version) {
      return null;
    }
    version.status = status;
    version.updatedAt = now;
    return { ...version };
  }

  snapshot(): KnowledgeDocumentVersionRecord[] {
    return [...this.versions.values()].map((version) => ({ ...version }));
  }

  private key(sourceSystemId: string, tenantId: string, versionId: string): string {
    return `${sourceSystemId}:${tenantId}:${versionId}`;
  }
}
