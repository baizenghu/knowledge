import type { KnowledgeErrorCode } from "@octopus/knowledge-contracts";
import type { LLMAdapter } from "../llm/llm-adapter.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { KnowledgeSearchService, SearchContext, SearchHit, SearchQuery } from "./search-service.js";
import { answerLatency, emptyAnswerCounter, sanitizeLabel } from "../observability/metrics.js";

export type AnswerServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: KnowledgeErrorCode; message: string };

export type AnswerQuery = SearchQuery & {
  maxTokens?: number;
  temperature?: number;
};

export type Citation = {
  anchorId: string;
  chunkId: string;
  documentId: string;
  page: number | null;
  headingPath: string[];
  snippet: string;
};

export type AnswerTrace = {
  degraded?: Record<string, boolean>;
  expansion?: import("./search-service.js").SearchExpansionTrace;
};

const DEFAULT_FINAL_K = 5;
const SNIPPET_CHARS = 200;
const NO_HITS_TEMPLATE = "I don't have enough information to answer that based on the available knowledge base.";

const SYSTEM_PROMPT = "You answer using only the provided context. Cite as [^anchor:N] inline.";

/**
 * Retrieval-augmented answer composer. Pulls top hits via SearchService, asks
 * the LLM to ground its answer in the numbered context, then resolves the
 * inline [N] / [^anchor:N] markers back to anchor ids the UI can deep-link.
 *
 * Failure handling: the LLM is treated as best-effort. If it fails we still
 * return ok with `answer=""` and `trace.degraded.llm_failed=true` so the
 * caller can render the citations alongside a "model unavailable" message.
 * Falling back to a non-empty hallucinated answer would defeat the
 * citations-or-nothing guarantee this service is supposed to provide.
 */
export class KnowledgeAnswerService {
  constructor(private readonly deps: {
    search: KnowledgeSearchService;
    llm: LLMAdapter;
  }) {}

  async answer(
    scope: TenantScope,
    query: AnswerQuery,
    ctx: SearchContext,
    now: Date = new Date(),
  ): Promise<AnswerServiceResult<{ answer: string; citations: Citation[]; trace?: AnswerTrace }>> {
    const tenantLabel = sanitizeLabel(scope.tenantId);
    const llmProviderLabel = sanitizeLabel(this.deps.llm.metadata.provider);
    const startedAt = Date.now();
    let outcome: "ok" | "degraded" | "failed" = "ok";
    try {
      const result = await this.answerImpl(scope, query, ctx, now, tenantLabel);
      if (!result.ok) {
        outcome = "failed";
      } else if (result.data.trace?.degraded && Object.keys(result.data.trace.degraded).length > 0) {
        outcome = "degraded";
      }
      return result;
    } catch (err) {
      outcome = "failed";
      throw err;
    } finally {
      answerLatency.observe({ tenant_id: tenantLabel, llm_provider: llmProviderLabel, status: outcome }, (Date.now() - startedAt) / 1000);
    }
  }

  private async answerImpl(
    scope: TenantScope,
    query: AnswerQuery,
    ctx: SearchContext,
    now: Date,
    tenantLabel: string,
  ): Promise<AnswerServiceResult<{ answer: string; citations: Citation[]; trace?: AnswerTrace }>> {
    const finalK = query.finalK ?? DEFAULT_FINAL_K;
    const searchResult = await this.deps.search.search(
      scope,
      { ...query, finalK },
      ctx,
      now,
    );
    if (!searchResult.ok) {
      return searchResult;
    }
    const { hits, trace: searchTrace } = searchResult.data;
    const degraded: Record<string, boolean> = { ...(searchTrace?.degraded ?? {}) };
    const expansion = searchTrace?.expansion;
    const buildTrace = (): AnswerTrace | undefined => {
      const t: AnswerTrace = {};
      if (Object.keys(degraded).length > 0) t.degraded = degraded;
      if (expansion) t.expansion = expansion;
      return Object.keys(t).length > 0 ? t : undefined;
    };

    if (hits.length === 0) {
      degraded["no_hits"] = true;
      emptyAnswerCounter.inc({ tenant_id: tenantLabel, reason: "no_hits" });
      return {
        ok: true,
        data: {
          answer: NO_HITS_TEMPLATE,
          citations: [],
          trace: buildTrace() ?? { degraded },
        },
      };
    }

    // Build prompt with the expanded contextText (small-to-big), but keep one
    // numbered block per anchor so citations stay 1-to-1 with chunks. Two hits
    // sharing the same expanded span will repeat the text — minor token cost,
    // simple mapping. A future optimisation could merge same-span blocks and
    // list multiple anchors per block.
    const context = hits
      .map((hit, index) => `[${index + 1}] ${hit.contextText || hit.text}`)
      .join("\n");
    const userPrompt = `Context:\n${context}\n\nQuestion: ${query.query}`;

    const llmResult = await this.deps.llm.generate({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      maxTokens: query.maxTokens,
      temperature: query.temperature,
    });

    if (llmResult.status !== "ok") {
      degraded["llm_failed"] = true;
      emptyAnswerCounter.inc({ tenant_id: tenantLabel, reason: "llm_failed" });
      return {
        ok: true,
        data: {
          answer: "",
          citations: hits.map((hit) => toCitation(hit)),
          trace: buildTrace() ?? { degraded },
        },
      };
    }

    const cited = extractCitedIndexes(llmResult.text, hits.length);
    const indexes = cited.length > 0 ? cited : hits.map((_, idx) => idx);
    const citations = indexes.map((idx) => toCitation(hits[idx]));

    return {
      ok: true,
      data: {
        answer: llmResult.text,
        citations,
        trace: buildTrace(),
      },
    };
  }
}

function toCitation(hit: SearchHit): Citation {
  return {
    anchorId: hit.anchorId,
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    page: hit.pageStart,
    headingPath: hit.headingPath,
    snippet: hit.text.slice(0, SNIPPET_CHARS),
  };
}

/**
 * Pull `[N]` and `[^anchor:N]` markers out of the model response and return
 * the unique zero-based indexes, dropping any out-of-range references the
 * model hallucinated.
 */
function extractCitedIndexes(text: string, hitCount: number): number[] {
  const indexes = new Set<number>();
  const patterns = [/\[\^anchor:(\d+)\]/g, /\[(\d+)\]/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= hitCount) {
        indexes.add(n - 1);
      }
    }
  }
  return [...indexes].sort((a, b) => a - b);
}
