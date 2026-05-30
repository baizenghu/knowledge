import { describe, expect, it } from "vitest";
import { canonicalizeAcl, InMemoryKnowledgeAclStore, stableJsonStringify } from "./acl-store.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("InMemoryKnowledgeAclStore", () => {
  it("canonicalizes ACL order and generates stable tenant-scoped hashes", async () => {
    const store = new InMemoryKnowledgeAclStore();
    const first = await store.upsertSnapshot(scope, {
      read: [{ type: "user", id: "user-2" }, { type: "department", id: "dept-1" }],
      write: [{ type: "role", id: "knowledge_editor" }],
    });
    const second = await store.upsertSnapshot(scope, {
      write: [{ type: "role", id: "knowledge_editor" }],
      read: [{ type: "department", id: "dept-1" }, { type: "user", id: "user-2" }, { type: "user", id: "user-2" }],
    });

    expect(second.aclHash).toBe(first.aclHash);
    expect(first.canonicalJson.read).toEqual([
      { type: "department", id: "dept-1" },
      { type: "user", id: "user-2" },
    ]);
  });

  it("replaces document principals for the current ACL version", async () => {
    const store = new InMemoryKnowledgeAclStore();
    const snapshot = await store.upsertSnapshot(scope, { read: [{ type: "tenant", id: "tenant-1" }] });

    await store.replaceDocumentPrincipals({
      scope,
      documentId: "doc_1",
      aclHash: snapshot.aclHash,
      aclVersion: 2,
      canonicalAcl: snapshot.canonicalJson,
    });

    expect(await store.listDocumentPrincipals(scope, "doc_1", 2)).toMatchObject([
      { permission: "read", principalType: "tenant", principalId: "tenant-1" },
    ]);
  });

  it("exposes stable JSON for canonical ACL contracts", () => {
    const canonical = canonicalizeAcl(scope, { admin: [{ type: "user", id: "user-1" }] });

    expect(stableJsonStringify(canonical)).toContain("\"admin\":[{\"id\":\"user-1\",\"type\":\"user\"}]");
  });
});
