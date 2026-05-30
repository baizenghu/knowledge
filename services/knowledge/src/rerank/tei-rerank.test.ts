import { describe, expect, it } from "vitest";
import { TEIRerankerAdapter } from "./tei-rerank.js";

describe("TEIRerankerAdapter", () => {
  it("maps TEI response indices back to candidates with correct scores", async () => {
    const adapter = new TEIRerankerAdapter({
      endpoint: "http://tei.test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            { index: 2, score: 0.9 },
            { index: 0, score: 0.7 },
            { index: 1, score: 0.3 },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const result = await adapter.rerank({
      query: "q",
      candidates: [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
        { id: "c", text: "gamma", metadata: { foo: 1 } },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ranked).toHaveLength(3);
    expect(result.ranked[0]).toMatchObject({ id: "c", index: 2, score: 0.9, metadata: { foo: 1 } });
    expect(result.ranked[1]).toMatchObject({ id: "a", index: 0, score: 0.7 });
    expect(result.ranked[2]).toMatchObject({ id: "b", index: 1, score: 0.3 });
    expect(result.metadata).toEqual({ model: "bge-reranker-v2-m3", version: "tei" });
  });

  it("sorts response defensively when server returns unsorted data", async () => {
    const adapter = new TEIRerankerAdapter({
      endpoint: "http://tei.test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            { index: 0, score: 0.1 },
            { index: 1, score: 0.9 },
          ]),
          { status: 200 },
        ),
    });
    const result = await adapter.rerank({
      query: "q",
      candidates: [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ranked[0]?.index).toBe(1);
    expect(result.ranked[0]?.id).toBe("b");
    expect(result.ranked[1]?.index).toBe(0);
  });

  it("flags 503 as retryable failure", async () => {
    const adapter = new TEIRerankerAdapter({
      endpoint: "http://tei.test",
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });
    const result = await adapter.rerank({
      query: "q",
      candidates: [{ id: "a", text: "alpha" }],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("tei_http_503");
  });

  it("reports rerank_timeout when fetch is aborted", async () => {
    const adapter = new TEIRerankerAdapter({
      endpoint: "http://tei.test",
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const result = await adapter.rerank({
      query: "q",
      candidates: [{ id: "a", text: "alpha" }],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("rerank_timeout");
    expect(result.retryable).toBe(true);
  });
});
