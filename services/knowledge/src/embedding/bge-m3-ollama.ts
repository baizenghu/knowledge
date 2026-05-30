import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedBatchSuccess,
  EmbeddingAdapter,
  EmbeddingMetadata,
} from "./embedding-adapter.js";

export type BgeM3OllamaAdapterOptions = {
  endpoint: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  numCtx?: number;
  maxInputChars?: number;
};

type OllamaEmbeddingResponse = {
  embedding?: unknown;
};

const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_CONCURRENCY = 4;
// bge-m3 原生上下文 8192；Ollama 默认只按 4096 加载，必须显式传 num_ctx 才用满，
// 否则较长 chunk 会触发 "input length exceeds the context length" → HTTP 500。
const DEFAULT_NUM_CTX = 8192;
// 兜底硬截断：纯中文最坏 1 char≈1 token，留足余量截到 ~7000 字符（< 8192），
// 保证任何漏网的超长输入也不会让 embedding 500（last resort，正常不该触发）。
const DEFAULT_MAX_INPUT_CHARS = 7000;

/**
 * Adapter for Ollama-hosted BGE-M3. Ollama's /api/embeddings endpoint is
 * single-prompt, so we fan out across the input batch with a small
 * concurrency limit. Errors are classified the same way the parser
 * adapters classify them: 5xx / timeout / network failures are retryable,
 * 4xx and shape mismatches are not (except dimension drift which we treat
 * as retryable since it usually indicates a model swap in progress).
 */
export class BgeM3OllamaAdapter implements EmbeddingAdapter {
  readonly metadata: EmbeddingMetadata;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly concurrency: number;
  private readonly numCtx: number;
  private readonly maxInputChars: number;

  constructor(options: BgeM3OllamaAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.model = options.model ?? "bge-m3";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.numCtx = Math.max(1, options.numCtx ?? DEFAULT_NUM_CTX);
    this.maxInputChars = Math.max(1, options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS);
    this.metadata = {
      model: this.model,
      version: "ollama",
      dimensions: DEFAULT_DIMENSIONS,
    };
  }

  async embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult> {
    if (input.signal?.aborted) {
      return { status: "failed", reason: "aborted", retryable: false };
    }
    const vectors: number[][] = new Array(input.texts.length);
    let cursor = 0;
    let failure: EmbedBatchResult | null = null;

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(this.concurrency, input.texts.length);
    for (let w = 0; w < workerCount; w += 1) {
      workers.push((async () => {
        while (true) {
          if (failure) return;
          const index = cursor;
          cursor += 1;
          if (index >= input.texts.length) return;
          const result = await this.embedOne(input.texts[index], input.signal);
          if (result.status !== "ok") {
            failure = failure ?? result;
            return;
          }
          vectors[index] = result.vector;
        }
      })());
    }
    await Promise.all(workers);
    if (failure) return failure;
    return { status: "ok", vectors, metadata: this.metadata } satisfies EmbedBatchSuccess;
  }

  private async embedOne(
    text: string,
    externalSignal: AbortSignal | undefined,
  ): Promise<
    | { status: "ok"; vector: number[] }
    | { status: "failed"; reason: string; retryable: boolean }
  > {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // 用满 bge-m3 8192 上下文；并对超长输入硬截断兜底，确保不触发上下文超限 500。
      const safeText = text.length > this.maxInputChars ? text.slice(0, this.maxInputChars) : text;
      const response = await this.fetchImpl(`${this.endpoint}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: safeText, options: { num_ctx: this.numCtx } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: "failed",
          reason: `ollama_http_${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      const raw = (await response.json()) as OllamaEmbeddingResponse;
      if (!Array.isArray(raw.embedding) || !raw.embedding.every((v) => typeof v === "number")) {
        return {
          status: "failed",
          reason: "ollama_invalid_response",
          retryable: false,
        };
      }
      const vector = raw.embedding as number[];
      if (vector.length !== this.metadata.dimensions) {
        return {
          status: "failed",
          reason: `embedding_dimension_mismatch:expected_${this.metadata.dimensions}_got_${vector.length}`,
          retryable: true,
        };
      }
      return { status: "ok", vector };
    } catch (error) {
      if (externalSignal?.aborted) {
        return { status: "failed", reason: "aborted", retryable: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted;
      return {
        status: "failed",
        reason: aborted ? "embedding_timeout" : `ollama_error:${message.slice(0, 200)}`,
        retryable: aborted || /ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(message),
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
