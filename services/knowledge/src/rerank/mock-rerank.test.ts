import { describe, expect, it } from "vitest";
import { MockRerankerAdapter } from "./mock-rerank.js";

describe("MockRerankerAdapter", () => {
  it("is deterministic across repeated calls with identical input", async () => {
    const adapter = new MockRerankerAdapter();
    const input = {
      query: "hello world rerank",
      candidates: [
        { id: "a", text: "hello world" },
        { id: "b", text: "totally unrelated banana" },
        { id: "c", text: "rerank world" },
      ],
    };
    const first = await adapter.rerank(input);
    const second = await adapter.rerank(input);
    expect(first).toEqual(second);
  });

  it("returns score=1 when query and candidate text share all tokens", async () => {
    const adapter = new MockRerankerAdapter();
    const result = await adapter.rerank({
      query: "hello world",
      candidates: [{ id: "a", text: "hello world" }],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ranked[0]?.score).toBe(1);
  });

  it("returns score=0 when there is no token overlap", async () => {
    const adapter = new MockRerankerAdapter();
    const result = await adapter.rerank({
      query: "alpha beta",
      candidates: [{ id: "a", text: "gamma delta" }],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ranked[0]?.score).toBe(0);
  });

  it("honours topN and orders by score descending", async () => {
    const adapter = new MockRerankerAdapter();
    const result = await adapter.rerank({
      query: "alpha beta gamma",
      candidates: [
        { id: "low", text: "zzz" },
        { id: "mid", text: "alpha" },
        { id: "high", text: "alpha beta gamma" },
      ],
      topN: 2,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]?.id).toBe("high");
    expect(result.ranked[1]?.id).toBe("mid");
    expect(result.ranked[0]!.score).toBeGreaterThanOrEqual(result.ranked[1]!.score);
  });
});
