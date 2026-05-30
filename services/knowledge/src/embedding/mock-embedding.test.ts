import { describe, expect, it } from "vitest";
import { MockEmbeddingAdapter } from "./mock-embedding.js";

describe("MockEmbeddingAdapter", () => {
  it("produces identical vectors for identical input text", async () => {
    const adapter = new MockEmbeddingAdapter();
    const first = await adapter.embedBatch({ texts: ["hello world"] });
    const second = await adapter.embedBatch({ texts: ["hello world"] });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(first.vectors[0]).toEqual(second.vectors[0]);
  });

  it("produces different vectors for different input text", async () => {
    const adapter = new MockEmbeddingAdapter();
    const result = await adapter.embedBatch({ texts: ["alpha", "beta"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.vectors[0]).not.toEqual(result.vectors[1]);
  });

  it("emits vectors whose length matches metadata.dimensions", async () => {
    const adapter = new MockEmbeddingAdapter();
    const result = await adapter.embedBatch({ texts: ["one", "two", "three"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.metadata.dimensions).toBe(64);
    for (const vector of result.vectors) {
      expect(vector).toHaveLength(adapter.metadata.dimensions);
    }
  });

  it("L2-normalizes vectors to unit length", async () => {
    const adapter = new MockEmbeddingAdapter();
    const result = await adapter.embedBatch({ texts: ["norm-check", "another"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const vector of result.vectors) {
      let sumSq = 0;
      for (const v of vector) sumSq += v * v;
      expect(Math.abs(Math.sqrt(sumSq) - 1)).toBeLessThan(1e-6);
    }
  });
});
