import { describe, expect, it } from "vitest";
import { MockLLMAdapter } from "./mock-llm.js";

describe("MockLLMAdapter", () => {
  it("produces identical output for identical input", async () => {
    const adapter = new MockLLMAdapter();
    const req = {
      messages: [
        { role: "system" as const, content: "you are helpful" },
        { role: "user" as const, content: "hello world" },
      ],
    };
    const first = await adapter.generate(req);
    const second = await adapter.generate(req);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(first.text).toBe(second.text);
  });

  it("prefixes the response with [mock answer]", async () => {
    const adapter = new MockLLMAdapter();
    const result = await adapter.generate({
      messages: [{ role: "user", content: "ping" }],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.text.startsWith("[mock answer] ")).toBe(true);
    expect(result.text).toContain("ping");
    expect(result.finishReason).toBe("stop");
  });

  it("truncates the echoed user content to 200 characters", async () => {
    const adapter = new MockLLMAdapter();
    const longContent = "x".repeat(500);
    const result = await adapter.generate({
      messages: [{ role: "user", content: longContent }],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Prefix "[mock answer] " is 14 chars, then up to 200 chars echo.
    const echoed = result.text.slice("[mock answer] ".length);
    expect(echoed.length).toBeLessThanOrEqual(200);
    expect(echoed).toBe("x".repeat(200));
  });
});
