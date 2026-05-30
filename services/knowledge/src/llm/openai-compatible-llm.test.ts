import { describe, expect, it } from "vitest";
import { OpenAICompatibleLLMAdapter } from "./openai-compatible-llm.js";

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAICompatibleLLMAdapter", () => {
  it("parses a 200 OK chat completion into ok status with text + finishReason", async () => {
    let observedAuth: string | null = null;
    let observedBody: string | null = null;
    const adapter = new OpenAICompatibleLLMAdapter({
      endpoint: "https://api.minimax.test/",
      apiKey: "sk-secret",
      model: "minimax-m2.7",
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        observedAuth = headers?.["authorization"] ?? null;
        observedBody = (init?.body as string) ?? null;
        return makeResponse({
          choices: [
            { message: { content: "hello from model" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        });
      },
    });
    const result = await adapter.generate({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      maxTokens: 64,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.text).toBe("hello from model");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 5 });
    expect(result.metadata).toEqual({ provider: "minimax", model: "minimax-m2.7" });
    expect(observedAuth).toBe("Bearer sk-secret");
    // API key must NOT appear in the request body.
    expect(observedBody).not.toContain("sk-secret");
  });

  it("maps finish_reason: length to finishReason: length", async () => {
    const adapter = new OpenAICompatibleLLMAdapter({
      endpoint: "https://api.minimax.test",
      apiKey: "sk-x",
      model: "m",
      fetchImpl: async () =>
        makeResponse({
          choices: [{ message: { content: "truncated" }, finish_reason: "length" }],
        }),
    });
    const result = await adapter.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.finishReason).toBe("length");
  });

  it("flags 503 as retryable failure", async () => {
    const adapter = new OpenAICompatibleLLMAdapter({
      endpoint: "https://api.minimax.test",
      apiKey: "sk-x",
      model: "m",
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });
    const result = await adapter.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("llm_http_503");
  });

  it("flags 401 as non-retryable failure", async () => {
    const adapter = new OpenAICompatibleLLMAdapter({
      endpoint: "https://api.minimax.test",
      apiKey: "sk-x",
      model: "m",
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    const result = await adapter.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toBe("llm_http_401");
    // API key must not leak into the reason field.
    expect(result.reason).not.toContain("sk-x");
  });

  it("reports llm_timeout (retryable) when the underlying fetch is aborted", async () => {
    const adapter = new OpenAICompatibleLLMAdapter({
      endpoint: "https://api.minimax.test",
      apiKey: "sk-x",
      model: "m",
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const result = await adapter.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("llm_timeout");
    expect(result.retryable).toBe(true);
  });
});
