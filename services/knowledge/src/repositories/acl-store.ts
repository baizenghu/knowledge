import { createHash } from "node:crypto";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

export type AclPermission = "read" | "write" | "admin";
export type AclPrincipalInput = {
  type: "tenant" | "department" | "user" | "role";
  id: string;
};

export type CanonicalAcl = {
  source_system_id: string;
  tenant_id: string;
  read: AclPrincipalInput[];
  write: AclPrincipalInput[];
  admin: AclPrincipalInput[];
  effective_from: string | null;
  effective_to: string | null;
};

export type KnowledgeAclSnapshotRecord = TenantScope & {
  aclHash: string;
  canonicalJson: CanonicalAcl;
  sha256: string;
  createdAt: Date;
};

export type KnowledgeAclPrincipalRecord = TenantScope & {
  documentId: string;
  aclHash: string;
  aclVersion: number;
  permission: AclPermission;
  principalType: string;
  principalId: string;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  createdAt: Date;
};

export type AclListContext = {
  tenantId: string;
  userId: string;
  departments: string[];
  roles: string[];
};

export interface KnowledgeAclStore {
  upsertSnapshot(scope: TenantScope, acl: unknown, effectiveFrom?: Date | null, effectiveTo?: Date | null, now?: Date): Promise<KnowledgeAclSnapshotRecord>;
  replaceDocumentPrincipals(input: {
    scope: TenantScope;
    documentId: string;
    aclHash: string;
    aclVersion: number;
    canonicalAcl: CanonicalAcl;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    now?: Date;
  }): Promise<KnowledgeAclPrincipalRecord[]>;
  listDocumentPrincipals(scope: TenantScope, documentId: string, aclVersion?: number): Promise<KnowledgeAclPrincipalRecord[]>;
  /**
   * Returns the set of `acl_hash` values that, at `now`, grant the requesting
   * context (`tenantId/userId/departments/roles`) READ permission on at least
   * one document. Used by retrieval to build the qdrant/fulltext filter so
   * that we never even score chunks the user cannot see. Implementations MUST
   * respect `effectiveFrom`/`effectiveTo` windows.
   */
  listAclHashesForContext(scope: TenantScope, context: AclListContext, now?: Date): Promise<Set<string>>;
  /**
   * GC worker 内部使用：物理删除空间下所有 acl_principal 行。
   * acl_principal 表没有 spaceId 字段，按 space 下所有 documentId 过滤
   * （包含已软删）。Prisma 实现内部先 findMany 取 documentId 再 deleteMany。
   * InMemory 实现通过 setDocumentSpace 注入 doc→space 映射。
   * 注意：acl_snapshots 是租户级共享，**不要删**。
   * 返回受影响行数。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
}

export class InMemoryKnowledgeAclStore implements KnowledgeAclStore {
  private readonly snapshots = new Map<string, KnowledgeAclSnapshotRecord>();
  private readonly principals = new Map<string, KnowledgeAclPrincipalRecord>();
  /**
   * 测试辅助：InMemory acl-principal 没有 spaceId 字段，需要 doc→space 映射
   * 才能让 hardDeleteBySpace 找到正确行。GC worker 单测在 seed 数据时调用 setDocumentSpace。
   */
  private readonly documentSpace = new Map<string, string>();

  setDocumentSpace(documentId: string, spaceId: string): void {
    this.documentSpace.set(documentId, spaceId);
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, principal] of this.principals) {
      if (principal.sourceSystemId !== safeScope.sourceSystemId || principal.tenantId !== safeScope.tenantId) continue;
      if (this.documentSpace.get(principal.documentId) !== spaceId) continue;
      this.principals.delete(key);
      count += 1;
    }
    return count;
  }

  async upsertSnapshot(scope: TenantScope, acl: unknown, effectiveFrom: Date | null = null, effectiveTo: Date | null = null, now = new Date()): Promise<KnowledgeAclSnapshotRecord> {
    const safeScope = requireTenantScope(scope);
    const canonicalAcl = canonicalizeAcl(safeScope, acl, effectiveFrom, effectiveTo);
    const canonicalJson = stableJsonStringify(canonicalAcl);
    const sha256 = createHash("sha256").update(canonicalJson).digest("hex");
    const aclHash = createAclHash(safeScope, canonicalJson);
    const key = this.snapshotKey(safeScope.sourceSystemId, safeScope.tenantId, aclHash);
    const existing = this.snapshots.get(key);
    if (existing) {
      return { ...existing, canonicalJson: cloneAcl(existing.canonicalJson) };
    }
    const snapshot: KnowledgeAclSnapshotRecord = {
      ...safeScope,
      aclHash,
      canonicalJson: canonicalAcl,
      sha256,
      createdAt: now,
    };
    this.snapshots.set(key, snapshot);
    return { ...snapshot, canonicalJson: cloneAcl(snapshot.canonicalJson) };
  }

  async replaceDocumentPrincipals(input: {
    scope: TenantScope;
    documentId: string;
    aclHash: string;
    aclVersion: number;
    canonicalAcl: CanonicalAcl;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    now?: Date;
  }): Promise<KnowledgeAclPrincipalRecord[]> {
    const safeScope = requireTenantScope(input.scope);
    for (const [key, principal] of this.principals) {
      if (
        principal.sourceSystemId === safeScope.sourceSystemId
        && principal.tenantId === safeScope.tenantId
        && principal.documentId === input.documentId
      ) {
        this.principals.delete(key);
      }
    }
    const created: KnowledgeAclPrincipalRecord[] = [];
    for (const permission of ["read", "write", "admin"] as const) {
      for (const principal of input.canonicalAcl[permission]) {
        const record: KnowledgeAclPrincipalRecord = {
          ...safeScope,
          documentId: input.documentId,
          aclHash: input.aclHash,
          aclVersion: input.aclVersion,
          permission,
          principalType: principal.type,
          principalId: principal.id,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveTo: input.effectiveTo ?? null,
          createdAt: input.now ?? new Date(),
        };
        this.principals.set(this.principalKey(record), record);
        created.push({ ...record });
      }
    }
    return created;
  }

  async listDocumentPrincipals(scope: TenantScope, documentId: string, aclVersion?: number): Promise<KnowledgeAclPrincipalRecord[]> {
    const safeScope = requireTenantScope(scope);
    return [...this.principals.values()]
      .filter((principal) => principal.sourceSystemId === safeScope.sourceSystemId && principal.tenantId === safeScope.tenantId)
      .filter((principal) => principal.documentId === documentId)
      .filter((principal) => aclVersion === undefined || principal.aclVersion === aclVersion)
      .map((principal) => ({ ...principal }));
  }

  async listAclHashesForContext(scope: TenantScope, context: AclListContext, now: Date = new Date()): Promise<Set<string>> {
    const safeScope = requireTenantScope(scope);
    const hashes = new Set<string>();
    for (const principal of this.principals.values()) {
      if (principal.sourceSystemId !== safeScope.sourceSystemId || principal.tenantId !== safeScope.tenantId) continue;
      if (principal.permission !== "read") continue;
      if (hashes.has(principal.aclHash)) continue;
      if (principal.effectiveFrom && principal.effectiveFrom.getTime() > now.getTime()) continue;
      if (principal.effectiveTo && principal.effectiveTo.getTime() <= now.getTime()) continue;
      const matches = (() => {
        if (principal.principalType === "tenant") return principal.principalId === context.tenantId;
        if (principal.principalType === "user") return principal.principalId === context.userId;
        if (principal.principalType === "department") return context.departments.includes(principal.principalId);
        if (principal.principalType === "role") return context.roles.includes(principal.principalId);
        return false;
      })();
      if (matches) {
        hashes.add(principal.aclHash);
      }
    }
    return hashes;
  }

  snapshot(): { snapshots: KnowledgeAclSnapshotRecord[]; principals: KnowledgeAclPrincipalRecord[] } {
    return {
      snapshots: [...this.snapshots.values()].map((snapshot) => ({ ...snapshot, canonicalJson: cloneAcl(snapshot.canonicalJson) })),
      principals: [...this.principals.values()].map((principal) => ({ ...principal })),
    };
  }

  private snapshotKey(sourceSystemId: string, tenantId: string, aclHash: string): string {
    return `${sourceSystemId}:${tenantId}:${aclHash}`;
  }

  private principalKey(record: KnowledgeAclPrincipalRecord): string {
    return `${record.sourceSystemId}:${record.tenantId}:${record.documentId}:${record.aclVersion}:${record.permission}:${record.principalType}:${record.principalId}`;
  }
}

export function canonicalizeAcl(scope: TenantScope, acl: unknown, effectiveFrom: Date | null = null, effectiveTo: Date | null = null): CanonicalAcl {
  const safeScope = requireTenantScope(scope);
  const input = isRecord(acl) ? acl : {};
  return {
    source_system_id: safeScope.sourceSystemId,
    tenant_id: safeScope.tenantId,
    read: normalizePrincipals(input.read),
    write: normalizePrincipals(input.write),
    admin: normalizePrincipals(input.admin),
    effective_from: effectiveFrom?.toISOString() ?? null,
    effective_to: effectiveTo?.toISOString() ?? null,
  };
}

export function createAclHash(scope: TenantScope, canonicalAclJson: string): string {
  const safeScope = requireTenantScope(scope);
  const digest = createHash("sha256")
    .update(`${safeScope.sourceSystemId}|${safeScope.tenantId}|${canonicalAclJson}`)
    .digest("base64url")
    .slice(0, 32);
  return `acl_${digest}`;
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePrincipals(value: unknown): AclPrincipalInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .filter(isRecord)
    .map((item) => ({ type: String(item.type || ""), id: String(item.id || "") }))
    .filter((item): item is AclPrincipalInput => ["tenant", "department", "user", "role"].includes(item.type) && Boolean(item.id));
  return [...new Map(normalized.map((item) => [`${item.type}:${item.id}`, item])).values()]
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneAcl(acl: CanonicalAcl): CanonicalAcl {
  return JSON.parse(JSON.stringify(acl)) as CanonicalAcl;
}
