import type {
  RerankAdapter,
  RerankInput,
  RerankMetadata,
  RerankRankedItem,
  RerankResult,
} from "./rerank-adapter.js";

export type TEIRerankerAdapterOptions = {
  endpoint: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiKey?: string;
};

type TEIRerankResponseItem = {
  index?: unknown;
  score?: unknown;
};

/**
 * Adapter for a HuggingFace Text Embeddings Inference server hosting a
 * cross-encoder reranker (e.g. bge-reranker-v2-m3). Errors are classified
 * the same way as other HTTP adapters: 5xx/429/timeout/network are
 * retryable, 4xx and shape mismatches are not.
 */
export class TEIRerankerAdapter implements RerankAdapter {
  readonly metadata: RerankMetadata;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey?: string;

  constructor(options: TEIRerankerAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.model = options.model ?? "bge-reranker-v2-m3";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiKey = options.apiKey;
    this.metadata = { model: this.model, version: "tei" };
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    if (input.signal?.aborted) {
      return { status: "failed", reason: "aborted", retryable: false };
    }
    if (input.candidates.length === 0) {
      return { status: "ok", ranked: [], metadata: this.metadata };
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onExternalAbort);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(`${this.endpoint}/rerank`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: input.query,
          texts: input.candidates.map((c) => c.text),
          raw_scores: false,
          return_text: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: "failed",
          reason: `tei_http_${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      const raw = (await response.json()) as unknown;
      if (!Array.isArray(raw)) {
        return { status: "failed", reason: "tei_invalid_response", retryable: false };
      }
      const ranked: RerankRankedItem[] = [];
      for (const entry of raw as TEIRerankResponseItem[]) {
        const idx = entry?.index;
        const score = entry?.score;
        if (typeof idx !== "number" || typeof score !== "number") {
          return { status: "failed", reason: "tei_invalid_response", retryable: false };
        }
        const candidate = input.candidates[idx];
        if (!candidate) {
          return { status: "failed", reason: "tei_index_out_of_range", retryable: false };
        }
        ranked.push({
          id: candidate.id,
          index: idx,
          score,
          metadata: candidate.metadata,
        });
      }
      // TEI typically returns sorted desc but the contract is not strictly
      // guaranteed; sort defensively so callers can rely on ordering.
      ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      });
      const topN = input.topN ?? ranked.length;
      return {
        status: "ok",
        ranked: ranked.slice(0, Math.max(0, topN)),
        metadata: this.metadata,
      };
    } catch (error) {
      if (input.signal?.aborted) {
        return { status: "failed", reason: "aborted", retryable: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted;
      return {
        status: "failed",
        reason: aborted ? "rerank_timeout" : `tei_error:${message.slice(0, 200)}`,
        retryable: aborted || /ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(message),
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
