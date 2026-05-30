import type {
  LLMAdapter,
  LLMFinishReason,
  LLMMetadata,
  LLMRequest,
  LLMResponse,
} from "./llm-adapter.js";

export type OpenAICompatibleLLMAdapterOptions = {
  endpoint: string;
  apiKey: string;
  model: string;
  provider?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type OpenAIChoice = {
  message?: { content?: unknown };
  finish_reason?: unknown;
};

type OpenAIChatResponse = {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
};

/**
 * Adapter for OpenAI-compatible chat completion endpoints. MiniMax (and most
 * private vLLM deployments) expose an OpenAI-compatible /v1/chat/completions
 * route. The API key travels in the Authorization header only and is never
 * written into the body or surfaced in error reasons.
 */
export class OpenAICompatibleLLMAdapter implements LLMAdapter {
  readonly metadata: LLMMetadata;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleLLMAdapterOptions) {
    if (!options.endpoint) throw new Error("OpenAICompatibleLLMAdapter requires endpoint");
    if (!options.apiKey) throw new Error("OpenAICompatibleLLMAdapter requires apiKey");
    if (!options.model) throw new Error("OpenAICompatibleLLMAdapter requires model");
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.metadata = {
      provider: options.provider ?? "minimax",
      model: options.model,
    };
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (request.signal?.aborted) {
      return { status: "failed", reason: "aborted", retryable: false };
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onExternalAbort);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.metadata.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
      };
      if (typeof request.temperature === "number") body["temperature"] = request.temperature;
      if (typeof request.maxTokens === "number") body["max_tokens"] = request.maxTokens;
      if (Array.isArray(request.stop) && request.stop.length > 0) body["stop"] = request.stop;

      const response = await this.fetchImpl(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        return {
          status: "failed",
          reason: `llm_http_${status}`,
          retryable: status >= 500 || status === 429,
        };
      }
      const raw = (await response.json()) as OpenAIChatResponse;
      const choice = raw.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") {
        return { status: "failed", reason: "llm_invalid_response", retryable: false };
      }
      const finishReason = mapFinishReason(choice?.finish_reason);
      const promptTokens = toNumberOrUndefined(raw.usage?.prompt_tokens);
      const completionTokens = toNumberOrUndefined(raw.usage?.completion_tokens);
      const usage = promptTokens !== undefined || completionTokens !== undefined
        ? { promptTokens, completionTokens }
        : undefined;
      return {
        status: "ok",
        text: content,
        finishReason,
        ...(usage ? { usage } : {}),
        metadata: this.metadata,
      };
    } catch (error) {
      if (request.signal?.aborted) {
        return { status: "failed", reason: "aborted", retryable: false };
      }
      const aborted = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      // Defensive: never leak the API key into error text, even if a stray
      // implementation echoed Authorization back. Truncate + redact.
      const safeMessage = redact(message, this.apiKey).slice(0, 200);
      return {
        status: "failed",
        reason: aborted ? "llm_timeout" : `llm_error:${safeMessage}`,
        retryable: aborted || /ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(message),
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function mapFinishReason(raw: unknown): LLMFinishReason {
  switch (raw) {
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "content_filter";
    default: return "other";
  }
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function redact(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("[redacted]");
}
