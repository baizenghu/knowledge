/**
 * Phase C admin routes — supertest-style HTTP coverage.
 *
 * What's covered:
 *   - non-admin → 403 FORBIDDEN on every endpoint
 *   - knowledge_admin → 200 happy-paths
 *   - purge `confirm_name` mismatch → 400 NAME_MISMATCH
 *   - cleanup-retry single target and 'all'
 *   - gc/run returns a GCRunResult
 *   - audit cleanup-failures lists previously-written failure events
 */
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signKnowledgeRequest } from "@octopus/knowledge-contracts";
import { createKnowledgeRuntime } from "../runtime.js";

const config = {
  port: 0,
  serviceToken: "test-token",
  sourceSystemId: "octopus",
  clockSkewMs: 300_000,
  nonceTtlMs: 600_000,
};

const TENANT = "tenant-1";

describe("admin maintenance HTTP routes", () => {
  let server: Server | null = null;
  let runtime: ReturnType<typeof createKnowledgeRuntime>;
  let baseUrl = "";

  beforeEach(async () => {
    runtime = createKnowledgeRuntime(config);
    server = await new Promise<Server>((resolve) => {
      const active = runtime.app.listen(0, "127.0.0.1", () => resolve(active));
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      server = null;
    }
  });

  // Seed a soft-deleted space via direct store access, bypassing the public HTTP API.
  async function seedDeletedSpace(spaceId: string, name: string, opts: { failedTarget?: "qdrant" | "fulltext" | "object_storage" } = {}) {
    const now = new Date();
    await runtime.stores.spaces.create({
      sourceSystemId: "octopus",
      tenantId: TENANT,
      spaceId,
      type: "personal",
      name,
      description: null,
      ownerType: "user",
      ownerId: "user-admin",
      defaultAcl: {},
      status: "deleted",
      createdBy: "user-admin",
      updatedBy: "user-admin",
      deletedAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      createdAt: now,
      updatedAt: now,
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
      cleanupQdrantAttempts: 0,
      cleanupFulltextAttempts: 0,
      cleanupObjectStorageAttempts: 0,
    });
    if (opts.failedTarget) {
      await runtime.stores.spaces.setCleanupStatus({ sourceSystemId: "octopus", tenantId: TENANT }, spaceId, {
        target: opts.failedTarget,
        status: "failed",
        errorCode: "TEST_FAILURE",
        errorMessage: "seeded failure",
        incrementAttempts: true,
        nextRunAt: null,
      });
    }
  }

  it("rejects non-admin callers with 403 on every admin endpoint", async () => {
    const client = makeClient({ roles: "knowledge_editor" });
    const endpoints: Array<[string, string, unknown?]> = [
      ["GET", "/v1/admin/spaces/deleted"],
      ["GET", "/v1/admin/spaces/deleted/space-x"],
      ["POST", "/v1/admin/spaces/space-x/restore", {}],
      ["POST", "/v1/admin/spaces/space-x/purge", { confirm_name: "x" }],
      ["POST", "/v1/admin/spaces/space-x/cleanup-retry", { target: "qdrant" }],
      ["GET", "/v1/admin/gc/status"],
      ["POST", "/v1/admin/gc/run", {}],
      ["GET", "/v1/admin/audit/cleanup-failures"],
    ];
    for (const [method, path, body] of endpoints) {
      const res = await client.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("lists deleted spaces with cleanup_status detail", async () => {
    await seedDeletedSpace("space-a", "Alpha");
    await seedDeletedSpace("space-b", "Beta", { failedTarget: "qdrant" });
    const admin = makeClient({ roles: "knowledge_admin" });
    const list = await admin.request("GET", "/v1/admin/spaces/deleted");
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBeGreaterThanOrEqual(2);
    const beta = list.body.data.items.find((s: { space_id: string }) => s.space_id === "space-b");
    expect(beta).toBeDefined();
    expect(beta.cleanup_status.qdrant.status).toBe("failed");
    expect(beta.cleanup_status.qdrant.error_code).toBe("TEST_FAILURE");
  });

  it("restore flips status back to active and makes the space visible to public list", async () => {
    await seedDeletedSpace("space-r", "Recover me");
    await runtime.stores.documents.create({
      sourceSystemId: "octopus",
      tenantId: TENANT,
      documentId: "doc-r",
      spaceId: "space-r",
      title: "Recovered document",
      documentType: "pdf",
      status: "deleted",
      visibilityStatus: "deleted",
      currentVersionId: null,
      currentVersionNumber: null,
      aclHash: "acl_test",
      aclVersion: 1,
      sourceSha256: "a".repeat(64),
      sourceFilename: "r.pdf",
      createdBy: "user-admin",
      deletedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const admin = makeClient({ roles: "knowledge_admin" });
    const restore = await admin.request("POST", "/v1/admin/spaces/space-r/restore", {});
    expect(restore.status).toBe(200);
    expect(restore.body.data.status).toBe("active");
    const restoredDoc = await runtime.stores.documents.get({ sourceSystemId: "octopus", tenantId: TENANT }, "doc-r");
    expect(restoredDoc?.status).toBe("searchable");
    expect(restoredDoc?.visibilityStatus).toBe("visible");

    // public list (knowledge_editor scope) now sees it
    const editor = makeClient({ roles: "knowledge_editor" });
    const publicList = await editor.request("GET", "/v1/spaces");
    expect(publicList.status).toBe(200);
    const ids = (publicList.body.data.items as Array<{ space_id: string }>).map((s) => s.space_id);
    expect(ids).toContain("space-r");
  });

  it("purge rejects NAME_MISMATCH and succeeds with the correct name", async () => {
    await seedDeletedSpace("space-p", "ImportantSpace");
    const admin = makeClient({ roles: "knowledge_admin" });
    const bad = await admin.request("POST", "/v1/admin/spaces/space-p/purge", { confirm_name: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details?.code).toBe("NAME_MISMATCH");

    const ok = await admin.request("POST", "/v1/admin/spaces/space-p/purge", { confirm_name: "ImportantSpace" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.space_id).toBe("space-p");
    expect(ok.body.data.counts.space).toBe(true);

    // Space truly gone from store now.
    const after = await runtime.stores.spaces.getIncludeDeleted({ sourceSystemId: "octopus", tenantId: TENANT }, "space-p");
    expect(after).toBeNull();
  });

  it("cleanup-retry runs single target and 'all'", async () => {
    await seedDeletedSpace("space-c", "CleanupMe", { failedTarget: "qdrant" });
    const admin = makeClient({ roles: "knowledge_admin" });

    const single = await admin.request("POST", "/v1/admin/spaces/space-c/cleanup-retry", { target: "qdrant" });
    expect(single.status).toBe(200);
    expect(single.body.data.target).toBe("qdrant");
    // Note: failed target's retry path requires status pending/running (P0-3). Per worker semantics,
    // it will NOT re-run a 'failed' target; status stays 'failed'. So just assert the endpoint shape.
    expect(single.body.data.status_after).toHaveProperty("qdrant");
    expect(single.body.data.status_after).toHaveProperty("fulltext");
    expect(single.body.data.status_after).toHaveProperty("object_storage");

    const all = await admin.request("POST", "/v1/admin/spaces/space-c/cleanup-retry", { target: "all" });
    expect(all.status).toBe(200);
    expect(all.body.data.target).toBe("all");
  });

  it("cleanup-retry rejects active spaces to avoid deleting live external resources", async () => {
    await runtime.stores.spaces.create({
      sourceSystemId: "octopus",
      tenantId: TENANT,
      spaceId: "space-live",
      type: "personal",
      name: "Live",
      description: null,
      ownerType: "user",
      ownerId: "u",
      defaultAcl: {},
      status: "active",
      createdBy: "u",
      updatedBy: "u",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const admin = makeClient({ roles: "knowledge_admin" });
    const res = await admin.request("POST", "/v1/admin/spaces/space-live/cleanup-retry", { target: "all" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("gc/run returns GCRunResult shape", async () => {
    await seedDeletedSpace("space-g", "GCMe");
    const admin = makeClient({ roles: "knowledge_admin" });
    const res = await admin.request("POST", "/v1/admin/gc/run", {});
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("status");
    expect(res.body.data).toHaveProperty("spaces_purged");
    expect(res.body.data).toHaveProperty("spaces_failed");
    expect(res.body.data).toHaveProperty("retries_processed");
  });

  it("gc/run rejects a body scope for another tenant", async () => {
    const admin = makeClient({ roles: "knowledge_admin" });
    const res = await admin.request("POST", "/v1/admin/gc/run", {
      scope: { sourceSystemId: "octopus", tenantId: "tenant-other" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("audit cleanup-failures lists previously-written failure events", async () => {
    await runtime.stores.audit.write({
      sourceSystemId: "octopus",
      tenantId: TENANT,
      action: "space.purge_failed",
      resourceType: "knowledge_space",
      resourceId: "space-x",
      success: false,
      errorCode: "BOOM",
      details: { reason: "explicit" },
    });
    await runtime.stores.audit.write({
      sourceSystemId: "octopus",
      tenantId: TENANT,
      action: "space.soft_delete", // should NOT appear
      resourceType: "knowledge_space",
      resourceId: "space-x",
      success: true,
    });

    const admin = makeClient({ roles: "knowledge_admin" });
    const list = await admin.request("GET", "/v1/admin/audit/cleanup-failures");
    expect(list.status).toBe(200);
    const actions = list.body.data.items.map((i: { action: string }) => i.action);
    expect(actions).toContain("space.purge_failed");
    expect(actions).not.toContain("space.soft_delete");
  });

  it("gc/status returns last_run_at after a run", async () => {
    const admin = makeClient({ roles: "knowledge_admin" });
    await admin.request("POST", "/v1/admin/gc/run", {});
    const status = await admin.request("GET", "/v1/admin/gc/status");
    expect(status.status).toBe(200);
    expect(status.body.data.last_run_at).not.toBeNull();
    expect(status.body.data.last_run_result).toHaveProperty("status");
  });

  it("recycle-bin single-space endpoint returns 404 when space is active", async () => {
    // create active space directly
    await runtime.stores.spaces.create({
      sourceSystemId: "octopus",
      tenantId: TENANT,
      spaceId: "space-active",
      type: "personal",
      name: "Active",
      description: null,
      ownerType: "user",
      ownerId: "u",
      defaultAcl: {},
      status: "active",
      createdBy: "u",
      updatedBy: "u",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const admin = makeClient({ roles: "knowledge_admin" });
    const res = await admin.request("GET", "/v1/admin/spaces/deleted/space-active");
    expect(res.status).toBe(404);
  });

  // ----- signed client helper -----
  function makeClient(opts: { roles: string }) {
    let nonceCounter = 0;
    return {
      async request(method: string, path: string, body?: unknown) {
        const payload =
          body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
        const headers: Record<string, string> = {
          authorization: `Bearer ${config.serviceToken}`,
          "x-octopus-source-system": "octopus",
          "x-octopus-tenant": TENANT,
          "x-octopus-user": "user-admin",
          "x-octopus-departments": "",
          "x-octopus-roles": opts.roles,
          "x-octopus-timestamp": new Date().toISOString(),
          "x-octopus-nonce": `admin-nonce-${++nonceCounter}-${Math.random()}`,
        };
        if (body !== undefined) headers["content-type"] = "application/json";
        headers["x-octopus-signature"] = signKnowledgeRequest(
          { method, path, body: payload, headers },
          config.serviceToken,
        );
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : payload,
        });
        return { status: response.status, body: (await response.json()) as any };
      },
    };
  }
});
