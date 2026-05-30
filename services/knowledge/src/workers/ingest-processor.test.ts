import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAssetStore } from "../repositories/asset-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import { InMemoryKnowledgeObjectStore, sha256Hex } from "../repositories/object-store.js";
import { MockParserAdapter } from "../parser/mock-parser.js";
import type { KnowledgeJobRecord } from "../repositories/job-store.js";
import { createIngestProcessor } from "./ingest-processor.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

function setupFixture(opts: { body: Buffer; filename: string; mimeType: string }) {
  const documents = new InMemoryKnowledgeDocumentStore();
  const versions = new InMemoryKnowledgeDocumentVersionStore();
  const objects = new InMemoryKnowledgeObjectStore();
  const assets = new InMemoryKnowledgeAssetStore();
  return { documents, versions, objects, assets };
}

async function seedDocument(documents: InMemoryKnowledgeDocumentStore, versions: InMemoryKnowledgeDocumentVersionStore, sourceSha256: string) {
  await documents.create({
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Doc",
    documentType: null,
    status: "queued",
    visibilityStatus: "hidden",
    currentVersionId: "ver_1",
    currentVersionNumber: 1,
    aclHash: "hash_1",
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
}

describe("createIngestProcessor", () => {
  it("parses markdown source, persists canonical artifacts, marks doc searchable", async () => {
    const body = Buffer.from("# Heading\n\nbody\n");
    const sha256 = sha256Hex(body);
    const { documents, versions, objects, assets } = setupFixture({ body, filename: "doc.md", mimeType: "text/markdown" });
    await seedDocument(documents, versions, sha256);
    const objectUri = "mem://octopus-knowledge/octopus/tenant-1/raw/upload_1/doc.md";
    await objects.put(scope, objectUri, body, { mimeType: "text/markdown" });

    const processor = createIngestProcessor({
      documents,
      versions,
      objects,
      assets,
      parser: new MockParserAdapter(),
    });

    const job: KnowledgeJobRecord = {
      ...scope,
      jobId: "job_1",
      type: "ingest",
      status: "running",
      priority: 100,
      documentId: "doc_1",
      payload: {
        version_id: "ver_1",
        space_id: "space_1",
        object_uri: objectUri,
        source_sha256: sha256,
        source_filename: "doc.md",
        source_type: "upload",
      },
      attempt: 1,
      maxRetries: 3,
      runAfterAt: new Date(),
    };

    const result = await processor(job, new AbortController().signal);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(await documents.get(scope, "doc_1")).toMatchObject({ status: "searchable", visibilityStatus: "visible" });
    expect(await versions.get(scope, "ver_1")).toMatchObject({ status: "searchable" });

    const written = assets.snapshot().filter((a) => a.versionId === "ver_1");
    const types = written.map((a) => a.type).sort();
    expect(types).toEqual(["canonical_json", "markdown"]);
    const canonical = written.find((a) => a.type === "canonical_json");
    expect(canonical?.metadata).toMatchObject({ parser_provider: "mock", node_count: 2 });
    expect(await objects.get(scope, canonical!.uri)).not.toBeNull();
  });

  it("marks document degraded when parser cannot decode binary input", async () => {
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
    const sha256 = sha256Hex(body);
    const { documents, versions, objects, assets } = setupFixture({ body, filename: "image.jpg", mimeType: "image/jpeg" });
    await seedDocument(documents, versions, sha256);
    const objectUri = "mem://octopus-knowledge/octopus/tenant-1/raw/upload_2/image.jpg";
    await objects.put(scope, objectUri, body, { mimeType: "image/jpeg" });

    const processor = createIngestProcessor({
      documents,
      versions,
      objects,
      assets,
      parser: new MockParserAdapter(),
    });

    const result = await processor({
      ...scope,
      jobId: "job_2",
      type: "ingest",
      status: "running",
      priority: 100,
      documentId: "doc_1",
      payload: {
        version_id: "ver_1",
        space_id: "space_1",
        object_uri: objectUri,
        source_sha256: sha256,
        source_filename: "image.jpg",
        source_type: "upload",
      },
      attempt: 1,
      maxRetries: 3,
      runAfterAt: new Date(),
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "degraded" });
    expect(await documents.get(scope, "doc_1")).toMatchObject({ status: "degraded", visibilityStatus: "visible" });
  });

  it("throws when object sha256 disagrees with the ingest-time hash", async () => {
    const body = Buffer.from("real content");
    const tamperedSha = sha256Hex(Buffer.from("different"));
    const { documents, versions, objects, assets } = setupFixture({ body, filename: "doc.md", mimeType: "text/markdown" });
    await seedDocument(documents, versions, tamperedSha);
    const objectUri = "mem://octopus-knowledge/octopus/tenant-1/raw/upload_3/doc.md";
    await objects.put(scope, objectUri, body);

    const processor = createIngestProcessor({
      documents,
      versions,
      objects,
      assets,
      parser: new MockParserAdapter(),
    });

    await expect(processor({
      ...scope,
      jobId: "job_3",
      type: "ingest",
      status: "running",
      priority: 100,
      documentId: "doc_1",
      payload: {
        version_id: "ver_1",
        space_id: "space_1",
        object_uri: objectUri,
        source_sha256: tamperedSha,
        source_filename: "doc.md",
        source_type: "upload",
      },
      attempt: 1,
      maxRetries: 3,
      runAfterAt: new Date(),
    }, new AbortController().signal)).rejects.toThrow(/sha256/);
  });
});
