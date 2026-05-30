export type RerankCandidate = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type RerankInput = {
  query: string;
  candidates: RerankCandidate[];
  topN?: number;
  signal?: AbortSignal;
};

export type RerankMetadata = {
  model: string;
  version: string;
};

export type RerankRankedItem = {
  id: string;
  score: number;
  index: number;
  metadata?: Record<string, unknown>;
};

export type RerankSuccess = {
  status: "ok";
  ranked: RerankRankedItem[];
  metadata: RerankMetadata;
};

export type RerankFailure = {
  status: "failed";
  reason: string;
  retryable: boolean;
};

export type RerankResult = RerankSuccess | RerankFailure;

export interface RerankAdapter {
  readonly metadata: RerankMetadata;
  rerank(input: RerankInput): Promise<RerankResult>;
}
