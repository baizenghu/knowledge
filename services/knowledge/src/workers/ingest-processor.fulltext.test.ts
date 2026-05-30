import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAssetStore } from "../repositories/asset-store.js";
import { InMemoryKnowledgeChunkStore } from "../repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import { InMemoryKnowledgeObjectStore, sha256Hex } from "../repositories/object-store.js";
import { MockParserAdapter } from "../parser/mock-parser.js";
import { MockEmbeddingAdapter } from "../embedding/mock-embedding.js";
import { InMemoryQdrantAdapter } from "../vector/in-memory-qdrant.js";
import { InMemoryBM25Adapter } from "../fulltext/in-memory-bm25.js";
import type { FulltextAdapter } from "../fulltext/fulltext-adapter.js";
import type { KnowledgeJobRecord } from "../repositories/job-store.js";
import { createIngestProcessor } from "./ingest-processor.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

async function setup(body: Buffer) {
  const documents = new InMemoryKnowledgeDocumentStore();
  const versions = new InMemoryKnowledgeDocumentVersionStore();
  const objects = new InMemoryKnowledgeObjectStore();
  const assets = new InMemoryKnowledgeAssetStore();
  const chunks = new InMemoryKnowledgeChunkStore();
  const vector = new InMemoryQdrantAdapter("knowledge_chunks");
  const fulltext = new InMemoryBM25Adapter();
  const embedding = new MockEmbeddingAdapter();
  const sourceSha256 = sha256Hex(body);

  await documents.create({
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Doc",
    documentType: "markdown",
    status: "queued",
    visibilityStatus: "hidden",
    currentVersionId: "ver_1",
    currentVersionNumber: 1,
    aclHash: "acl_hash_1",
    aclVersion: 1,
    sourceSha256,
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await versions.create({
    ...scope,
    versionId: "ver_1",
    documentId: "doc_1",
    versionNumber: 1,
    status: "queued",
    contentSha256: sourceSha256,
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const objectUri = "mem://octopus-knowledge/octopus/tenant-1/raw/upload_idx/doc.md";
  await objects.put(scope, objectUri, body, { mimeType: "text/markdown" });

  return { documents, versions, objects, assets, chunks, vector, fulltext, embedding, sourceSha256, objectUri };
}

function makeJob(payload: Record<string, unknown>): KnowledgeJobRecord {
  return {
    ...scope,
    jobId: "job_idx",
    type: "ingest",
    status: "running",
    priority: 100,
    documentId: "doc_1",
    payload,
    attempt: 1,
    maxRetries: 3,
    runAfterAt: new Date(),
  };
}

describe("ingest-processor fulltext indexing (M5)", () => {
  it("upserts chunks into the BM25 index and stamps fulltextDocId = chunkId", async () => {
    const body = Buffer.from("# Top\n\nFirst paragraph contains searchable keywords like elephant.\n\n## Sub\n\nSecond paragraph mentions giraffe and zebra.\n");
    const ctx = await setup(body);

    const processor = createIngestProcessor({
      documents: ctx.documents,
      versions: ctx.versions,
      objects: ctx.objects,
      assets: ctx.assets,
      chunks: ctx.chunks,
      embedding: ctx.embedding,
      vector: ctx.vector,
      fulltext: ctx.fulltext,
      parser: new MockParserAdapter(),
    });

    const result = await processor(makeJob({
      version_id: "ver_1",
      space_id: "space_1",
      object_uri: ctx.objectUri,
      source_sha256: ctx.sourceSha256,
      source_filename: "doc.md",
      source_type: "upload",
    }), new AbortController().signal);

    expect(result).toMatchObject({ status: "succeeded" });

    const stored = ctx.chunks.snapshot();
    expect(stored.length).toBeGreaterThan(0);
    for (const chunk of stored) {
      expect(chunk.fulltextDocId).toBe(chunk.chunkId);
    }

    const ftSnapshot = ctx.fulltext.snapshot();
    expect(ftSnapshot.length).toBe(stored.length);
    const ids = new Set(ftSnapshot.map((d) => d.id));
    for (const chunk of stored) {
      expect(ids.has(chunk.chunkId)).toBe(true);
    }

    const hits = await ctx.fulltext.search("elephant", 10);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.payload.tenant_id).toBe("tenant-1");
      expect(hit.payload.document_id).toBe("doc_1");
      expect(hit.payload.acl_hash).toBe("acl_hash_1");
      expect(hit.payload.status).toBe("active");
    }
  });

  it("fulltext upsert failure marks chunks deleted and throws retryable error", async () => {
    const body = Buffer.from("# Top\n\nbody.\n");
    const ctx = await setup(body);

    const flakyFulltext: FulltextAdapter = {
      upsertDocuments: async () => ({ status: "failed", reason: "es_http_503", retryable: true } as const),
      search: async () => [],
      deleteByFilter: async () => 0,
    };

    const processor = createIngestProcessor({
      documents: ctx.documents,
      versions: ctx.versions,
      objects: ctx.objects,
      assets: ctx.assets,
      chunks: ctx.chunks,
      embedding: ctx.embedding,
      vector: ctx.vector,
      fulltext: flakyFulltext,
      parser: new MockParserAdapter(),
    });

    await expect(processor(makeJob({
      version_id: "ver_1",
      space_id: "space_1",
      object_uri: ctx.objectUri,
      source_sha256: ctx.sourceSha256,
      source_filename: "doc.md",
    }), new AbortController().signal)).rejects.toThrow(/fulltext_upsert_failed/);

    const stored = ctx.chunks.snapshot();
    expect(stored.length).toBeGreaterThan(0);
    for (const chunk of stored) {
      expect(chunk.deletedAt).not.toBeNull();
      expect(chunk.status).toBe("deleted");
    }
  });
});
