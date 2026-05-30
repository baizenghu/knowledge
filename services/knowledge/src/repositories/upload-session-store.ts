import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

export type KnowledgeUploadSessionRecord = TenantScope & {
  uploadId: string;
  spaceId: string;
  assetId: string;
  objectUri: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  claimedSha256?: string | null;
  actualSha256?: string | null;
  status: "issued" | "consumed" | "expired";
  issuedBy: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface KnowledgeUploadSessionStore {
  create(session: KnowledgeUploadSessionRecord): Promise<KnowledgeUploadSessionRecord>;
  get(scope: TenantScope, uploadId: string): Promise<KnowledgeUploadSessionRecord | null>;
  getByObjectUri(scope: TenantScope, objectUri: string): Promise<KnowledgeUploadSessionRecord | null>;
  consume(scope: TenantScope, uploadId: string, actualSha256: string, now?: Date): Promise<KnowledgeUploadSessionRecord | null>;
  /**
   * GC worker 内部使用：物理删除空间下所有 upload_session 行（含已 consumed/expired）。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
}

export class InMemoryKnowledgeUploadSessionStore implements KnowledgeUploadSessionStore {
  private readonly sessions = new Map<string, KnowledgeUploadSessionRecord>();

  async create(session: KnowledgeUploadSessionRecord): Promise<KnowledgeUploadSessionRecord> {
    requireTenantScope(session);
    const key = this.key(session.sourceSystemId, session.tenantId, session.uploadId);
    if (this.sessions.has(key)) {
      throw new Error(`upload session already exists: ${session.uploadId}`);
    }
    this.sessions.set(key, { ...session });
    return { ...session };
  }

  async get(scope: TenantScope, uploadId: string): Promise<KnowledgeUploadSessionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const session = this.sessions.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, uploadId));
    return session ? { ...session } : null;
  }

  async getByObjectUri(scope: TenantScope, objectUri: string): Promise<KnowledgeUploadSessionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const session = [...this.sessions.values()].find((item) =>
      item.sourceSystemId === safeScope.sourceSystemId
      && item.tenantId === safeScope.tenantId
      && item.objectUri === objectUri,
    );
    return session ? { ...session } : null;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, session] of this.sessions) {
      if (
        session.sourceSystemId === safeScope.sourceSystemId
        && session.tenantId === safeScope.tenantId
        && session.spaceId === spaceId
      ) {
        this.sessions.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async consume(scope: TenantScope, uploadId: string, actualSha256: string, now = new Date()): Promise<KnowledgeUploadSessionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const session = this.sessions.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, uploadId));
    if (!session || session.status !== "issued" || session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    session.actualSha256 = actualSha256;
    session.status = "consumed";
    session.consumedAt = now;
    session.updatedAt = now;
    return { ...session };
  }

  snapshot(): KnowledgeUploadSessionRecord[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  private key(sourceSystemId: string, tenantId: string, uploadId: string): string {
    return `${sourceSystemId}:${tenantId}:${uploadId}`;
  }
}
