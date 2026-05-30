import { describe, expect, it } from "vitest";
import { createKnowledgeRuntime } from "./runtime.js";
import { sha256Hex } from "./repositories/object-store.js";

const config = {
  port: 8080,
  serviceToken: "test-token",
  clockSkewMs: 300_000,
  nonceTtlMs: 600_000,
};
const scope = { sourceSystemId: "octopus", tenantId: "tenant-default" };

describe("createKnowledgeRuntime", () => {
  it("shares stores between app services and worker processors", async () => {
    const runtime = createKnowledgeRuntime(config);
    await runtime.stores.spaces.create({
      ...scope,
      spaceId: "space_1",
      type: "enterprise",
      name: "Ops",
      ownerType: "tenant",
      ownerId: "tenant-default",
      defaultAcl: { read: [{ type: "tenant", id: "tenant-default" }], write: [], admin: [] },
      status: "active",
      createdBy: "user-1",
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    });
    const body = Buffer.from("runtime document");
    const objectUri = "mem://octopus-knowledge/octopus/tenant-default/raw/doc.txt";
    const object = await runtime.stores.objects.put(scope, objectUri, body);
    await runtime.stores.uploads.create({
      ...scope,
      uploadId: "upload_runtime",
      spaceId: "space_1",
      assetId: "asset_runtime",
      objectUri,
      filename: "doc.txt",
      mimeType: "text/plain",
      sizeBytes: body.byteLength,
      claimedSha256: sha256Hex(body),
      actualSha256: sha256Hex(body),
      status: "consumed",
      issuedBy: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { KnowledgeDocumentService } = await import("./services/document-service.js");
    const service = new KnowledgeDocumentService({
      documents: runtime.stores.documents,
      versions: runtime.stores.versions,
      jobs: runtime.stores.jobs,
      idempotency: runtime.stores.idempotency,
      audit: runtime.stores.audit,
      spaces: runtime.stores.spaces,
      acl: runtime.stores.acl,
      uploads: runtime.stores.uploads,
      objects: runtime.stores.objects,
    });
    const ingest = await service.ingest(scope, {
      spaceId: "space_1",
      sourceType: "object_uri",
      sourceUri: object.uri,
      sourceSha256: sha256Hex(body),
      createdBy: "user-1",
    });
    if (!ingest.ok) throw new Error("ingest failed");

    await runtime.worker.runOnce();

    expect(await runtime.stores.documents.get(scope, ingest.data.document_id))
      .toMatchObject({ status: "searchable", visibilityStatus: "visible" });
    expect(await runtime.stores.jobs.get(scope, ingest.data.job_id))
      .toMatchObject({ status: "succeeded" });
  });

  it("worker claims queued jobs across tenants", async () => {
    const runtime = createKnowledgeRuntime(config);
    const tenantA = { sourceSystemId: "octopus", tenantId: "tenant-a" };
    await runtime.stores.spaces.create({
      ...tenantA,
      spaceId: "space_a",
      type: "enterprise",
      name: "Tenant A",
      ownerType: "tenant",
      ownerId: "tenant-a",
      defaultAcl: { read: [{ type: "tenant", id: "tenant-a" }], write: [], admin: [] },
      status: "active",
      createdBy: "user-a",
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    });
    const bodyA = Buffer.from("tenant-a document");
    const objectUriA = "mem://octopus-knowledge/octopus/tenant-a/raw/doc.txt";
    const objectA = await runtime.stores.objects.put(tenantA, objectUriA, bodyA);
    await runtime.stores.uploads.create({
      ...tenantA,
      uploadId: "upload_tenant_a",
      spaceId: "space_a",
      assetId: "asset_tenant_a",
      objectUri: objectUriA,
      filename: "doc.txt",
      mimeType: "text/plain",
      sizeBytes: bodyA.byteLength,
      claimedSha256: sha256Hex(bodyA),
      actualSha256: sha256Hex(bodyA),
      status: "consumed",
      issuedBy: "user-a",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { KnowledgeDocumentService } = await import("./services/document-service.js");
    const service = new KnowledgeDocumentService({
      documents: runtime.stores.documents,
      versions: runtime.stores.versions,
      jobs: runtime.stores.jobs,
      idempotency: runtime.stores.idempotency,
      audit: runtime.stores.audit,
      spaces: runtime.stores.spaces,
      acl: runtime.stores.acl,
      uploads: runtime.stores.uploads,
      objects: runtime.stores.objects,
    });
    const ingest = await service.ingest(tenantA, {
      spaceId: "space_a",
      sourceType: "object_uri",
      sourceUri: objectA.uri,
      sourceSha256: sha256Hex(bodyA),
      createdBy: "user-a",
    });
    if (!ingest.ok) throw new Error("tenant-a ingest failed");

    await runtime.worker.runOnce();

    expect(await runtime.stores.documents.get(tenantA, ingest.data.document_id))
      .toMatchObject({ status: "searchable", visibilityStatus: "visible" });
  });
});
