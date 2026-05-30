import { createOpaqueId, type KnowledgeErrorCode } from "@octopus/knowledge-contracts";
import type { EmbeddingAdapter } from "../embedding/embedding-adapter.js";
import type { FulltextAdapter, FulltextFilter } from "../fulltext/fulltext-adapter.js";
import type { RerankAdapter } from "../rerank/rerank-adapter.js";
import type { KnowledgeAclStore } from "../repositories/acl-store.js";
import type { KnowledgeAnchorRecord, KnowledgeAnchorStore } from "../repositories/anchor-store.js";
import type { KnowledgeChunkRecord, KnowledgeChunkStore } from "../repositories/chunk-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { KnowledgeSpaceStore } from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { QdrantAdapter, QdrantFilter } from "../vector/qdrant-adapter.js";
import {
  aclDenyCounter,
  qdrantSlowQueryCounter,
  rerankScore as rerankScoreMetric,
  sanitizeLabel,
  searchEmptyCounter,
  searchLatency,
  SLOW_QDRANT_QUERY_MS,
} from "../observability/metrics.js";

export type SearchServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: KnowledgeErrorCode; message: string };

/**
 * Caller-controlled knob for how much surrounding context each hit should
 * carry. Decoupled from embedding / rerank granularity — those always run on
 * small chunks; context delivery is what scales up.
 *
 *   - chunk    → no expansion, hit text = matched chunk text only
 *   - window   → fetch ±windowSize sibling chunks (by chunk_index) and merge
 *   - section  → fetch all chunks under the same heading_path / section_id,
 *                budget-clipped centred on the matched chunk
 *   - document → entire document (rare; explicit only, never default)
 */
export type ContextOptions = {
  mode: "chunk" | "window" | "section" | "document";
  windowSize?: number;
  maxContextTokens?: number;
};

export const DEFAULT_CONTEXT: Required<ContextOptions> = {
  mode: "window",
  windowSize: 1,
  maxContextTokens: 8000,
};

export type SearchQuery = {
  query: string;
  spaceIds?: string[];
  topK?: number;
  finalK?: number;
  strictSpaceCheck?: boolean;
  documentTypes?: string[];
  filters?: { tags?: string[] };
  context?: ContextOptions;
};

export type SearchContext = {
  tenantId: string;
  userId: string;
  departments: string[];
  roles: string[];
};

export type SearchHit = {
  chunkId: string;
  documentId: string;
  versionId: string;
  versionNumber: number;
  spaceId: string;
  /** Always the matched chunk's text (citation-stable, eval-stable). */
  text: string;
  /** Expanded text spanning matched chunk + neighbours (LLM-ready). */
  contextText: string;
  /** Chunk ids included in `contextText`, in chunk_index order. */
  contextChunkIds: string[];
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
  scores: { vector?: number; bm25?: number; rrf?: number; rerank?: number };
  anchorId: string;
};

export type SearchExpansionTrace = {
  mode: ContextOptions["mode"];
  windowSize?: number;
  expandedChunksTotal: number;
  mergedGroups: number;
  tokenBudgetUsed: number;
  tokenBudgetLimit: number;
};

export type SearchTrace = {
  degraded?: Record<string, boolean>;
  expansion?: SearchExpansionTrace;
};

const DEFAULT_TOP_K = 50;
const DEFAULT_FINAL_K = 10;
const RRF_K = 60;

/**
 * Hybrid retrieval over qdrant (semantic) + BM25 (lexical), fused via RRF and
 * optionally reranked. Every step honours tenant scope and the caller's ACL:
 *
 *   1. compute the set of acl_hashes visible to `ctx` at "now" (this is the
 *      30s ACL convergence handle — once a principal change lands in the acl
 *      store, the very next call sees the new set).
 *   2. push that set into the vector and fulltext filters so even the recall
 *      stage never sees forbidden chunks.
 *   3. after RRF + rerank, re-validate each candidate against the live chunk
 *      and document record (status, deleted_at, visibility) to defend against
 *      indexer/store skew.
 */
export class KnowledgeSearchService {
  constructor(private readonly deps: {
    documents: KnowledgeDocumentStore;
    chunks: KnowledgeChunkStore;
    vector: QdrantAdapter;
    fulltext: FulltextAdapter;
    embedding: EmbeddingAdapter;
    reranker: RerankAdapter;
    acl: KnowledgeAclStore;
    anchors: KnowledgeAnchorStore;
    spaces?: KnowledgeSpaceStore;
  }) {}

  async search(
    scope: TenantScope,
    query: SearchQuery,
    ctx: SearchContext,
    now: Date = new Date(),
  ): Promise<SearchServiceResult<{ hits: SearchHit[]; trace?: SearchTrace }>> {
    const tenantLabel = sanitizeLabel(scope.tenantId);
    const startedAt = Date.now();
    let outcome: "ok" | "empty" | "degraded" | "error" = "ok";
    try {
      const result = await this.searchImpl(scope, query, ctx, now);
      if (!result.ok) {
        outcome = "error";
      } else if (result.data.hits.length === 0) {
        outcome = "empty";
      } else if (result.data.trace?.degraded && Object.keys(result.data.trace.degraded).length > 0) {
        outcome = "degraded";
      }
      return result;
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      searchLatency.observe({ tenant_id: tenantLabel, status: outcome }, (Date.now() - startedAt) / 1000);
    }
  }

  private async searchImpl(
    scope: TenantScope,
    query: SearchQuery,
    ctx: SearchContext,
    now: Date,
  ): Promise<SearchServiceResult<{ hits: SearchHit[]; trace?: SearchTrace }>> {
    const tenantLabel = sanitizeLabel(scope.tenantId);
    const topK = query.topK ?? DEFAULT_TOP_K;
    const finalK = query.finalK ?? DEFAULT_FINAL_K;
    const degraded: Record<string, boolean> = {};

    // strict space check: explicitly enumerate the requested spaces. If any
    // space is missing we return NOT_FOUND with a generic message so that
    // existence cannot be probed (same code path as "space exists but you
    // can't see it" once that branch is implemented).
    if (query.strictSpaceCheck && query.spaceIds && query.spaceIds.length > 0) {
      if (!this.deps.spaces) {
        return { ok: false, code: "NOT_FOUND", message: "space not found" };
      }
      for (const spaceId of query.spaceIds) {
        const space = await this.deps.spaces.get(scope, spaceId);
        if (!space) {
          return { ok: false, code: "NOT_FOUND", message: "space not found" };
        }
      }
    }

    const visibleAclHashes = await this.deps.acl.listAclHashesForContext(
      scope,
      { tenantId: ctx.tenantId, userId: ctx.userId, departments: ctx.departments, roles: ctx.roles },
      now,
    );
    if (visibleAclHashes.size === 0) {
      degraded["no_visible_acl"] = true;
      aclDenyCounter.inc({ tenant_id: tenantLabel, stage: "search_filter" });
      searchEmptyCounter.inc({ tenant_id: tenantLabel, reason: "no_visible_acl" });
      return { ok: true, data: { hits: [], trace: { degraded } } };
    }

    // Embed the query. Empty embed → can still BM25-only retrieve.
    const embed = await this.deps.embedding.embedBatch({ texts: [query.query] });
    let queryVector: number[] | null = null;
    if (embed.status === "ok" && embed.vectors.length > 0) {
      queryVector = embed.vectors[0];
    } else {
      degraded["embedding_failed"] = true;
      searchEmptyCounter.inc({ tenant_id: tenantLabel, reason: "embedding_failed" });
    }

    const aclHashList = [...visibleAclHashes];
    const vectorFilter: QdrantFilter = {
      must: [
        { key: "tenant_id", match: { value: scope.tenantId } },
        { key: "source_system_id", match: { value: scope.sourceSystemId } },
        { key: "acl_hash", match: { any: aclHashList } },
        { key: "status", match: { value: "active" } },
        ...(query.spaceIds && query.spaceIds.length > 0
          ? [{ key: "space_id", match: { any: query.spaceIds } }]
          : []),
        ...(query.documentTypes && query.documentTypes.length > 0
          ? [{ key: "document_type", match: { any: query.documentTypes } }]
          : []),
      ],
    };
    const fulltextFilter: FulltextFilter = {
      must: [
        { key: "tenant_id", match: { value: scope.tenantId } },
        { key: "source_system_id", match: { value: scope.sourceSystemId } },
        { key: "acl_hash", match: { any: aclHashList } },
        { key: "status", match: { value: "active" } },
        ...(query.spaceIds && query.spaceIds.length > 0
          ? [{ key: "space_id", match: { any: query.spaceIds } }]
          : []),
        ...(query.documentTypes && query.documentTypes.length > 0
          ? [{ key: "document_type", match: { any: query.documentTypes } }]
          : []),
      ],
    };

    let vectorHits: Awaited<ReturnType<QdrantAdapter["searchByVector"]>> = [];
    if (queryVector) {
      const qdrantStarted = Date.now();
      const vectorResult = await safeWithFlag(() =>
        this.deps.vector.searchByVector(queryVector!, topK, vectorFilter),
      );
      vectorHits = vectorResult.value ?? [];
      if (!vectorResult.ok) {
        degraded["vector_failed"] = true;
      }
      const qdrantMs = Date.now() - qdrantStarted;
      if (qdrantMs > SLOW_QDRANT_QUERY_MS) {
        qdrantSlowQueryCounter.inc({ tenant_id: tenantLabel });
      }
    }
    const bm25Result = await safeWithFlag(() => this.deps.fulltext.search(query.query, topK, fulltextFilter));
    const bm25Hits = bm25Result.value ?? [];
    if (!bm25Result.ok) {
      degraded["bm25_failed"] = true;
    }

    // RRF fusion: rank within each path, score = sum 1/(k + rank).
    const rrfScores = new Map<string, { rrf: number; vector?: number; bm25?: number }>();
    vectorHits.forEach((hit, rank) => {
      const entry = rrfScores.get(hit.id) ?? { rrf: 0 };
      entry.rrf += 1 / (RRF_K + rank + 1);
      entry.vector = hit.score;
      rrfScores.set(hit.id, entry);
    });
    bm25Hits.forEach((hit, rank) => {
      const entry = rrfScores.get(hit.id) ?? { rrf: 0 };
      entry.rrf += 1 / (RRF_K + rank + 1);
      entry.bm25 = hit.score;
      rrfScores.set(hit.id, entry);
    });

    if (rrfScores.size === 0) {
      searchEmptyCounter.inc({ tenant_id: tenantLabel, reason: "no_hits" });
      return { ok: true, data: { hits: [], trace: hasDegradedKeys(degraded) ? { degraded } : undefined } };
    }

    const rrfTop = [...rrfScores.entries()]
      .sort(([, a], [, b]) => b.rrf - a.rrf)
      .slice(0, topK);

    const chunkIds = rrfTop.map(([id]) => id);
    const fetched = await this.deps.chunks.getMany(scope, chunkIds);
    const chunkById = new Map<string, KnowledgeChunkRecord>();
    for (const chunk of fetched) {
      chunkById.set(chunk.chunkId, chunk);
    }

    type Candidate = { chunkId: string; chunk: KnowledgeChunkRecord; rrf: number; vector?: number; bm25?: number };
    const candidates: Candidate[] = [];
    for (const [chunkId, scoreEntry] of rrfTop) {
      const chunk = chunkById.get(chunkId);
      if (!chunk) continue;
      if (chunk.status !== "active") continue;
      if (chunk.deletedAt) continue;
      if (!visibleAclHashes.has(chunk.aclHash)) continue;
      candidates.push({ chunkId, chunk, rrf: scoreEntry.rrf, vector: scoreEntry.vector, bm25: scoreEntry.bm25 });
    }

    if (candidates.length === 0) {
      searchEmptyCounter.inc({ tenant_id: tenantLabel, reason: "no_hits" });
      return { ok: true, data: { hits: [], trace: hasDegradedKeys(degraded) ? { degraded } : undefined } };
    }

    let rankedOrder: Array<{ candidate: Candidate; rerankScore?: number }>;
    const rerankResult = await this.deps.reranker.rerank({
      query: query.query,
      candidates: candidates.map((c) => ({ id: c.chunkId, text: c.chunk.text })),
      topN: finalK,
    });
    if (rerankResult.status === "ok") {
      const candidateById = new Map(candidates.map((c) => [c.chunkId, c]));
      const rerankerModelLabel = sanitizeLabel(this.deps.reranker.metadata.model);
      rankedOrder = rerankResult.ranked
        .map((ranked) => {
          const candidate = candidateById.get(ranked.id);
          if (!candidate) return null;
          rerankScoreMetric.observe({ tenant_id: tenantLabel, reranker_model: rerankerModelLabel }, ranked.score);
          return { candidate, rerankScore: ranked.score };
        })
        .filter((x): x is { candidate: Candidate; rerankScore: number } => x !== null)
        .slice(0, finalK);
    } else {
      degraded["rerank_failed"] = true;
      rankedOrder = candidates.slice(0, finalK).map((candidate) => ({ candidate }));
    }

    // Document-level visibility re-check (defence in depth — keeps the
    // soft-delete window honest even if indexer/chunk-store cache skews).
    const documentTypeSet = query.documentTypes && query.documentTypes.length > 0
      ? new Set(query.documentTypes)
      : null;
    const resolved: ResolvedHit[] = [];
    for (const { candidate, rerankScore } of rankedOrder) {
      const document = await this.deps.documents.get(scope, candidate.chunk.documentId);
      if (!document) continue;
      if (document.status === "deleted") continue;
      if (document.visibilityStatus !== "visible") continue;
      if (document.deletedAt) continue;
      if (documentTypeSet && !documentTypeSet.has(document.documentType ?? "")) continue;
      const anchor = await this.ensureAnchor(scope, candidate.chunk, now);
      resolved.push({
        chunk: candidate.chunk,
        anchor,
        scores: {
          rrf: candidate.rrf,
          vector: candidate.vector,
          bm25: candidate.bm25,
          rerank: rerankScore,
        },
      });
    }

    // Small-to-Big expansion: rerank stayed on the small (≤512 tok) chunk for
    // precision; now we widen the text we hand to the LLM to fix the boundary
    // truncation problem (e.g. "支持 6 个事件：" cut from its enumeration).
    // citation stays anchored to the matched chunk via SearchHit.chunkId.
    const contextOptions: Required<ContextOptions> = {
      ...DEFAULT_CONTEXT,
      ...(query.context ?? {}),
    };
    const expansion = await expandContext({
      scope,
      hits: resolved,
      options: contextOptions,
      chunks: this.deps.chunks,
    });

    return {
      ok: true,
      data: {
        hits: expansion.hits,
        trace: hasDegradedKeys(degraded) || expansion.trace
          ? { ...(hasDegradedKeys(degraded) ? { degraded } : {}), expansion: expansion.trace }
          : undefined,
      },
    };
  }

  private async ensureAnchor(
    scope: TenantScope,
    chunk: KnowledgeChunkRecord,
    now: Date,
  ): Promise<KnowledgeAnchorRecord> {
    const existing = await this.deps.anchors.getByChunk(scope, chunk.chunkId);
    if (existing) {
      return existing;
    }
    const bbox = chunk.bboxRefs[0]?.bbox ?? null;
    return this.deps.anchors.upsert({
      sourceSystemId: scope.sourceSystemId,
      tenantId: scope.tenantId,
      anchorId: createOpaqueId("anchor"),
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      versionId: chunk.versionId,
      spaceId: chunk.spaceId,
      aclHash: chunk.aclHash,
      aclVersion: chunk.aclVersion,
      page: chunk.pageStart,
      bbox,
      charSpan: null,
      nodeIds: chunk.nodeIds,
      headingPath: chunk.headingPath,
      createdAt: now,
    });
  }
}

async function safeWithFlag<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; value: null }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Resolved hit after rerank + document visibility checks, before context
 * expansion. Carries enough to (a) build the final SearchHit and (b) decide
 * which siblings to fetch in the expansion phase.
 */
type ResolvedHit = {
  chunk: KnowledgeChunkRecord;
  anchor: KnowledgeAnchorRecord;
  scores: { rrf: number; vector?: number; bm25?: number; rerank?: number };
};

/**
 * Context expansion phase — runs *after* rerank so that ranking stays on
 * small chunks (precise + within reranker's 512-token input cap) while the
 * LLM gets fed a bigger, contiguous text window per hit.
 *
 * Modes:
 *   - chunk    → no extra DB calls, contextText == matched chunk text
 *   - window   → fetch ±windowSize chunks by chunk_index, merge overlapping
 *                groups within the same document
 *   - section  → fetch all chunks sharing the same section_id, then budget-
 *                clip centred on the matched chunk
 *   - document → fetch the entire document (capped by maxContextTokens)
 *
 * Budget rule: maxContextTokens caps *per hit*, not aggregate. Multiple hits
 * may share the same context (e.g. two reranks in the same merged window) —
 * the answer service is expected to dedup before prompt assembly.
 */
async function expandContext(args: {
  scope: TenantScope;
  hits: ResolvedHit[];
  options: Required<ContextOptions>;
  chunks: KnowledgeChunkStore;
}): Promise<{ hits: SearchHit[]; trace: SearchExpansionTrace }> {
  const { scope, hits: resolved, options, chunks: chunkStore } = args;
  if (resolved.length === 0) {
    return {
      hits: [],
      trace: emptyExpansionTrace(options),
    };
  }
  if (options.mode === "chunk") {
    return { hits: resolved.map(toBaseHit), trace: chunkOnlyTrace(resolved, options) };
  }

  // For window/section/document we group hits by (documentId, versionId) so
  // overlapping expansion ranges can be merged into a single DB fetch.
  const docKey = (h: ResolvedHit) => `${h.chunk.documentId}::${h.chunk.versionId}`;
  const groups = new Map<string, ResolvedHit[]>();
  for (const h of resolved) {
    const k = docKey(h);
    const arr = groups.get(k) ?? [];
    arr.push(h);
    groups.set(k, arr);
  }

  type ExpandedSpan = {
    chunks: KnowledgeChunkRecord[];
    rerankBest: number;
  };
  // hit → the merged span its context comes from
  const hitToSpan = new Map<ResolvedHit, ExpandedSpan>();
  let totalChunks = 0;
  let mergedGroups = 0;

  for (const [, groupHits] of groups) {
    const spans = await computeSpansForGroup(
      groupHits,
      options,
      chunkStore,
      scope,
    );
    mergedGroups += spans.length;
    for (const span of spans) {
      totalChunks += span.chunks.length;
      for (const member of span.memberHits) {
        hitToSpan.set(member, { chunks: span.chunks, rerankBest: span.rerankBest });
      }
    }
  }

  let tokenBudgetUsed = 0;
  const outHits: SearchHit[] = [];
  for (const h of resolved) {
    const span = hitToSpan.get(h);
    if (!span) {
      // No span found (group was empty) — fall back to chunk mode for this hit.
      outHits.push(toBaseHit(h));
      tokenBudgetUsed += h.chunk.tokenCount || estimateTokens(h.chunk.text);
      continue;
    }
    const contextText = span.chunks.map((c) => c.text).join("\n\n");
    const contextChunkIds = span.chunks.map((c) => c.chunkId);
    const contextTokens = span.chunks.reduce(
      (acc, c) => acc + (c.tokenCount || estimateTokens(c.text)),
      0,
    );
    tokenBudgetUsed += contextTokens;
    outHits.push({
      ...toBaseHit(h),
      contextText,
      contextChunkIds,
    });
  }

  return {
    hits: outHits,
    trace: {
      mode: options.mode,
      windowSize: options.mode === "window" ? options.windowSize : undefined,
      expandedChunksTotal: totalChunks,
      mergedGroups,
      tokenBudgetUsed,
      tokenBudgetLimit: options.maxContextTokens,
    },
  };
}

type GroupSpan = {
  chunks: KnowledgeChunkRecord[];
  rerankBest: number;
  memberHits: ResolvedHit[];
};

async function computeSpansForGroup(
  groupHits: ResolvedHit[],
  options: Required<ContextOptions>,
  chunkStore: KnowledgeChunkStore,
  scope: TenantScope,
): Promise<GroupSpan[]> {
  if (groupHits.length === 0) return [];

  if (options.mode === "window") {
    // Sort by chunkIndex, compute [lo, hi] = [idx - W, idx + W], merge.
    const intervals = groupHits
      .map((h) => ({
        lo: h.chunk.chunkIndex - options.windowSize,
        hi: h.chunk.chunkIndex + options.windowSize,
        hit: h,
      }))
      .sort((a, b) => a.lo - b.lo);
    const merged: { lo: number; hi: number; members: ResolvedHit[] }[] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv.lo <= last.hi + 1) {
        last.hi = Math.max(last.hi, iv.hi);
        last.members.push(iv.hit);
      } else {
        merged.push({ lo: iv.lo, hi: iv.hi, members: [iv.hit] });
      }
    }
    const out: GroupSpan[] = [];
    for (const m of merged) {
      const chunks = await chunkStore.listByIndexRange(scope, groupHits[0].chunk.versionId, m.lo, m.hi);
      const clipped = clipChunksToBudget(chunks, m.members, options.maxContextTokens);
      out.push({
        chunks: clipped,
        rerankBest: bestRerank(m.members),
        memberHits: m.members,
      });
    }
    return out;
  }

  if (options.mode === "section") {
    // Hits may belong to different sections within the same document.
    const bySection = new Map<string, ResolvedHit[]>();
    for (const h of groupHits) {
      const arr = bySection.get(h.chunk.sectionId) ?? [];
      arr.push(h);
      bySection.set(h.chunk.sectionId, arr);
    }
    const out: GroupSpan[] = [];
    for (const [sectionId, members] of bySection) {
      const sectionChunks = await chunkStore.listForSection(scope, sectionId);
      const clipped = clipChunksToBudget(sectionChunks, members, options.maxContextTokens);
      out.push({
        chunks: clipped,
        rerankBest: bestRerank(members),
        memberHits: members,
      });
    }
    return out;
  }

  // document mode: pull whole version, clip to budget centred on best hit.
  const allChunks = await chunkStore.listForVersion(scope, groupHits[0].chunk.versionId);
  const sorted = [...allChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const clipped = clipChunksToBudget(sorted, groupHits, options.maxContextTokens);
  return [{
    chunks: clipped,
    rerankBest: bestRerank(groupHits),
    memberHits: groupHits,
  }];
}

/**
 * Centre on the best-rerank hit and expand outward symmetrically until token
 * budget is exhausted. Returns a contiguous slice of `chunks` (sorted by
 * chunkIndex) that fits under `budget`.
 */
function clipChunksToBudget(
  chunks: KnowledgeChunkRecord[],
  members: ResolvedHit[],
  budget: number,
): KnowledgeChunkRecord[] {
  if (chunks.length === 0) return [];
  const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const totalTokens = sorted.reduce((a, c) => a + (c.tokenCount || estimateTokens(c.text)), 0);
  if (totalTokens <= budget) return sorted;

  // Pick the centre = the member hit with the highest rerank score (fall back
  // to RRF). When multiple hits land in the same group, expanding around the
  // best-ranked one is what gives the LLM the strongest evidence first.
  const bestMember = [...members].sort((a, b) => {
    const sa = a.scores.rerank ?? a.scores.rrf;
    const sb = b.scores.rerank ?? b.scores.rrf;
    return sb - sa;
  })[0];
  const memberIds = new Set(members.map((m) => m.chunk.chunkId));
  let centre = sorted.findIndex((c) => c.chunkId === bestMember.chunk.chunkId);
  if (centre < 0) centre = sorted.findIndex((c) => memberIds.has(c.chunkId));
  if (centre < 0) centre = Math.floor(sorted.length / 2);

  let used = sorted[centre].tokenCount || estimateTokens(sorted[centre].text);
  let lo = centre;
  let hi = centre;
  while (lo > 0 || hi < sorted.length - 1) {
    // Expand the side whose next neighbour has the smaller token cost first.
    const leftCost = lo > 0 ? (sorted[lo - 1].tokenCount || estimateTokens(sorted[lo - 1].text)) : Infinity;
    const rightCost = hi < sorted.length - 1 ? (sorted[hi + 1].tokenCount || estimateTokens(sorted[hi + 1].text)) : Infinity;
    if (leftCost === Infinity && rightCost === Infinity) break;
    if (leftCost <= rightCost) {
      if (used + leftCost > budget) break;
      used += leftCost;
      lo -= 1;
    } else {
      if (used + rightCost > budget) break;
      used += rightCost;
      hi += 1;
    }
  }
  return sorted.slice(lo, hi + 1);
}

function bestRerank(hits: ResolvedHit[]): number {
  let best = -Infinity;
  for (const h of hits) {
    const v = h.scores.rerank ?? h.scores.rrf;
    if (v > best) best = v;
  }
  return best;
}

function toBaseHit(h: ResolvedHit): SearchHit {
  const score = h.scores.rerank ?? h.scores.rrf;
  return {
    chunkId: h.chunk.chunkId,
    documentId: h.chunk.documentId,
    versionId: h.chunk.versionId,
    versionNumber: h.chunk.versionNumber,
    spaceId: h.chunk.spaceId,
    text: h.chunk.text,
    contextText: h.chunk.text,
    contextChunkIds: [h.chunk.chunkId],
    headingPath: h.chunk.headingPath,
    pageStart: h.chunk.pageStart,
    pageEnd: h.chunk.pageEnd,
    score,
    scores: h.scores,
    anchorId: h.anchor.anchorId,
  };
}

function chunkOnlyTrace(hits: ResolvedHit[], options: Required<ContextOptions>): SearchExpansionTrace {
  const tokens = hits.reduce((a, h) => a + (h.chunk.tokenCount || estimateTokens(h.chunk.text)), 0);
  return {
    mode: "chunk",
    expandedChunksTotal: hits.length,
    mergedGroups: hits.length,
    tokenBudgetUsed: tokens,
    tokenBudgetLimit: options.maxContextTokens,
  };
}

function emptyExpansionTrace(options: Required<ContextOptions>): SearchExpansionTrace {
  return {
    mode: options.mode,
    windowSize: options.mode === "window" ? options.windowSize : undefined,
    expandedChunksTotal: 0,
    mergedGroups: 0,
    tokenBudgetUsed: 0,
    tokenBudgetLimit: options.maxContextTokens,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

function hasDegradedKeys(degraded: Record<string, boolean>): boolean {
  return Object.keys(degraded).length > 0;
}
