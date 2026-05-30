import { beforeEach, describe, expect, it } from "vitest";
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
import { knowledgeRegistry } from "../observability/metrics.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-metrics" };
const READER_CTX: SearchContext = {
  tenantId: "tenant-metrics",
  userId: "u",
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

  const aclSnapshot = await acl.upsertSnapshot(scope, { read: [{ type: "department", id: "dept-ops" }] });
  await acl.replaceDocumentPrincipals({
    scope,
    documentId: "doc_1",
    aclHash: aclSnapshot.aclHash,
    aclVersion: 1,
    canonicalAcl: aclSnapshot.canonicalJson,
  });

  const createdAt = new Date("2026-05-18T00:00:00.000Z");
  await documents.create({
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Handbook",
    documentType: "handbook",
    status: "searchable",
    visibilityStatus: "visible",
    currentVersionId: "ver_1",
    currentVersionNumber: 1,
    aclHash: aclSnapshot.aclHash,
    aclVersion: 1,
    sourceSha256: "a".repeat(64),
    createdBy: "u",
    createdAt,
    updatedAt: createdAt,
  });

  const chunk: KnowledgeChunkRecord = {
    sourceSystemId: scope.sourceSystemId,
    tenantId: scope.tenantId,
    chunkId: "chunk_metric",
    spaceId: "space_1",
    documentId: "doc_1",
    versionId: "ver_1",
    versionNumber: 1,
    chunkIndex: 0,
    status: "active",
    text: "scale workers deployment runbook",
    textHash: "h",
    tokenCount: 5,
    nodeIds: ["node_0"],
    headingPath: ["Intro"],
    pageStart: 1,
    pageEnd: 1,
    bboxRefs: [{ nodeId: "node_0", page: 1, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
    aclHash: aclSnapshot.aclHash,
    aclVersion: 1,
    embeddingModel: "mock-embed",
    embeddingVersion: "1.0.0",
    vectorPointId: "chunk_metric",
    fulltextDocId: "chunk_metric",
    metadata: {},
    createdAt,
    deletedAt: null,
  };
  await chunks.insertMany(scope, [chunk]);
  const embed = await embedding.embedBatch({ texts: [chunk.text] });
  if (embed.status !== "ok") throw new Error("embed");
  await vector.ensureCollection(embed.metadata.dimensions);
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
      document_type: "handbook",
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

  return new KnowledgeSearchService({ documents, chunks, vector, fulltext, embedding, reranker, acl, anchors, spaces });
}

describe("search-service metrics integration", () => {
  beforeEach(() => {
    knowledgeRegistry.resetMetrics();
  });

  it("records search latency + rerank score samples after a successful search", async () => {
    const search = await buildFixture();
    const result = await search.search(scope, { query: "scale workers" }, READER_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits.length).toBeGreaterThan(0);

    const json = await knowledgeRegistry.getMetricsAsJSON();
    const latency = json.find((m) => m.name === "knowledge_search_latency_seconds");
    expect(latency).toBeDefined();
    const latencyCount = latency!.values.find((v) =>
      v.metricName === "knowledge_search_latency_seconds_count" &&
      v.labels.tenant_id === "tenant-metrics" &&
      v.labels.status === "ok",
    );
    expect(latencyCount?.value).toBe(1);

    const rerank = json.find((m) => m.name === "knowledge_rerank_score");
    expect(rerank).toBeDefined();
    const rerankCount = rerank!.values.find((v) =>
      v.metricName === "knowledge_rerank_score_count" &&
      v.labels.tenant_id === "tenant-metrics",
    );
    expect(rerankCount?.value).toBeGreaterThan(0);
  });

  it("increments acl_denies + search_empty when no ACL visible to caller", async () => {
    const search = await buildFixture();
    const result = await search.search(scope, { query: "anything" }, {
      tenantId: "tenant-metrics",
      userId: "stranger",
      departments: [],
      roles: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits.length).toBe(0);

    const json = await knowledgeRegistry.getMetricsAsJSON();
    const acl = json.find((m) => m.name === "knowledge_acl_denies_total");
    const empty = json.find((m) => m.name === "knowledge_search_empty_total");
    expect(acl?.values.find((v) => v.labels.stage === "search_filter")?.value).toBe(1);
    expect(empty?.values.find((v) => v.labels.reason === "no_visible_acl")?.value).toBe(1);

    const latency = json.find((m) => m.name === "knowledge_search_latency_seconds");
    const latencyCount = latency!.values.find((v) =>
      v.metricName === "knowledge_search_latency_seconds_count" &&
      v.labels.status === "empty",
    );
    expect(latencyCount?.value).toBe(1);
  });
});
