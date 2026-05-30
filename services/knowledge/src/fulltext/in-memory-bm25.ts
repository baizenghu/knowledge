import type {
  FulltextAdapter,
  FulltextDocument,
  FulltextFilter,
  FulltextHit,
  FulltextPayload,
  FulltextUpsertResult,
} from "./fulltext-adapter.js";

/**
 * BM25 parameters. Standard defaults; exported so retrieval-tuning callers
 * can replicate scoring offline (e.g. the eval harness).
 */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

/**
 * Tokenizer used by {@link InMemoryBM25Adapter}.
 *
 * Strategy: split into ascii word runs (lowercased) plus contiguous
 * non-ascii (CJK/etc.) runs. ASCII runs become single tokens; non-ascii
 * runs are bigram-shingled. Empty tokens are dropped. Repeated tokens
 * are preserved so term frequency reflects natural usage.
 *
 * Example: `"知识库 search"` → `["zh1zh2", "zh2zh3", "search"]` where each
 * `zhN` represents one CJK character bigram. The bigram fallback gives us
 * usable Chinese recall without a full segmenter — a CJK character on its
 * own is rarely discriminative, but adjacent pairs usually are.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // Split into runs of either ascii word chars or non-ascii (anything that
  // is letter/number but not ascii). Any other character (punctuation,
  // whitespace) acts as a delimiter.
  const runs = lower.match(/[a-z0-9]+|[^\sa-z0-9\p{P}\p{S}]+/gu) ?? [];
  for (const run of runs) {
    if (/^[a-z0-9]+$/.test(run)) {
      tokens.push(run);
      continue;
    }
    // Non-ascii run — emit bigrams. If a single char, emit it alone.
    const chars = [...run];
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
      tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

type StoredDocument = {
  doc: FulltextDocument;
  length: number;
  termFreq: Map<string, number>;
};

/**
 * In-memory BM25 adapter for unit tests and M5 POC ingest paths. Supports a
 * subset of {@link FulltextFilter} mirroring {@link InMemoryQdrantAdapter}:
 * `must` / `must_not` conditions of either `{ key, match: { value } }` or
 * `{ key, match: { any: [...] } }` shape — enough for ACL/tenant/space
 * pre-filtering during retrieval.
 */
export class InMemoryBM25Adapter implements FulltextAdapter {
  private readonly docs = new Map<string, StoredDocument>();
  /** term → docId → tf */
  private readonly inverted = new Map<string, Map<string, number>>();
  private totalLength = 0;

  async upsertDocuments(docs: FulltextDocument[]): Promise<FulltextUpsertResult> {
    for (const doc of docs) {
      this.removeFromIndex(doc.id);
      const tokens = tokenize(doc.text);
      const termFreq = new Map<string, number>();
      for (const t of tokens) {
        termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      }
      const stored: StoredDocument = {
        doc: { id: doc.id, text: doc.text, payload: { ...doc.payload } },
        length: tokens.length,
        termFreq,
      };
      this.docs.set(doc.id, stored);
      this.totalLength += stored.length;
      for (const [term, tf] of termFreq) {
        let postings = this.inverted.get(term);
        if (!postings) {
          postings = new Map();
          this.inverted.set(term, postings);
        }
        postings.set(doc.id, tf);
      }
    }
    return { status: "ok", written: docs.length };
  }

  async search(query: string, limit: number, filter?: FulltextFilter): Promise<FulltextHit[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.docs.size === 0) return [];
    const avgdl = this.totalLength / this.docs.size;
    const totalDocs = this.docs.size;

    // Build candidate set restricted by filter (filter is applied as a hard
    // pre-filter — BM25 only ranks survivors).
    const candidates: StoredDocument[] = [];
    for (const stored of this.docs.values()) {
      if (filter && !matchesFilter(stored.doc.payload, filter)) continue;
      candidates.push(stored);
    }
    if (candidates.length === 0) return [];

    // Pre-compute IDF for each unique query term.
    const uniqueTerms = [...new Set(queryTokens)];
    const idfByTerm = new Map<string, number>();
    for (const term of uniqueTerms) {
      const df = this.inverted.get(term)?.size ?? 0;
      // Standard BM25 IDF with +1 smoothing to keep it non-negative.
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      idfByTerm.set(term, idf);
    }

    const hits: FulltextHit[] = [];
    for (const stored of candidates) {
      let score = 0;
      for (const term of uniqueTerms) {
        const tf = stored.termFreq.get(term) ?? 0;
        if (tf === 0) continue;
        const idf = idfByTerm.get(term) ?? 0;
        const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (stored.length / (avgdl || 1)));
        score += idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
      }
      if (score > 0) {
        hits.push({ id: stored.doc.id, score, payload: stored.doc.payload });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async deleteByFilter(filter: FulltextFilter): Promise<number> {
    const toDelete: string[] = [];
    for (const [id, stored] of this.docs) {
      if (matchesFilter(stored.doc.payload, filter)) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.removeFromIndex(id);
    }
    return toDelete.length;
  }

  /** Test helper — returns a deep-ish snapshot of stored documents. */
  snapshot(): FulltextDocument[] {
    return [...this.docs.values()].map((stored) => ({
      id: stored.doc.id,
      text: stored.doc.text,
      payload: { ...stored.doc.payload },
    }));
  }

  private removeFromIndex(id: string): void {
    const existing = this.docs.get(id);
    if (!existing) return;
    this.totalLength -= existing.length;
    for (const term of existing.termFreq.keys()) {
      const postings = this.inverted.get(term);
      if (!postings) continue;
      postings.delete(id);
      if (postings.size === 0) {
        this.inverted.delete(term);
      }
    }
    this.docs.delete(id);
  }
}

function matchesFilter(payload: FulltextPayload, filter: FulltextFilter): boolean {
  if (filter.must && !filter.must.every((cond) => matchesCondition(payload, cond))) {
    return false;
  }
  if (filter.must_not && filter.must_not.some((cond) => matchesCondition(payload, cond))) {
    return false;
  }
  return true;
}

function matchesCondition(
  payload: FulltextPayload,
  condition: Record<string, unknown>,
): boolean {
  const key = condition["key"];
  const match = condition["match"];
  if (typeof key !== "string" || match === null || typeof match !== "object") {
    return false;
  }
  const value = (payload as unknown as Record<string, unknown>)[key];
  const matchObj = match as Record<string, unknown>;
  if ("value" in matchObj) {
    return scalarEquals(value, matchObj["value"]);
  }
  if ("any" in matchObj && Array.isArray(matchObj["any"])) {
    return (matchObj["any"] as unknown[]).some((candidate) => scalarEquals(value, candidate));
  }
  return false;
}

function scalarEquals(value: unknown, candidate: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item === candidate);
  }
  return value === candidate;
}
