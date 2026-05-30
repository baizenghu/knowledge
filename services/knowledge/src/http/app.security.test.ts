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

describe("knowledge HTTP security negative paths", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  });

  it("rejects requests with a wrong HMAC signature", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl, "user-1");

    const tampered = await client.request("POST", "/v1/spaces", { name: "Ops" }, {
      tamperSignature: true,
    });

    expect(tampered.status).toBe(401);
    expect(tampered.body).toMatchObject({ ok: false });
  });

  it("returns NOT_FOUND when another tenant user PUTs to someone else's upload session", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const owner = createSignedClient(baseUrl, "user-1");
    const intruder = createSignedClient(baseUrl, "user-2");

    const space = await owner.request("POST", "/v1/spaces", { name: "Ops" });
    expect(space.status).toBe(201);

    const body = Buffer.from("owner content");
    const issued = await owner.request("POST", "/v1/assets/upload-url", {
      space_id: space.body.data.space_id,
      filename: "doc.txt",
      mime_type: "text/plain",
      size_bytes: body.byteLength,
      sha256: sha256Hex(body),
    });
    expect(issued.status).toBe(201);

    const put = await intruder.request(
      "PUT",
      `/v1/assets/uploads/${encodeURIComponent(issued.body.data.upload_id)}/content`,
      body,
      { contentType: "application/octet-stream" },
    );

    expect(put.status).toBe(404);
    expect(put.body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("returns CONTENT_HASH_MISMATCH when uploaded bytes do not match claimed sha256", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl, "user-1");

    const space = await client.request("POST", "/v1/spaces", { name: "Ops" });
    const body = Buffer.from("real content");
    const issued = await client.request("POST", "/v1/assets/upload-url", {
      space_id: space.body.data.space_id,
      filename: "doc.txt",
      mime_type: "text/plain",
      size_bytes: body.byteLength,
      sha256: sha256Hex(Buffer.from("claimed but never uploaded")),
    });

    const put = await client.request(
      "PUT",
      `/v1/assets/uploads/${encodeURIComponent(issued.body.data.upload_id)}/content`,
      body,
      { contentType: "application/octet-stream" },
    );

    expect(put.body).toMatchObject({ ok: false, error: { code: "CONTENT_HASH_MISMATCH" } });
  });

  it("rejects ingest by an objectUri that crosses tenant scope", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const tenantA = createSignedClient(baseUrl, "user-1", { tenantId: "tenant-a" });
    const tenantB = createSignedClient(baseUrl, "user-2", { tenantId: "tenant-b" });

    const space = await tenantA.request("POST", "/v1/spaces", { name: "A" });
    const body = Buffer.from("A's secret");
    const issued = await tenantA.request("POST", "/v1/assets/upload-url", {
      space_id: space.body.data.space_id,
      filename: "secret.txt",
      mime_type: "text/plain",
      size_bytes: body.byteLength,
      sha256: sha256Hex(body),
    });
    await tenantA.request(
      "PUT",
      `/v1/assets/uploads/${encodeURIComponent(issued.body.data.upload_id)}/content`,
      body,
      { contentType: "application/octet-stream" },
    );

    const spaceB = await tenantB.request("POST", "/v1/spaces", { name: "B" });
    const stolen = await tenantB.request("POST", "/v1/documents/ingest", {
      space_id: spaceB.body.data.space_id,
      source: {
        type: "object_uri",
        uri: issued.body.data.object_uri,
        sha256: sha256Hex(body),
      },
    });

    expect(stolen.body.ok).toBe(false);
  });

  it("replays idempotent ingest deterministically without creating a second document", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl, "user-1");

    const space = await client.request("POST", "/v1/spaces", { name: "Ops" });
    const body = Buffer.from("idempotent payload");
    const issued = await client.request("POST", "/v1/assets/upload-url", {
      space_id: space.body.data.space_id,
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

    const idemKey = "idem-key-fixed";
    const ingest1 = await client.request("POST", "/v1/documents/ingest", {
      space_id: space.body.data.space_id,
      source: {
        type: "upload",
        upload_id: issued.body.data.upload_id,
        filename: "doc.txt",
        sha256: sha256Hex(body),
      },
    }, { extraHeaders: { "idempotency-key": idemKey } });

    const ingest2 = await client.request("POST", "/v1/documents/ingest", {
      space_id: space.body.data.space_id,
      source: {
        type: "upload",
        upload_id: issued.body.data.upload_id,
        filename: "doc.txt",
        sha256: sha256Hex(body),
      },
    }, { extraHeaders: { "idempotency-key": idemKey } });

    expect(ingest1.body.data.document_id).toBe(ingest2.body.data.document_id);
    expect(ingest1.body.data.job_id).toBe(ingest2.body.data.job_id);
    expect(ingest2.body.meta?.replayed).toBe(true);
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
      reqOptions: { contentType?: string; tamperSignature?: boolean; extraHeaders?: Record<string, string> } = {},
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
      if (reqOptions.tamperSignature) {
        headers["x-octopus-signature"] = headers["x-octopus-signature"].split("").reverse().join("");
      }
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
