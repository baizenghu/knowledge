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

describe("GET /v1/jobs/:job_id/events (SSE)", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  it("404s for an unknown job before opening the stream", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);
    const res = await client.fetch("GET", "/v1/jobs/job_does_not_exist/events");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as { ok: boolean; error?: { code?: string } };
    expect(body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("emits a status frame then done for an already-terminal job", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);
    const { jobId } = await ingestAndDrain(client, runtime, "terminal-first content");

    const res = await client.fetch("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSseUntilDone(res, 5_000);
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[statuses.length - 1]).toMatchObject({ jobId, status: "succeeded" });
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("pushes a fresh DB state when the JobsHub pings (live transition)", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);
    const { jobId } = await ingest(client, "live-transition content");

    // Open the stream while the job is still queued, then drive the worker so
    // the store emits a hub ping → endpoint re-reads DB and pushes succeeded.
    const res = await client.fetch("GET", `/v1/jobs/${encodeURIComponent(jobId)}/events`);
    expect(res.status).toBe(200);

    const collected = readSseUntilDone(res, 5_000);
    // Give the first frame a tick to flush, then transition.
    await new Promise((r) => setTimeout(r, 50));
    await runtime.worker.runOnce();

    const events = await collected;
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses[0]).toMatchObject({ jobId, status: "queued" });
    expect(statuses[statuses.length - 1]).toMatchObject({ jobId, status: "succeeded" });
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  async function listen(app: ReturnType<typeof createKnowledgeRuntime>["app"]): Promise<string> {
    server = await new Promise<Server>((resolve) => {
      const active = app.listen(0, "127.0.0.1", () => resolve(active));
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

async function ingest(client: ReturnType<typeof createSignedClient>, content: string): Promise<{ jobId: string; documentId: string; spaceId: string }> {
  const space = await client.json("POST", "/v1/spaces", { type: "enterprise", name: "Events KB" });
  const spaceId = space.body.data.space_id as string;
  const uploadBody = Buffer.from(content);
  const upload = await client.json("POST", "/v1/assets/upload-url", {
    space_id: spaceId,
    filename: "doc.txt",
    mime_type: "text/plain",
    size_bytes: uploadBody.byteLength,
    sha256: sha256Hex(uploadBody),
  });
  const uploadId = upload.body.data.upload_id as string;
  await client.json("PUT", `/v1/assets/uploads/${encodeURIComponent(uploadId)}/content`, uploadBody, "application/octet-stream");
  const res = await client.json("POST", "/v1/documents/ingest", {
    space_id: spaceId,
    title: "Doc",
    source: { type: "upload", upload_id: uploadId, filename: "doc.txt", sha256: sha256Hex(uploadBody) },
  });
  return { jobId: res.body.data.job_id as string, documentId: res.body.data.document_id as string, spaceId };
}

async function ingestAndDrain(
  client: ReturnType<typeof createSignedClient>,
  runtime: ReturnType<typeof createKnowledgeRuntime>,
  content: string,
): Promise<{ jobId: string; documentId: string }> {
  const { jobId, documentId } = await ingest(client, content);
  await runtime.worker.runOnce();
  return { jobId, documentId };
}

type SseEvent = { type?: string; jobId?: string; status?: string; [k: string]: unknown };

/** Read the streaming SSE body, parsing `data:` frames until a `done` event or timeout. */
async function readSseUntilDone(res: Response, timeoutMs: number): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const body = res.body;
  if (!body) return events;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue; // skip `: heartbeat` comments
          const json = line.slice("data:".length).trim();
          if (!json) continue;
          try {
            events.push(JSON.parse(json) as SseEvent);
          } catch {
            // ignore non-JSON payloads
          }
        }
      }
      if (events.some((e) => e.type === "done")) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

function createSignedClient(baseUrl: string) {
  let nonceCounter = 0;
  const buildHeaders = (method: string, path: string, payload: Buffer, contentType?: string): Record<string, string> => {
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
    if (contentType) headers["content-type"] = contentType;
    headers["x-octopus-signature"] = signKnowledgeRequest({ method, path, body: payload, headers }, config.serviceToken);
    return headers;
  };
  return {
    /** Raw fetch (used for SSE / non-JSON responses). */
    async fetch(method: string, path: string): Promise<Response> {
      const headers = buildHeaders(method, path, Buffer.alloc(0));
      return fetch(`${baseUrl}${path}`, { method, headers });
    },
    /** JSON request helper mirroring app.test.ts. */
    async json(method: string, path: string, body?: unknown, contentType = "application/json") {
      const payload = Buffer.isBuffer(body)
        ? body
        : body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body));
      const headers = buildHeaders(method, path, payload, body === undefined ? undefined : contentType);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : payload,
      });
      return { status: response.status, body: (await response.json()) as any };
    },
  };
}
