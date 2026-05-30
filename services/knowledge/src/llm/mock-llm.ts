import type {
  LLMAdapter,
  LLMMetadata,
  LLMRequest,
  LLMResponse,
} from "./llm-adapter.js";

const MAX_ECHO_CHARS = 200;

/**
 * Deterministic mock LLM. Echoes (a truncated form of) the last user message
 * back as the assistant response. Intended for unit tests and local dev paths
 * that need an LLM signal without contacting a real model server.
 */
export class MockLLMAdapter implements LLMAdapter {
  readonly metadata: LLMMetadata = {
    provider: "mock",
    model: "mock-llm-1",
  };

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (request.signal?.aborted) {
      return { status: "failed", reason: "aborted", retryable: false };
    }
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const content = (lastUser?.content ?? "").slice(0, MAX_ECHO_CHARS);
    const text = `[mock answer] ${content}`;
    const promptChars = request.messages.reduce((acc, m) => acc + m.content.length, 0);
    return {
      status: "ok",
      text,
      finishReason: "stop",
      usage: {
        promptTokens: Math.ceil(promptChars / 4),
        completionTokens: Math.ceil(text.length / 4),
      },
      metadata: this.metadata,
    };
  }
}
