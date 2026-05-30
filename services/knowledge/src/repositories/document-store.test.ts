import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeDocumentStore, type KnowledgeDocumentRecord } from "./document-store.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

function document(overrides: Partial<KnowledgeDocumentRecord>): KnowledgeDocumentRecord {
  return {
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Doc",
    status: "searchable",
    visibilityStatus: "visible",
    aclHash: "acl_default",
    aclVersion: 1,
    createdBy: "user-1",
    createdAt: new Date("2026-05-18T00:00:00.000Z"),
    updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("InMemoryKnowledgeDocumentStore", () => {
  it("soft deletes documents and immediately removes visibility", async () => {
    const store = new InMemoryKnowledgeDocumentStore([document({})]);
    expect(await store.isVisible(scope, "doc_1")).toBe(true);

    const deleted = await store.softDelete(scope, "doc_1", new Date("2026-05-18T00:01:00.000Z"));

    expect(deleted).toMatchObject({
      status: "deleted",
      visibilityStatus: "deleted",
      deletedAt: new Date("2026-05-18T00:01:00.000Z"),
    });
    expect(await store.isVisible(scope, "doc_1")).toBe(false);
  });
});
