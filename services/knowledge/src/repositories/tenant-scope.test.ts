import { describe, expect, it } from "vitest";
import { assertTenantScopedWhere, requireTenantScope, withTenantScope } from "./tenant-scope.js";

describe("tenant scope helpers", () => {
  it("requires both sourceSystemId and tenantId", () => {
    expect(() => requireTenantScope({ tenantId: "tenant-1" })).toThrow(/sourceSystemId/);
    expect(() => requireTenantScope({ sourceSystemId: "octopus" })).toThrow(/tenantId/);
  });

  it("injects sourceSystemId and tenantId into where clauses", () => {
    expect(withTenantScope({ sourceSystemId: "octopus", tenantId: "tenant-1" }, { documentId: "doc_1" }))
      .toEqual({ sourceSystemId: "octopus", tenantId: "tenant-1", documentId: "doc_1" });
  });

  it("asserts tenant-scoped queries", () => {
    expect(() => assertTenantScopedWhere({ sourceSystemId: "octopus" })).toThrow(/tenantId/);
    expect(() => assertTenantScopedWhere({ sourceSystemId: "octopus", tenantId: "tenant-1" })).not.toThrow();
  });
});
