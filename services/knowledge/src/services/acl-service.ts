import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { CanonicalAcl, KnowledgeAclStore } from "../repositories/acl-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { ServiceResult } from "./document-service.js";

export class KnowledgeAclService {
  constructor(private readonly deps: {
    acl: KnowledgeAclStore;
    documents: KnowledgeDocumentStore;
    audit: KnowledgeAuditEventWriter;
  }) {}

  async deriveDocumentAcl(scope: TenantScope, input: {
    documentId: string;
    acl: unknown;
    aclVersion?: number;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    now?: Date;
  }): Promise<{ aclHash: string; aclVersion: number; canonicalAcl: CanonicalAcl }> {
    const now = input.now ?? new Date();
    const snapshot = await this.deps.acl.upsertSnapshot(scope, input.acl, input.effectiveFrom ?? null, input.effectiveTo ?? null, now);
    const aclVersion = input.aclVersion ?? 1;
    await this.deps.acl.replaceDocumentPrincipals({
      scope,
      documentId: input.documentId,
      aclHash: snapshot.aclHash,
      aclVersion,
      canonicalAcl: snapshot.canonicalJson,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      now,
    });
    return { aclHash: snapshot.aclHash, aclVersion, canonicalAcl: snapshot.canonicalJson };
  }

  async updateDocumentAcl(scope: TenantScope, input: {
    documentId: string;
    acl: unknown;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    userId: string;
  }, now = new Date()): Promise<ServiceResult<{ document_id: string; acl_hash: string; acl_version: number; visibility_refresh_deadline: string }>> {
    const document = await this.deps.documents.get(scope, input.documentId);
    if (!document || document.status === "deleted") {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    const aclVersion = document.aclVersion + 1;
    const derived = await this.deriveDocumentAcl(scope, {
      documentId: input.documentId,
      acl: input.acl,
      aclVersion,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      now,
    });
    await this.deps.documents.updateAcl(scope, input.documentId, derived.aclHash, aclVersion, now);
    await this.deps.audit.write({
      ...scope,
      userId: input.userId,
      action: "acl.update",
      resourceType: "document",
      resourceId: input.documentId,
      details: { acl_hash: derived.aclHash, acl_version: aclVersion },
      createdAt: now,
    });
    return {
      ok: true,
      data: {
        document_id: input.documentId,
        acl_hash: derived.aclHash,
        acl_version: aclVersion,
        visibility_refresh_deadline: new Date(now.getTime() + 30_000).toISOString(),
      },
    };
  }
}
