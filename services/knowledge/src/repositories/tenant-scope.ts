export type TenantScope = {
  sourceSystemId: string;
  tenantId: string;
};

// Best-effort guard for repository code. Repository implementations must still avoid raw SQL
// and unscoped OR branches unless explicitly reviewed, because those can bypass top-level scope checks.
export type TenantScopedWhere = TenantScope & Record<string, unknown>;

export function requireTenantScope(scope: Partial<TenantScope>): TenantScope {
  const sourceSystemId = scope.sourceSystemId?.trim();
  const tenantId = scope.tenantId?.trim();
  if (!sourceSystemId) {
    throw new Error("sourceSystemId is required");
  }
  if (!tenantId) {
    throw new Error("tenantId is required");
  }
  return { sourceSystemId, tenantId };
}

export function withTenantScope<TWhere extends Record<string, unknown>>(
  scope: Partial<TenantScope>,
  where: TWhere,
): TWhere & TenantScope {
  return {
    ...where,
    ...requireTenantScope(scope),
  };
}

export function assertTenantScopedWhere(where: Record<string, unknown>): asserts where is TenantScopedWhere {
  if (typeof where["sourceSystemId"] !== "string" || !where["sourceSystemId"]) {
    throw new Error("tenant-scoped query missing sourceSystemId");
  }
  if (typeof where["tenantId"] !== "string" || !where["tenantId"]) {
    throw new Error("tenant-scoped query missing tenantId");
  }
}
