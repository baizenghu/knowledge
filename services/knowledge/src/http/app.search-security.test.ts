import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { signKnowledgeRequest } from "@octopus/knowledge-contracts";
import { createKnowledgeRuntime } from "../runtime.js";
import { sha256Hex } from "../repositories/object-store.js";

const config = {
  port: 0,
  serviceToken: "test-token",
  sourceSystemId: "octopus",
  clockSkewMs: 300_000,
  nonceTtlMs: 600_000,
};

describe("knowledge /v1/search /v1/citations security", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  });

  /**
   * Run an ingest end-to-end and return enough context to drive search/citation
   * assertions: document id, space id, search query, and the search request
   * factory tied to a single tenant identity.
   */
  async function ingestSearchable(client: ReturnType<typeof createSignedClient>, runtime: ReturnType<typeof createKnowledgeRuntime>) {
    const space = await client.request("POST", "/v1/spaces", { name: "Ops" });
    expect(space.status).toBe(201);
    const spaceId = space.body.data.space_id as string;
    const body = Buffer.from("octopus deployment runbook how to scale workers safely\n");
    const issued = await client.request("POST", "/v1/assets/upload-url", {
      space_id: spaceId,
      filename: "doc.txt",
      mime_type: "text/plain",
      size_bytes: body.byteLength,
      sha256: sha256Hex(body),
    });
    await client.request(
      "PUT",
      `/v1/assets/uploads/${encodeURIComponent(issued.body.data.upload_id)}/content`,
      body,
      { contentType: "application/octet-stream" },
    );
    const ingest = await client.request("POST", "/v1/documents/ingest", {
      space_id: spaceId,
      title: "Runbook",
      source: { type: "upload", upload_id: issued.body.data.upload_id, filename: "doc.txt", sha256: sha256Hex(body) },
    });
    expect(ingest.status).toBe(202);
    await runtime.worker.runOnce();
    return { spaceId, documentId: ingest.body.data.document_id as string, query: "deployment runbook scale workers" };
  }

  it("returns empty items for an unprivileged user (no readable acl)", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const owner = createSignedClient(baseUrl, "user-1");
    const stranger = createSignedClient(baseUrl, "user-2", { tenantId: "tenant-2" });
    await ingestSearchable(owner, runtime);
    const search = await stranger.request("POST", "/v1/search", { query: "deployment" });
    expect(search.status).toBe(200);
    expect(search.body.data.items).toEqual([]);
  });

  it("returns 404 NOT_FOUND when reading a citation across tenants", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const owner = createSignedClient(baseUrl, "user-1");
    const intruder = createSignedClient(baseUrl, "user-2", { tenantId: "tenant-2" });
    const ctxA = await ingestSearchable(owner, runtime);
    const search = await owner.request("POST", "/v1/search", { query: ctxA.query });
    expect(search.body.data.items.length).toBeGreaterThan(0);
    const anchorId = search.body.data.items[0].anchor_id;
    const intrude = await intruder.request("GET", `/v1/citations/${encodeURIComponent(anchorId)}`);
    expect(intrude.status).toBe(404);
    expect(intrude.body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("does not surface a document after it is deleted", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const owner = createSignedClient(baseUrl, "user-1");
    const ctxA = await ingestSearchable(owner, runtime);
    const before = await owner.request("POST", "/v1/search", { query: ctxA.query });
    expect(before.body.data.items.length).toBeGreaterThan(0);
    const del = await owner.request("DELETE", `/v1/documents/${encodeURIComponent(ctxA.documentId)}`);
    expect(del.status).toBe(202);
    const after = await owner.request("POST", "/v1/search", { query: ctxA.query });
    expect(after.body.data.items.map((item: any) => item.document_id)).not.toContain(ctxA.documentId);
  });

  it("loses visibility once the document ACL is tightened (30s convergence)", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const owner = createSignedClient(baseUrl, "user-1");
    const ctxA = await ingestSearchable(owner, runtime);
    const before = await owner.request("POST", "/v1/search", { query: ctxA.query });
    expect(before.body.data.items.length).toBeGreaterThan(0);
    // Tighten the ACL to a role the searching user does not hold. The default
    // identity above has roles=[knowledge_editor], so restricting to "auditor"
    // should make the document invisible on the very next call.
    const tighten = await owner.request("PUT", `/v1/documents/${encodeURIComponent(ctxA.documentId)}/acl`, {
      acl: { read: [{ type: "role", id: "auditor" }], write: [], admin: [] },
    });
    expect(tighten.status).toBe(202);
    const after = await owner.request("POST", "/v1/search", { query: ctxA.query });
    expect(after.body.data.items.map((item: any) => item.document_id)).not.toContain(ctxA.documentId);
  });

  it("returns 404 for strictSpaceCheck against a non-existent space (no existence probe)", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl, "user-1");
    const search = await client.request("POST", "/v1/search", {
      query: "anything",
      space_ids: ["space_does_not_exist"],
      strict_space_check: true,
    });
    expect(search.status).toBe(404);
    expect(search.body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  async function listen(app: ReturnType<typeof createKnowledgeRuntime>["app"]): Promise<string> {
    server = await new Promise<Server>((resolve) => {
      const active = app.listen(0, "127.0.0.1", () => resolve(active));
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function createSignedClient(baseUrl: string, userId: string, options: { tenantId?: string } = {}) {
  const tenantId = options.tenantId ?? "tenant-1";
  let nonceCounter = 0;
  return {
    async request(
      method: string,
      path: string,
      body?: unknown,
      reqOptions: { contentType?: string; extraHeaders?: Record<string, string> } = {},
    ) {
      const contentType = reqOptions.contentType ?? "application/json";
      const payload = Buffer.isBuffer(body)
        ? body
        : body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string> = {
        authorization: `Bearer ${config.serviceToken}`,
        "x-octopus-source-system": "octopus",
        "x-octopus-tenant": tenantId,
        "x-octopus-user": userId,
        "x-octopus-departments": "",
        "x-octopus-roles": "knowledge_editor",
        "x-octopus-timestamp": new Date().toISOString(),
        "x-octopus-nonce": `nonce-${userId}-${++nonceCounter}`,
        ...(reqOptions.extraHeaders ?? {}),
      };
      if (body !== undefined) {
        headers["content-type"] = contentType;
      }
      headers["x-octopus-signature"] = signKnowledgeRequest({ method, path, body: payload, headers }, config.serviceToken);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : payload,
      });
      return {
        status: response.status,
        body: await response.json() as any,
      };
    },
  };
}
