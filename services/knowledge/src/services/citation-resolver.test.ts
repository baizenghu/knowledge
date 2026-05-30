import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAnchorStore } from "../repositories/anchor-store.js";
import { InMemoryKnowledgeChunkStore, type KnowledgeChunkRecord } from "../repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { KnowledgeAclVisibilityService } from "./acl-visibility.js";
import { KnowledgeCitationResolver } from "./citation-resolver.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const otherTenant = { sourceSystemId: "octopus", tenantId: "tenant-2" };
const ctx = { tenantId: "tenant-1", userId: "user-1", departments: ["dept-ops"], roles: [] };

async function buildFixture() {
  const documents = new InMemoryKnowledgeDocumentStore();
  const chunks = new InMemoryKnowledgeChunkStore();
  const acl = new InMemoryKnowledgeAclStore();
  const anchors = new InMemoryKnowledgeAnchorStore();
  const visibility = new KnowledgeAclVisibilityService({ acl, documents });
  const resolver = new KnowledgeCitationResolver({ anchors, chunks, documents, aclVisibility: visibility });

  const snapshot = await acl.upsertSnapshot(scope, { read: [{ type: "department", id: "dept-ops" }] });
  await acl.replaceDocumentPrincipals({
    scope,
    documentId: "doc_1",
    aclHash: snapshot.aclHash,
    aclVersion: 1,
    canonicalAcl: snapshot.canonicalJson,
  });

  const createdAt = new Date("2026-05-18T00:00:00.000Z");
  await documents.create({
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Octopus Handbook",
    status: "searchable",
    visibilityStatus: "visible",
    currentVersionId: "ver_1",
    currentVersionNumber: 1,
    aclHash: snapshot.aclHash,
    aclVersion: 1,
    sourceSha256: "a".repeat(64),
    createdBy: "user-1",
    createdAt,
    updatedAt: createdAt,
  });

  const chunk: KnowledgeChunkRecord = {
    sourceSystemId: scope.sourceSystemId,
    tenantId: scope.tenantId,
    chunkId: "chunk_1",
    spaceId: "space_1",
    documentId: "doc_1",
    versionId: "ver_1",
    versionNumber: 1,
    chunkIndex: 0,
    status: "active",
    text: "the actual snippet text used by retrieval and rendered in citations",
    textHash: "h",
    tokenCount: 8,
    nodeIds: ["node_0"],
    headingPath: ["Intro", "Deployment"],
    pageStart: 3,
    pageEnd: 3,
    bboxRefs: [{ nodeId: "node_0", page: 3, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }],
    aclHash: snapshot.aclHash,
    aclVersion: 1,
    embeddingModel: "mock",
    embeddingVersion: "1.0.0",
    vectorPointId: "chunk_1",
    fulltextDocId: "chunk_1",
    metadata: {},
    createdAt,
    deletedAt: null,
  };
  await chunks.insertMany(scope, [chunk]);

  const anchor = await anchors.upsert({
    sourceSystemId: scope.sourceSystemId,
    tenantId: scope.tenantId,
    anchorId: "anchor_visible",
    chunkId: "chunk_1",
    documentId: "doc_1",
    versionId: "ver_1",
    spaceId: "space_1",
    aclHash: snapshot.aclHash,
    aclVersion: 1,
    page: 3,
    bbox: { x0: 1, y0: 2, x1: 3, y1: 4 },
    charSpan: null,
    nodeIds: ["node_0"],
    headingPath: ["Intro", "Deployment"],
    createdAt,
  });

  return { resolver, documents, anchors, anchor };
}

describe("KnowledgeCitationResolver", () => {
  it("resolves a valid anchor to a document title, page, and snippet", async () => {
    const fx = await buildFixture();
    const result = await fx.resolver.resolve(scope, "anchor_visible", ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.document_title).toBe("Octopus Handbook");
    expect(result.data.page).toBe(3);
    expect(result.data.bbox).toEqual({ x0: 1, y0: 2, x1: 3, y1: 4 });
    expect(result.data.snippet.length).toBeGreaterThan(0);
  });

  it("returns NOT_FOUND when resolving the anchor under a different tenant scope", async () => {
    const fx = await buildFixture();
    const result = await fx.resolver.resolve(otherTenant, "anchor_visible", {
      ...ctx,
      tenantId: otherTenant.tenantId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND once the document is soft-deleted", async () => {
    const fx = await buildFixture();
    await fx.documents.softDelete(scope, "doc_1");
    const result = await fx.resolver.resolve(scope, "anchor_visible", ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
  });
});
