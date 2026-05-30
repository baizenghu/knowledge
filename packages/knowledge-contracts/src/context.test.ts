import { describe, expect, it } from "vitest";
import { contextToHeaders, normalizeContextList, requireKnowledgeContext } from "./context.js";

describe("knowledge context", () => {
  it("normalizes roles and departments deterministically", () => {
    expect(normalizeContextList("dept-b, dept-a,,dept-a")).toEqual(["dept-a", "dept-a", "dept-b"]);
  });

  it("requires tenant and user", () => {
    expect(() => requireKnowledgeContext({ tenantId: "tenant-1" })).toThrow(/user_id/);
    expect(() => requireKnowledgeContext({ userId: "user-1" })).toThrow(/tenant_id/);
  });

  it("serializes context headers for signing", () => {
    const headers = contextToHeaders(requireKnowledgeContext({
      tenantId: "tenant-1",
      userId: "user-1",
      roles: ["reader"],
      departments: ["dept-a"],
      contextDegraded: true,
    }));

    expect(headers["x-octopus-source-system"]).toBe("octopus");
    expect(headers["x-octopus-context-degraded"]).toBe("true");
    expect(headers["x-octopus-roles"]).toBe("reader");
  });
});
