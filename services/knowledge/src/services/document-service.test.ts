import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeIdempotencyStore } from "../repositories/idempotency-store.js";
import { InMemoryKnowledgeJobStore } from "../repositories/job-store.js";
import { InMemoryKnowledgeObjectStore, sha256Hex } from "../repositories/object-store.js";
import { InMemoryKnowledgeSpaceStore } from "../repositories/space-store.js";
import { InMemoryKnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import { KnowledgeDocumentService } from "./document-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const sha256 = "a".repeat(64);

function service() {
  const documents = new InMemoryKnowledgeDocumentStore();
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
    createdAt: new Date("2026-05-18T00:00:00.000Z"),
    updatedAt: new Date("2026-05-18T00:00:00.000Z"),
  }]);
  const acl = new InMemoryKnowledgeAclStore();
  const uploads = new InMemoryKnowledgeUploadSessionStore();
  const objects = new InMemoryKnowledgeObjectStore();
  return {
    documents,
    jobs,
    idempotency,
    audit,
    spaces,
    acl,
    uploads,
    objects,
    service: new KnowledgeDocumentService({ documents, jobs, idempotency, audit, spaces, acl, uploads, objects }),
  };
}

describe("KnowledgeDocumentService", () => {
  it("creates document, job, idempotency record, and audit event on ingest", async () => {
    const ctx = service();
    const result = await ctx.service.ingest(scope, {
      spaceId: "space_1",
      title: "Report",
      sourceSha256: sha256,
      createdBy: "user-1",
      idempotencyKey: "idem-1",
    }, new Date("2026-05-18T00:00:00.000Z"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await ctx.documents.get(scope, result.data.document_id)).toMatchObject({
      status: "queued",
      visibilityStatus: "hidden",
      sourceSha256: sha256,
    });
    expect(ctx.jobs.snapshot()).toHaveLength(1);
    expect(ctx.acl.snapshot().principals).toHaveLength(1);
    expect(ctx.idempotency.snapshot()[0]?.responseJson).toEqual(result.data);
    expect(ctx.audit.snapshot()[0]).toMatchObject({ action: "ingest", resourceId: result.data.document_id });
  });

  it("replays idempotent ingest result and rejects conflicting body", async () => {
    const ctx = service();
    const first = await ctx.service.ingest(scope, {
      spaceId: "space_1",
      title: "Report",
      sourceSha256: sha256,
      createdBy: "user-1",
      idempotencyKey: "idem-1",
    });
    const replay = await ctx.service.ingest(scope, {
      spaceId: "space_1",
      title: "Report",
      sourceSha256: sha256,
      createdBy: "user-1",
      idempotencyKey: "idem-1",
    });
    const conflict = await ctx.service.ingest(scope, {
      spaceId: "space_1",
      title: "Different",
      sourceSha256: sha256,
      createdBy: "user-1",
      idempotencyKey: "idem-1",
    });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(conflict).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("soft deletes document and cancels running jobs", async () => {
    const ctx = service();
    const ingest = await ctx.service.ingest(scope, { spaceId: "space_1", sourceSha256: sha256, createdBy: "user-1" });
    if (!ingest.ok) throw new Error("ingest failed");

    const deleted = await ctx.service.deleteDocument(scope, ingest.data.document_id, "user-1", new Date("2026-05-18T00:01:00.000Z"));

    expect(deleted).toMatchObject({ ok: true, data: { status: "deleted", cancelled_jobs: 1 } });
    expect(await ctx.documents.isVisible(scope, ingest.data.document_id)).toBe(false);
    expect(ctx.jobs.snapshot()[0]).toMatchObject({ status: "cancelled", errorCode: "JOB_CANCELLED" });
  });

  it("lists documents by space, excluding deleted by default", async () => {
    const ctx = service();
    const a = await ctx.service.ingest(scope, { spaceId: "space_1", sourceSha256: "a".repeat(64), sourceFilename: "a.pdf", createdBy: "u" });
    const b = await ctx.service.ingest(scope, { spaceId: "space_1", sourceSha256: "b".repeat(64), sourceFilename: "b.pdf", createdBy: "u" });
    const c = await ctx.service.ingest(scope, { spaceId: "space_1", sourceSha256: "c".repeat(64), sourceFilename: "c.pdf", createdBy: "u" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("ingest failed");
    await ctx.service.deleteDocument(scope, b.data.document_id, "u");

    const visible = await ctx.service.listDocumentsBySpace(scope, "space_1", {});
    expect(visible.ok && visible.data.items).toHaveLength(2);
    expect(visible.ok && (visible.data.items as any[]).map((d) => d.document_id).sort()).toEqual([a.data.document_id, c.data.document_id].sort());

    const includingDeleted = await ctx.service.listDocumentsBySpace(scope, "space_1", { includeDeleted: true });
    expect(includingDeleted.ok && includingDeleted.data.items).toHaveLength(3);

    const missing = await ctx.service.listDocumentsBySpace(scope, "space_nope", {});
    expect(missing).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("rejects ingest without a trusted source hash", async () => {
    const ctx = service();

    expect(await ctx.service.ingest(scope, { spaceId: "space_1", createdBy: "user-1" }))
      .toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  it("verifies object_uri source hash before creating an ingest job", async () => {
    const ctx = service();
    const body = Buffer.from("uploaded document");
    const objectUri = "mem://octopus-knowledge/octopus/tenant-1/raw/report.pdf";
    const object = await ctx.objects.put(scope, objectUri, body);
    await ctx.uploads.create({
      ...scope,
      uploadId: "upload_doc_object_uri",
      spaceId: "space_1",
      assetId: "asset_doc_object_uri",
      objectUri,
      filename: "report.pdf",
      mimeType: "application/octet-stream",
      sizeBytes: body.byteLength,
      claimedSha256: object.sha256,
      actualSha256: object.sha256,
      status: "consumed",
      issuedBy: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await ctx.service.ingest(scope, {
      spaceId: "space_1",
      sourceType: "object_uri",
      sourceUri: object.uri,
      sourceSha256: object.sha256,
      createdBy: "user-1",
    });
    const mismatch = await ctx.service.ingest(scope, {
      spaceId: "space_1",
      sourceType: "object_uri",
      sourceUri: object.uri,
      sourceSha256: sha256Hex("different"),
      createdBy: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("ingest failed");
    expect(ctx.jobs.snapshot()[0]?.payload).toMatchObject({
      object_uri: object.uri,
      source_sha256: object.sha256,
      source_type: "object_uri",
    });
    expect(mismatch).toMatchObject({ ok: false, code: "CONTENT_HASH_MISMATCH" });
  });

  it("deduplicates repeated ingest for the same source hash and space", async () => {
    const ctx = service();
    const first = await ctx.service.ingest(scope, { spaceId: "space_1", sourceSha256: sha256, createdBy: "user-1" });
    const second = await ctx.service.ingest(scope, { spaceId: "space_1", sourceSha256: sha256, createdBy: "user-1" });
    if (!first.ok || !second.ok) throw new Error("ingest failed");

    expect(second.data.document_id).toBe(first.data.document_id);
    expect(second.data.document_version_id).toBe(first.data.document_version_id);
    expect(ctx.documents.snapshot()).toHaveLength(1);
    expect(ctx.jobs.snapshot()).toHaveLength(2);
    expect(ctx.jobs.snapshot()[1]).toMatchObject({ type: "ingest_duplicate", status: "succeeded" });
  });
});
