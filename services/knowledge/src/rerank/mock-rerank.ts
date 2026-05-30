import type {
  RerankAdapter,
  RerankInput,
  RerankMetadata,
  RerankRankedItem,
  RerankResult,
} from "./rerank-adapter.js";

/**
 * Deterministic mock reranker. Computes a Jaccard similarity over
 * lowercased whitespace tokens between the query and each candidate text.
 * Intended for unit tests and local development paths that need a stable
 * ordering signal without contacting a model server.
 */
export class MockRerankerAdapter implements RerankAdapter {
  readonly metadata: RerankMetadata = {
    model: "mock-rerank",
    version: "1.0.0",
  };

  async rerank(input: RerankInput): Promise<RerankResult> {
    if (input.signal?.aborted) {
      return { status: "failed", reason: "aborted", retryable: false };
    }
    const queryTokens = tokenize(input.query);
    const ranked: RerankRankedItem[] = input.candidates.map((candidate, index) => ({
      id: candidate.id,
      index,
      score: jaccard(queryTokens, tokenize(candidate.text)),
      metadata: candidate.metadata,
    }));
    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable secondary key for determinism when scores tie.
      return a.index - b.index;
    });
    const topN = input.topN ?? ranked.length;
    return {
      status: "ok",
      ranked: ranked.slice(0, Math.max(0, topN)),
      metadata: this.metadata,
    };
  }
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/\s+/)) {
    if (token.length > 0) out.add(token);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}
