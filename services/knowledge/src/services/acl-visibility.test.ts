import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { KnowledgeAclVisibilityService, principalMatches } from "./acl-visibility.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("KnowledgeAclVisibilityService", () => {
  it("matches tenant, user, department, and role principals", () => {
    const context = { tenantId: "tenant-1", userId: "user-1", departments: ["dept-1"], roles: ["reader"] };

    expect(principalMatches(principal("tenant", "tenant-1"), context)).toBe(true);
    expect(principalMatches(principal("user", "user-1"), context)).toBe(true);
    expect(principalMatches(principal("department", "dept-1"), context)).toBe(true);
    expect(principalMatches(principal("role", "reader"), context)).toBe(true);
    expect(principalMatches(principal("role", "admin"), context)).toBe(false);
  });

  it("checks read access against document ACL version", async () => {
    const documents = new InMemoryKnowledgeDocumentStore([{
      ...scope,
      documentId: "doc_1",
      spaceId: "space_1",
      title: "Report",
      status: "queued",
      visibilityStatus: "hidden",
      currentVersionId: "ver_1",
      currentVersionNumber: 1,
      aclHash: "acl_1",
      aclVersion: 1,
      sourceSha256: "a".repeat(64),
      createdBy: "user-1",
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    }]);
    const acl = new InMemoryKnowledgeAclStore();
    const snapshot = await acl.upsertSnapshot(scope, { read: [{ type: "department", id: "dept-ops" }] });
    await acl.replaceDocumentPrincipals({
      scope,
      documentId: "doc_1",
      aclHash: snapshot.aclHash,
      aclVersion: 1,
      canonicalAcl: snapshot.canonicalJson,
    });
    const visibility = new KnowledgeAclVisibilityService({ acl, documents });

    expect(await visibility.canReadDocument(scope, "doc_1", {
      tenantId: "tenant-1",
      userId: "user-1",
      departments: ["dept-ops"],
      roles: [],
    })).toBe(true);
    expect(await visibility.canReadDocument(scope, "doc_1", {
      tenantId: "tenant-1",
      userId: "user-2",
      departments: [],
      roles: [],
    })).toBe(false);
  });
});

function principal(type: string, id: string) {
  return {
    ...scope,
    documentId: "doc_1",
    aclHash: "acl_1",
    aclVersion: 1,
    permission: "read" as const,
    principalType: type,
    principalId: id,
    createdAt: new Date(),
  };
}
