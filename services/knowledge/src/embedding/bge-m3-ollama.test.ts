import { describe, expect, it } from "vitest";
import { BgeM3OllamaAdapter } from "./bge-m3-ollama.js";

function makeVector(length: number): number[] {
  const out = new Array<number>(length);
  for (let i = 0; i < length; i += 1) out[i] = (i % 7) / 10;
  return out;
}

describe("BgeM3OllamaAdapter", () => {
  it("returns ok with vectors when ollama responds with 1024-dim embeddings", async () => {
    const adapter = new BgeM3OllamaAdapter({
      endpoint: "http://ollama.test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ embedding: makeVector(1024) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await adapter.embedBatch({ texts: ["hello", "world"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(1024);
    expect(result.metadata).toEqual({ model: "bge-m3", version: "ollama", dimensions: 1024 });
  });

  it("flags dimension mismatch as retryable failure", async () => {
    const adapter = new BgeM3OllamaAdapter({
      endpoint: "http://ollama.test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ embedding: makeVector(512) }), { status: 200 }),
    });
    const result = await adapter.embedBatch({ texts: ["hi"] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("dimension");
  });

  it("flags 5xx as retryable failure", async () => {
    const adapter = new BgeM3OllamaAdapter({
      endpoint: "http://ollama.test",
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });
    const result = await adapter.embedBatch({ texts: ["hi"] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("ollama_http_503");
  });

  it("reports embedding_timeout when fetch is aborted", async () => {
    const adapter = new BgeM3OllamaAdapter({
      endpoint: "http://ollama.test",
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const result = await adapter.embedBatch({ texts: ["hi"] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("embedding_timeout");
    expect(result.retryable).toBe(true);
  });
});
