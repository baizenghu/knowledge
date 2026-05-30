import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAssetStore } from "../repositories/asset-store.js";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeChunkStore } from "../repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import { InMemoryKnowledgeIdempotencyStore } from "../repositories/idempotency-store.js";
import { InMemoryKnowledgeJobStore } from "../repositories/job-store.js";
import { InMemoryKnowledgeObjectStore, sha256Hex } from "../repositories/object-store.js";
import { InMemoryKnowledgeSpaceStore } from "../repositories/space-store.js";
import { InMemoryKnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import { MockEmbeddingAdapter } from "../embedding/mock-embedding.js";
import { MockParserAdapter } from "../parser/mock-parser.js";
import { InMemoryQdrantAdapter } from "../vector/in-memory-qdrant.js";
import { createIngestProcessor } from "../workers/ingest-processor.js";
import { KnowledgeDocumentService } from "./document-service.js";
import { KnowledgeReindexService } from "./reindex-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

async function buildHarness() {
  const documents = new InMemoryKnowledgeDocumentStore();
  const versions = new InMemoryKnowledgeDocumentVersionStore();
  const jobs = new InMemoryKnowledgeJobStore();
  const idempotency = new InMemoryKnowledgeIdempotencyStore();
  const audit = new InMemoryKnowledgeAuditEventWriter();
  const spaces = new InMemoryKnowledgeSpaceStore([{
    ...scope,
    spaceId: "space_1",
    type: "enterprise",
    name: "Ops",
    ownerType: "tenant",
    ownerId: "tenant-1",
    defaultAcl: { read: [{ type: "tenant", id: "tenant-1" }], write: [], admin: [] },
    status: "active",
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  }]);
  const acl = new InMemoryKnowledgeAclStore();
  const uploads = new InMemoryKnowledgeUploadSessionStore();
  const objects = new InMemoryKnowledgeObjectStore();
  const assets = new InMemoryKnowledgeAssetStore();
  const chunks = new InMemoryKnowledgeChunkStore();
  const vector = new InMemoryQdrantAdapter("knowledge_chunks");
  const embedding = new MockEmbeddingAdapter();

  const documentService = new KnowledgeDocumentService({
    documents, versions, jobs, idempotency, audit, spaces, acl, uploads, objects,
  });
  const reindexService = new KnowledgeReindexService({
    documents, versions, jobs, chunks, audit, vector, spaces,
  });
  const ingestProcessor = createIngestProcessor({
    documents, versions, objects, assets, chunks, embedding, vector,
    parser: new MockParserAdapter(),
  });

  return {
    documents, versions, jobs, audit, chunks, vector, uploads, objects,
    documentService, reindexService, ingestProcessor,
  };
}

async function ingestOnce(h: Awaited<ReturnType<typeof buildHarness>>): Promise<{ documentId: string; jobId: string; versionId: string; body: Buffer; sha256: string; objectUri: string }> {
  const body = Buffer.from("# Heading\n\nbody paragraph one.\n\n## Sub\n\nbody paragraph two.\n");
  const sha = sha256Hex(body);
  // Pre-load object + upload session so document-service.ingest validates.
  const uploadId = "upload_1";
  const objectUri = `mem://octopus-knowledge/octopus/tenant-1/raw/${uploadId}/doc.md`;
  await h.objects.put(scope, objectUri, body, { mimeType: "text/markdown" });
  await h.uploads.create({
    ...scope,
    uploadId,
    spaceId: "space_1",
    assetId: "asset_1",
    objectUri,
    filename: "doc.md",
    mimeType: "text/markdown",
    sizeBytes: body.byteLength,
    claimedSha256: sha,
    actualSha256: sha,
    status: "consumed",
    issuedBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  const result = await h.documentService.ingest(scope, {
    spaceId: "space_1",
    title: "Doc",
    sourceType: "upload",
    sourceUri: objectUri,
    uploadId,
    filename: "doc.md",
    sourceSha256: sha,
    createdBy: "user-1",
  });
  if (!result.ok) throw new Error(`ingest failed: ${result.code}`);
  const ingestJob = (await h.jobs.get(scope, result.data.job_id))!;
  await h.ingestProcessor(ingestJob, new AbortController().signal);
  // mark job succeeded so leases don't block reindex lookup
  return {
    documentId: result.data.document_id,
    jobId: result.data.job_id,
    versionId: result.data.document_version_id,
    body, sha256: sha, objectUri,
  };
}

describe("KnowledgeReindexService", () => {
  it("startReindex creates new version + queued job + audit", async () => {
    const h = await buildHarness();
    const seeded = await ingestOnce(h);

    const result = await h.reindexService.startReindex(scope, seeded.documentId, "user-2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.new_version_number).toBe(2);
    expect(result.data.status).toBe("queued");

    const newJob = await h.jobs.get(scope, result.data.job_id);
    expect(newJob).not.toBeNull();
    expect(newJob!.status).toBe("queued");
    expect((newJob!.payload as { reindex_mode?: string }).reindex_mode).toBe("shadow");
    expect((newJob!.payload as { object_uri?: string }).object_uri).toBe(seeded.objectUri);

    const auditEvents = h.audit.snapshot().filter((e) => e.action === "reindex.start");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.resourceId).toBe(seeded.documentId);
  });

  it("startReindex returns NOT_FOUND for unknown document", async () => {
    const h = await buildHarness();
    const result = await h.reindexService.startReindex(scope, "doc_does_not_exist", "user-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
  });

  it("end-to-end: ingest -> reindex -> promote flips current version and chunk status", async () => {
    const h = await buildHarness();
    const seeded = await ingestOnce(h);
    const v1Chunks = h.chunks.snapshot().filter((c) => c.versionId === seeded.versionId);
    expect(v1Chunks.length).toBeGreaterThan(0);
    expect(v1Chunks.every((c) => c.status === "active")).toBe(true);

    const start = await h.reindexService.startReindex(scope, seeded.documentId, "user-1");
    if (!start.ok) throw new Error("startReindex failed");

    // Run the shadow ingest job.
    const shadowJob = (await h.jobs.get(scope, start.data.job_id))!;
    const procResult = await h.ingestProcessor(shadowJob, new AbortController().signal);
    expect(procResult.status).toBe("succeeded");

    // Doc still on v1 (searchable), v2 chunks are shadow.
    const docAfterIndex = (await h.documents.get(scope, seeded.documentId))!;
    expect(docAfterIndex.currentVersionId).toBe(seeded.versionId);
    expect(docAfterIndex.status).toBe("searchable");
    const v2Chunks = h.chunks.snapshot().filter((c) => c.versionId === start.data.new_version_id);
    expect(v2Chunks.length).toBeGreaterThan(0);
    expect(v2Chunks.every((c) => c.status === "shadow")).toBe(true);

    // Search over active filter should not include shadow points.
    const activeOnly = await h.vector.searchByVector(
      [0.1, 0.2, 0.3],
      100,
      { must: [{ key: "status", match: { value: "active" } }] },
    );
    expect(activeOnly.length).toBeGreaterThan(0);
    expect(activeOnly.every((hit) => hit.payload.document_version_id === seeded.versionId)).toBe(true);

    // Promote.
    const promote = await h.reindexService.promote(scope, seeded.documentId, start.data.new_version_id, "user-1");
    expect(promote.ok).toBe(true);
    if (!promote.ok) return;
    expect(promote.data.promoted_chunks).toBe(v2Chunks.length);
    expect(promote.data.demoted_chunks).toBe(v1Chunks.length);

    const docAfterPromote = (await h.documents.get(scope, seeded.documentId))!;
    expect(docAfterPromote.currentVersionId).toBe(start.data.new_version_id);
    expect(docAfterPromote.currentVersionNumber).toBe(2);

    const v1After = h.chunks.snapshot().filter((c) => c.versionId === seeded.versionId);
    expect(v1After.every((c) => c.status === "deleted")).toBe(true);
    const v2After = h.chunks.snapshot().filter((c) => c.versionId === start.data.new_version_id);
    expect(v2After.every((c) => c.status === "active")).toBe(true);

    const vectorPoints = h.vector.snapshot();
    expect(vectorPoints.every((p) => p.payload.document_version_id === start.data.new_version_id)).toBe(true);
    // P0-2 regression: payload status must be flipped from shadow → active.
    expect(vectorPoints.every((p) => p.payload.status === "active")).toBe(true);
    const activeHits = await h.vector.searchByVector(
      [0.5, 0.5, 0.5],
      100,
      { must: [{ key: "status", match: { value: "active" } }] },
    );
    expect(activeHits.length).toBeGreaterThan(0);
    expect(activeHits.every((hit) => hit.payload.document_version_id === start.data.new_version_id)).toBe(true);

    const audited = h.audit.snapshot().filter((e) => e.action === "reindex.promote");
    expect(audited).toHaveLength(1);
  });

  it("end-to-end: ingest -> reindex -> rollback discards shadow without touching current", async () => {
    const h = await buildHarness();
    const seeded = await ingestOnce(h);

    const start = await h.reindexService.startReindex(scope, seeded.documentId, "user-1");
    if (!start.ok) throw new Error("startReindex failed");
    const shadowJob = (await h.jobs.get(scope, start.data.job_id))!;
    await h.ingestProcessor(shadowJob, new AbortController().signal);

    const rollback = await h.reindexService.rollback(scope, seeded.documentId, start.data.new_version_id, "user-1");
    expect(rollback.ok).toBe(true);
    if (!rollback.ok) return;
    expect(rollback.data.rolled_back_chunks).toBeGreaterThan(0);

    const doc = (await h.documents.get(scope, seeded.documentId))!;
    expect(doc.currentVersionId).toBe(seeded.versionId);

    const v1 = h.chunks.snapshot().filter((c) => c.versionId === seeded.versionId);
    expect(v1.every((c) => c.status === "active")).toBe(true);
    const v2 = h.chunks.snapshot().filter((c) => c.versionId === start.data.new_version_id);
    expect(v2.every((c) => c.status === "deleted")).toBe(true);

    const vectorPoints = h.vector.snapshot();
    expect(vectorPoints.every((p) => p.payload.document_version_id === seeded.versionId)).toBe(true);

    const audited = h.audit.snapshot().filter((e) => e.action === "reindex.rollback");
    expect(audited).toHaveLength(1);
  });

  it("shadow indexing does not surface in active-only search", async () => {
    const h = await buildHarness();
    const seeded = await ingestOnce(h);
    const start = await h.reindexService.startReindex(scope, seeded.documentId, "user-1");
    if (!start.ok) throw new Error("startReindex failed");
    const shadowJob = (await h.jobs.get(scope, start.data.job_id))!;
    await h.ingestProcessor(shadowJob, new AbortController().signal);

    const activeHits = await h.vector.searchByVector(
      [0.5, 0.5, 0.5],
      100,
      { must: [{ key: "status", match: { value: "active" } }] },
    );
    expect(activeHits.length).toBeGreaterThan(0);
    for (const hit of activeHits) {
      expect(hit.payload.document_version_id).toBe(seeded.versionId);
      expect(hit.payload.status).toBe("active");
    }

    const shadowHits = await h.vector.searchByVector(
      [0.5, 0.5, 0.5],
      100,
      { must: [{ key: "status", match: { value: "shadow" } }] },
    );
    expect(shadowHits.length).toBeGreaterThan(0);
    for (const hit of shadowHits) {
      expect(hit.payload.document_version_id).toBe(start.data.new_version_id);
    }
  });
});
