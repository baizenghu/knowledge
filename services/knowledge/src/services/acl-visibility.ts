import type { KnowledgeContext } from "@octopus/knowledge-contracts";
import type { KnowledgeAclStore, KnowledgeAclPrincipalRecord } from "../repositories/acl-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";

export class KnowledgeAclVisibilityService {
  constructor(private readonly deps: {
    acl: KnowledgeAclStore;
    documents: KnowledgeDocumentStore;
  }) {}

  async canReadDocument(scope: TenantScope, documentId: string, context: Pick<KnowledgeContext, "tenantId" | "userId" | "departments" | "roles">, now = new Date()): Promise<boolean> {
    const document = await this.deps.documents.get(scope, documentId);
    if (!document || document.status === "deleted" || document.visibilityStatus === "deleted" || document.deletedAt) {
      return false;
    }
    const principals = await this.deps.acl.listDocumentPrincipals(scope, documentId, document.aclVersion);
    return principals.some((principal) => principal.permission === "read" && principalMatches(principal, context, now));
  }
}

export function principalMatches(
  principal: KnowledgeAclPrincipalRecord,
  context: Pick<KnowledgeContext, "tenantId" | "userId" | "departments" | "roles">,
  now = new Date(),
): boolean {
  if (principal.effectiveFrom && principal.effectiveFrom.getTime() > now.getTime()) {
    return false;
  }
  if (principal.effectiveTo && principal.effectiveTo.getTime() <= now.getTime()) {
    return false;
  }
  if (principal.principalType === "tenant") {
    return principal.principalId === context.tenantId;
  }
  if (principal.principalType === "user") {
    return principal.principalId === context.userId;
  }
  if (principal.principalType === "department") {
    return context.departments.includes(principal.principalId);
  }
  if (principal.principalType === "role") {
    return context.roles.includes(principal.principalId);
  }
  return false;
}
