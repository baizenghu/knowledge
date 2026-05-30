export type EmbeddingMetadata = {
  model: string;
  version: string;
  dimensions: number;
};

export type EmbedBatchInput = {
  texts: string[];
  signal?: AbortSignal;
};

export type EmbedBatchSuccess = {
  status: "ok";
  vectors: number[][];
  metadata: EmbeddingMetadata;
};

export type EmbedBatchFailure = {
  status: "failed";
  reason: string;
  retryable: boolean;
};

export type EmbedBatchResult = EmbedBatchSuccess | EmbedBatchFailure;

export interface EmbeddingAdapter {
  readonly metadata: EmbeddingMetadata;
  embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult>;
}

export class EmbeddingTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`embedding exceeded ${timeoutMs}ms`);
    this.name = "EmbeddingTimeoutError";
  }
}
