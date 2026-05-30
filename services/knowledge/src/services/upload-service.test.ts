import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeObjectStore, sha256Hex } from "../repositories/object-store.js";
import { InMemoryKnowledgeSpaceStore } from "../repositories/space-store.js";
import { InMemoryKnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import { KnowledgeSpaceService } from "./space-service.js";
import { KnowledgeUploadService } from "./upload-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("KnowledgeUploadService", () => {
  it("issues upload sessions only for existing spaces", async () => {
    const spaces = new InMemoryKnowledgeSpaceStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const uploads = new InMemoryKnowledgeUploadSessionStore();
    const spaceService = new KnowledgeSpaceService({ spaces, audit });
    const created = await spaceService.createSpace(scope, { name: "Ops", createdBy: "user-1" });
    if (!created.ok) throw new Error("space create failed");

    const objects = new InMemoryKnowledgeObjectStore();
    const service = new KnowledgeUploadService({ spaces, uploads, objects, audit });
    const result = await service.createUploadUrl(scope, {
      spaceId: created.data.space_id,
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      sha256: sha256Hex("content"),
      issuedBy: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("ready");
    expect(result.data.presigned_url).toContain(result.data.upload_id);
    expect(result.data.object_uri).toContain(created.data.space_id === "" ? "" : "report.pdf");
    expect(uploads.snapshot()[0]).toMatchObject({ status: "issued", assetId: result.data.asset_id });
  });

  it("stores uploaded bytes, consumes session, and verifies claimed sha256", async () => {
    const spaces = new InMemoryKnowledgeSpaceStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const uploads = new InMemoryKnowledgeUploadSessionStore();
    const objects = new InMemoryKnowledgeObjectStore();
    const spaceService = new KnowledgeSpaceService({ spaces, audit });
    const created = await spaceService.createSpace(scope, { name: "Ops", createdBy: "user-1" });
    if (!created.ok) throw new Error("space create failed");
    const service = new KnowledgeUploadService({ spaces, uploads, objects, audit });
    const body = Buffer.from("content");
    const issued = await service.createUploadUrl(scope, {
      spaceId: created.data.space_id,
      filename: "report.pdf",
      sizeBytes: body.byteLength,
      sha256: sha256Hex(body),
      issuedBy: "user-1",
    });
    if (!issued.ok) throw new Error("upload issue failed");

    const uploaded = await service.putUploadedContent(scope, {
      uploadId: issued.data.upload_id,
      body,
      userId: "user-1",
      mimeType: "application/pdf",
    });

    expect(uploaded).toMatchObject({ ok: true, data: { status: "consumed", sha256: sha256Hex(body) } });
    expect(await objects.sha256(scope, issued.data.object_uri)).toBe(sha256Hex(body));
  });

  it("rejects upload content writes by non-owners in the same tenant with an indistinguishable NOT_FOUND", async () => {
    const spaces = new InMemoryKnowledgeSpaceStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const uploads = new InMemoryKnowledgeUploadSessionStore();
    const objects = new InMemoryKnowledgeObjectStore();
    const spaceService = new KnowledgeSpaceService({ spaces, audit });
    const created = await spaceService.createSpace(scope, { name: "Ops", createdBy: "user-1" });
    if (!created.ok) throw new Error("space create failed");
    const service = new KnowledgeUploadService({ spaces, uploads, objects, audit });
    const body = Buffer.from("content");
    const issued = await service.createUploadUrl(scope, {
      spaceId: created.data.space_id,
      filename: "report.pdf",
      sizeBytes: body.byteLength,
      sha256: sha256Hex(body),
      issuedBy: "user-1",
    });
    if (!issued.ok) throw new Error("upload issue failed");

    const forbidden = await service.putUploadedContent(scope, {
      uploadId: issued.data.upload_id,
      body,
      userId: "user-2",
    });

    expect(forbidden).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await objects.sha256(scope, issued.data.object_uri)).toBeNull();
  });

  it("rejects upload sessions for missing spaces", async () => {
    const service = new KnowledgeUploadService({
      spaces: new InMemoryKnowledgeSpaceStore(),
      uploads: new InMemoryKnowledgeUploadSessionStore(),
      audit: new InMemoryKnowledgeAuditEventWriter(),
    });

    expect(await service.createUploadUrl(scope, {
      spaceId: "space_missing",
      filename: "report.pdf",
      sizeBytes: 100,
      issuedBy: "user-1",
    })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
