import { describe, expect, it } from "vitest";
import { MockEmbeddingAdapter } from "../embedding/mock-embedding.js";
import { InMemoryBM25Adapter } from "../fulltext/in-memory-bm25.js";
import { MockRerankerAdapter } from "../rerank/mock-rerank.js";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAnchorStore } from "../repositories/anchor-store.js";
import { InMemoryKnowledgeChunkStore, type KnowledgeChunkRecord } from "../repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeSpaceStore } from "../repositories/space-store.js";
import { InMemoryQdrantAdapter } from "../vector/in-memory-qdrant.js";
import { KnowledgeSearchService, type SearchContext } from "./search-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const otherTenant = { sourceSystemId: "octopus", tenantId: "tenant-2" };

const READER_CTX: SearchContext = {
  tenantId: "tenant-1",
  userId: "user-reader",
  departments: ["dept-ops"],
  roles: ["reader"],
};

async function buildFixture() {
  const documents = new InMemoryKnowledgeDocumentStore();
  const chunks = new InMemoryKnowledgeChunkStore();
  const vector = new InMemoryQdrantAdapter("knowledge_chunks");
  const fulltext = new InMemoryBM25Adapter();
  const embedding = new MockEmbeddingAdapter();
  const reranker = new MockRerankerAdapter();
  const acl = new InMemoryKnowledgeAclStore();
  const anchors = new InMemoryKnowledgeAnchorStore();
  const spaces = new InMemoryKnowledgeSpaceStore();

  // ACL snapshot the reader can read.
  const aclSnapshot = await acl.upsertSnapshot(scope, { read: [{ type: "department", id: "dept-ops" }] });
  await acl.replaceDocumentPrincipals({
    scope,
    documentId: "doc_1",
    aclHash: aclSnapshot.aclHash,
    aclVersion: 1,
    canonicalAcl: aclSnapshot.canonicalJson,
  });

  // ACL snapshot the reader cannot read (admin-only).
  const adminAcl = await acl.upsertSnapshot(scope, { read: [{ type: "role", id: "admin" }] });
  await acl.replaceDocumentPrincipals({
    scope,
    documentId: "doc_secret",
    aclHash: adminAcl.aclHash,
    aclVersion: 1,
    canonicalAcl: adminAcl.canonicalJson,
  });

  const createdAt = new Date("2026-05-18T00:00:00.000Z");
  await documents.create({
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Octopus Handbook",
    documentType: "handbook",
    status: "searchable",
    visibilityStatus: "visible",
    currentVersionId: "ver_1",
    currentVersionNumber: 1,
    aclHash: aclSnapshot.aclHash,
    aclVersion: 1,
    sourceSha256: "a".repeat(64),
    createdBy: "user-1",
    createdAt,
    updatedAt: createdAt,
  });
  await documents.create({
    ...scope,
    documentId: "doc_secret",
    spaceId: "space_1",
    title: "Secret Plans",
    documentType: "internal",
    status: "searchable",
    visibilityStatus: "visible",
    currentVersionId: "ver_2",
    currentVersionNumber: 1,
    aclHash: adminAcl.aclHash,
    aclVersion: 1,
    sourceSha256: "b".repeat(64),
    createdBy: "user-1",
    createdAt,
    updatedAt: createdAt,
  });

  const visibleChunk: KnowledgeChunkRecord = makeChunk({
    chunkId: "chunk_visible",
    documentId: "doc_1",
    versionId: "ver_1",
    text: "octopus deployment runbook how to scale workers",
    aclHash: aclSnapshot.aclHash,
  });
  const secretChunk: KnowledgeChunkRecord = makeChunk({
    chunkId: "chunk_secret",
    documentId: "doc_secret",
    versionId: "ver_2",
    text: "secret plan to scale workers via deployment",
    aclHash: adminAcl.aclHash,
    spaceId: "space_1",
  });

  await chunks.insertMany(scope, [visibleChunk, secretChunk]);

  await vector.ensureCollection(64);
  for (const chunk of [visibleChunk, secretChunk]) {
    const embed = await embedding.embedBatch({ texts: [chunk.text] });
    if (embed.status !== "ok") throw new Error("embed failed");
    await vector.upsertPoints([{
      id: chunk.chunkId,
      vector: embed.vectors[0],
      payload: {
        source_system_id: chunk.sourceSystemId,
        tenant_id: chunk.tenantId,
        space_id: chunk.spaceId,
        document_id: chunk.documentId,
        document_version_id: chunk.versionId,
        document_version_number: chunk.versionNumber,
        acl_hash: chunk.aclHash,
        acl_version: chunk.aclVersion,
        status: "active",
        deleted_at: null,
        tags: [],
        document_type: chunk.documentId === "doc_1" ? "handbook" : "internal",
        time: createdAt.toISOString(),
        chunk_index: chunk.chunkIndex,
        heading_path: chunk.headingPath,
        page_start: chunk.pageStart,
        page_end: chunk.pageEnd,
      },
    }]);
    await fulltext.upsertDocuments([{
      id: chunk.chunkId,
      text: chunk.text,
      payload: {
        source_system_id: chunk.sourceSystemId,
        tenant_id: chunk.tenantId,
        space_id: chunk.spaceId,
        document_id: chunk.documentId,
        document_version_id: chunk.versionId,
        document_version_number: chunk.versionNumber,
        acl_hash: chunk.aclHash,
        acl_version: chunk.aclVersion,
        status: "active",
        chunk_id: chunk.chunkId,
        chunk_index: chunk.chunkIndex,
        heading_path: chunk.headingPath,
        page_start: chunk.pageStart,
        page_end: chunk.pageEnd,
      },
    }]);
  }

  const search = new KnowledgeSearchService({
    documents,
    chunks,
    vector,
    fulltext,
    embedding,
    reranker,
    acl,
    anchors,
    spaces,
  });

  return { search, documents, chunks, vector, fulltext, acl, anchors, spaces };
}

function makeChunk(overrides: Partial<KnowledgeChunkRecord> & {
  chunkId: string;
  documentId: string;
  versionId: string;
  text: string;
  aclHash: string;
}): KnowledgeChunkRecord {
  return {
    sourceSystemId: scope.sourceSystemId,
    tenantId: scope.tenantId,
    chunkId: overrides.chunkId,
    spaceId: overrides.spaceId ?? "space_1",
    documentId: overrides.documentId,
    versionId: overrides.versionId,
    versionNumber: 1,
    chunkIndex: 0,
    status: "active",
    text: overrides.text,
    textHash: "h",
    tokenCount: 8,
    nodeIds: ["node_0"],
    headingPath: ["Intro"],
    pageStart: 1,
    pageEnd: 1,
    bboxRefs: [{ nodeId: "node_0", page: 1, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
    aclHash: overrides.aclHash,
    aclVersion: 1,
    sectionId: overrides.sectionId ?? "sec_default",
    embeddingModel: "mock-embed",
    embeddingVersion: "1.0.0",
    vectorPointId: overrides.chunkId,
    fulltextDocId: overrides.chunkId,
    metadata: {},
    createdAt: new Date(),
    deletedAt: null,
  };
}

describe("KnowledgeSearchService", () => {
  it("returns visible hits to a permitted reader and writes an anchor", async () => {
    const fx = await buildFixture();
    const result = await fx.search.search(scope, { query: "deployment runbook" }, READER_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits.length).toBeGreaterThan(0);
    expect(result.data.hits.map((h) => h.documentId)).toContain("doc_1");
    expect(result.data.hits.map((h) => h.documentId)).not.toContain("doc_secret");
    const anchorId = result.data.hits[0].anchorId;
    expect(anchorId).toMatch(/^anchor_/);
    // Calling again returns the same anchor id (idempotent ensureAnchor).
    const again = await fx.search.search(scope, { query: "deployment runbook" }, READER_CTX);
    if (!again.ok) throw new Error("not ok");
    expect(again.data.hits[0].anchorId).toBe(anchorId);
  });

  it("returns empty for an unprivileged user (no visible acl)", async () => {
    const fx = await buildFixture();
    const result = await fx.search.search(scope, { query: "deployment" }, {
      tenantId: "tenant-1",
      userId: "user-stranger",
      departments: [],
      roles: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits).toEqual([]);
    expect(result.data.trace?.degraded?.no_visible_acl).toBe(true);
  });

  it("returns NOT_FOUND when strictSpaceCheck names a missing space", async () => {
    const fx = await buildFixture();
    const result = await fx.search.search(scope, {
      query: "anything",
      spaceIds: ["space_missing"],
      strictSpaceCheck: true,
    }, READER_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
  });

  it("falls back to RRF order when rerank fails and surfaces trace.degraded.rerank_failed", async () => {
    const fx = await buildFixture();
    const failingReranker = {
      metadata: { model: "broken", version: "0" },
      async rerank() {
        return { status: "failed" as const, reason: "boom", retryable: true };
      },
    };
    const search = new KnowledgeSearchService({
      documents: (fx as any).documents,
      chunks: (fx as any).chunks,
      vector: (fx as any).vector,
      fulltext: (fx as any).fulltext,
      embedding: new MockEmbeddingAdapter(),
      reranker: failingReranker,
      acl: (fx as any).acl,
      anchors: (fx as any).anchors,
      spaces: (fx as any).spaces,
    });
    const result = await search.search(scope, { query: "deployment runbook" }, READER_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.trace?.degraded?.rerank_failed).toBe(true);
    expect(result.data.hits.length).toBeGreaterThan(0);
    // Cross-scope safety: no hits leak to other tenant either.
    const cross = await search.search(otherTenant, { query: "deployment" }, {
      ...READER_CTX,
      tenantId: otherTenant.tenantId,
    });
    if (!cross.ok) throw new Error("not ok");
    expect(cross.data.hits).toEqual([]);
  });
});
