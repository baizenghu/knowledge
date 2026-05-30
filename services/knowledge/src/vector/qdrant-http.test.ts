import { describe, expect, it } from "vitest";
import { QdrantHttpAdapter } from "./qdrant-http.js";
import type { QdrantPoint, QdrantPointPayload } from "./qdrant-adapter.js";

function basePayload(overrides: Partial<QdrantPointPayload> = {}): QdrantPointPayload {
  return {
    source_system_id: "sys-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    document_id: "doc-1",
    document_version_id: "ver-1",
    document_version_number: 1,
    acl_hash: "acl-1",
    acl_version: 1,
    status: "active",
    deleted_at: null,
    tags: [],
    document_type: "markdown",
    time: "2026-05-18T00:00:00.000Z",
    chunk_index: 0,
    heading_path: [],
    page_start: null,
    page_end: null,
    ...overrides,
  };
}

type Call = { url: string; method: string; body?: unknown; headers: Record<string, string> };

function recordingFetch(
  responder: (call: Call) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    }
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: bodyText ? JSON.parse(bodyText) : undefined,
      headers,
    };
    calls.push(call);
    return responder(call);
  };
  return { fetchImpl, calls };
}

describe("QdrantHttpAdapter", () => {
  it("creates the collection when GET returns 404", async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === "GET") return new Response("missing", { status: 404 });
      if (call.method === "PUT") return new Response(JSON.stringify({ result: true }), { status: 200 });
      return new Response("nope", { status: 500 });
    });
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      apiKey: "secret",
      fetchImpl,
    });
    await adapter.ensureCollection(8);
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://qdrant.test/collections/chunks");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].url).toBe("http://qdrant.test/collections/chunks");
    expect(calls[1].body).toEqual({ vectors: { size: 8, distance: "Cosine" } });
    expect(calls[1].headers["api-key"]).toBe("secret");
  });

  it("skips creation when GET returns 200", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      fetchImpl,
    });
    await adapter.ensureCollection(8);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it("returns ok on 200 upsert", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 }));
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      fetchImpl,
    });
    const points: QdrantPoint[] = [
      { id: "p1", vector: [0.1, 0.2], payload: basePayload() },
    ];
    const result = await adapter.upsertPoints(points);
    expect(result).toEqual({ status: "ok", written: 1 });
  });

  it("flags 503 upsert as retryable failure", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("err", { status: 503 }));
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      fetchImpl,
    });
    const result = await adapter.upsertPoints([
      { id: "p1", vector: [0.1, 0.2], payload: basePayload() },
    ]);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("qdrant_http_503");
  });

  it("parses search hits from the result envelope", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response(
        JSON.stringify({
          result: [
            { id: "p1", score: 0.95, payload: basePayload({ document_id: "doc-a" }) },
            { id: "p2", score: 0.7, payload: basePayload({ document_id: "doc-b" }) },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      fetchImpl,
    });
    const hits = await adapter.searchByVector([1, 0], 2, {
      must: [{ key: "tenant_id", match: { value: "tenant-1" } }],
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "p1", score: 0.95 });
    expect(hits[0].payload.document_id).toBe("doc-a");
    expect(calls[0].url).toBe("http://qdrant.test/collections/chunks/points/search");
    expect(calls[0].body).toMatchObject({
      vector: [1, 0],
      limit: 2,
      with_payload: true,
      filter: { must: [{ key: "tenant_id", match: { value: "tenant-1" } }] },
    });
  });

  it("returns failure with reason containing 'timeout' when fetch is aborted", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      timeoutMs: 5,
      fetchImpl,
    });
    const result = await adapter.upsertPoints([
      { id: "p1", vector: [0.1, 0.2], payload: basePayload() },
    ]);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("timeout");
    expect(result.retryable).toBe(true);
  });

  it("setPayloadByFilter counts matches then issues POST /points/payload", async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith("/points/count")) {
        return new Response(JSON.stringify({ result: { count: 7 } }), { status: 200 });
      }
      if (call.url.endsWith("/points/payload")) {
        return new Response(JSON.stringify({ result: { operation_id: 1, status: "acknowledged" } }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    });
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      fetchImpl,
    });
    const updated = await adapter.setPayloadByFilter(
      { status: "active" },
      { must: [{ key: "document_version_id", match: { value: "ver-2" } }] },
    );
    expect(updated).toBe(7);
    expect(calls.map((c) => c.url)).toEqual([
      "http://qdrant.test/collections/chunks/points/count",
      "http://qdrant.test/collections/chunks/points/payload",
    ]);
    expect(calls[1].body).toMatchObject({
      payload: { status: "active" },
      filter: { must: [{ key: "document_version_id", match: { value: "ver-2" } }] },
    });
  });

  it("uses count API before delete to report removed count", async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith("/points/count")) {
        return new Response(JSON.stringify({ result: { count: 3 } }), { status: 200 });
      }
      if (call.url.endsWith("/points/delete")) {
        return new Response(JSON.stringify({ result: { operation_id: 42, status: "acknowledged" } }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    });
    const adapter = new QdrantHttpAdapter({
      endpoint: "http://qdrant.test",
      collectionName: "chunks",
      fetchImpl,
    });
    const removed = await adapter.deleteByFilter({
      must: [{ key: "acl_hash", match: { value: "stale" } }],
    });
    expect(removed).toBe(3);
    expect(calls.map((c) => c.url)).toEqual([
      "http://qdrant.test/collections/chunks/points/count",
      "http://qdrant.test/collections/chunks/points/delete",
    ]);
    expect(calls[0].body).toMatchObject({ exact: true });
  });
});
