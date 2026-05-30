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

describe("knowledge HTTP M2 flow", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  });

  it("creates a space, uploads content, ingests it, processes the job, and deletes the document", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);

    const space = await client.request("POST", "/v1/spaces", {
      type: "enterprise",
      name: "Ops Knowledge",
    });
    expect(space.status).toBe(201);
    expect(space.body.ok).toBe(true);
    const spaceId = space.body.data.space_id as string;

    const uploadBody = Buffer.from("m2 upload e2e content");
    const upload = await client.request("POST", "/v1/assets/upload-url", {
      space_id: spaceId,
      filename: "report.txt",
      mime_type: "text/plain",
      size_bytes: uploadBody.byteLength,
      sha256: sha256Hex(uploadBody),
    });
    expect(upload.status).toBe(201);
    expect(upload.body.ok).toBe(true);
    const uploadId = upload.body.data.upload_id as string;

    const put = await client.request("PUT", `/v1/assets/uploads/${encodeURIComponent(uploadId)}/content`, uploadBody, "application/octet-stream");
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ ok: true, data: { status: "consumed", sha256: sha256Hex(uploadBody) } });

    const ingest = await client.request("POST", "/v1/documents/ingest", {
      space_id: spaceId,
      title: "Report",
      source: {
        type: "upload",
        upload_id: uploadId,
        filename: "report.txt",
        sha256: sha256Hex(uploadBody),
      },
    });
    expect(ingest.status).toBe(202);
    expect(ingest.body.ok).toBe(true);
    const jobId = ingest.body.data.job_id as string;
    const documentId = ingest.body.data.document_id as string;

    const queued = await client.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    expect(queued.body).toMatchObject({ ok: true, data: { status: "queued", document_id: documentId } });

    await runtime.worker.runOnce();

    const succeeded = await client.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    expect(succeeded.body).toMatchObject({ ok: true, data: { status: "succeeded", document_id: documentId } });
    await expect(runtime.stores.documents.get({ sourceSystemId: "octopus", tenantId: "tenant-1" }, documentId))
      .resolves.toMatchObject({ status: "searchable", visibilityStatus: "visible" });

    const deleted = await client.request("DELETE", `/v1/documents/${encodeURIComponent(documentId)}`);
    expect(deleted.status).toBe(202);
    expect(deleted.body).toMatchObject({ ok: true, data: { document_id: documentId, status: "deleted" } });
  });

  async function listen(app: ReturnType<typeof createKnowledgeRuntime>["app"]): Promise<string> {
    server = await new Promise<Server>((resolve) => {
      const active = app.listen(0, "127.0.0.1", () => resolve(active));
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function createSignedClient(baseUrl: string) {
  let nonceCounter = 0;
  return {
    async request(method: string, path: string, body?: unknown, contentType = "application/json") {
      const payload = Buffer.isBuffer(body)
        ? body
        : body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string> = {
        authorization: `Bearer ${config.serviceToken}`,
        "x-octopus-source-system": "octopus",
        "x-octopus-tenant": "tenant-1",
        "x-octopus-user": "user-1",
        "x-octopus-departments": "",
        "x-octopus-roles": "knowledge_editor",
        "x-octopus-timestamp": new Date().toISOString(),
        "x-octopus-nonce": `nonce-${++nonceCounter}`,
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
