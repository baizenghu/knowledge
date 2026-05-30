import client from "prom-client";

/**
 * Dedicated registry for knowledge-service business metrics. We keep it
 * separate from the global prom-client default registry so that:
 *  - tests can `resetMetrics()` between cases without nuking the default
 *    `collectDefaultMetrics` series (process_cpu, nodejs_*, ...)
 *  - the `/v1/metrics` endpoint can `Registry.merge` both registries and
 *    expose them as a single Prometheus scrape.
 */
export const knowledgeRegistry = new client.Registry();

/** Threshold above which a Qdrant search is counted as slow. */
export const SLOW_QDRANT_QUERY_MS = 500;

/**
 * Sanitize an arbitrary value for use as a Prometheus label.
 *
 * tenant_id (and other label values) come from request headers — never trust
 * them. Prom-client itself escapes values for the text format but we still:
 *  - cap length at 64 chars (cardinality / scrape-size guard)
 *  - replace control / newline / comma / quote characters with `_` so a
 *    malicious header cannot break the exposition format if a future writer
 *    forgets to escape.
 */
export function sanitizeLabel(value: unknown): string {
  if (value === undefined || value === null) return "";
  const str = String(value);
  const cleaned = str.replace(/[\r\n\t,"\\]/g, "_");
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

// ---------- parse stage ----------
export const parseDuration = new client.Histogram({
  name: "knowledge_parse_duration_seconds",
  help: "Time spent in parser (MinerU / mock) per ingest job.",
  labelNames: ["tenant_id", "parser_provider", "status"],
  buckets: [0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300],
  registers: [knowledgeRegistry],
});

export const parseFailureCounter = new client.Counter({
  name: "knowledge_parse_failures_total",
  help: "Parse failures (final, after retries).",
  labelNames: ["tenant_id", "parser_provider", "reason"],
  registers: [knowledgeRegistry],
});

export const parseDegradedCounter = new client.Counter({
  name: "knowledge_parse_degraded_total",
  help: "Parse degraded results.",
  labelNames: ["tenant_id", "parser_provider", "reason"],
  registers: [knowledgeRegistry],
});

// ---------- indexing stage ----------
export const embeddingDuration = new client.Histogram({
  name: "knowledge_embedding_duration_seconds",
  help: "Time spent embedding chunks.",
  labelNames: ["tenant_id", "embedding_model", "status"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [knowledgeRegistry],
});

export const indexUpsertDuration = new client.Histogram({
  name: "knowledge_index_upsert_duration_seconds",
  help: "Time spent upserting chunks into vector + fulltext.",
  labelNames: ["tenant_id", "target", "status"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [knowledgeRegistry],
});

// ---------- search stage ----------
export const searchLatency = new client.Histogram({
  name: "knowledge_search_latency_seconds",
  help: "End-to-end /v1/search latency.",
  labelNames: ["tenant_id", "status"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [knowledgeRegistry],
});

export const searchEmptyCounter = new client.Counter({
  name: "knowledge_search_empty_total",
  help: "Searches returning zero hits.",
  labelNames: ["tenant_id", "reason"],
  registers: [knowledgeRegistry],
});

export const rerankScore = new client.Histogram({
  name: "knowledge_rerank_score",
  help: "Rerank scores observed at retrieval time.",
  labelNames: ["tenant_id", "reranker_model"],
  buckets: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [knowledgeRegistry],
});

// ---------- answer + citation ----------
export const answerLatency = new client.Histogram({
  name: "knowledge_answer_latency_seconds",
  help: "End-to-end /v1/answer latency.",
  labelNames: ["tenant_id", "llm_provider", "status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [knowledgeRegistry],
});

export const emptyAnswerCounter = new client.Counter({
  name: "knowledge_answer_empty_total",
  help: "Answer responses with empty answer text (LLM failed or no hits).",
  labelNames: ["tenant_id", "reason"],
  registers: [knowledgeRegistry],
});

export const citationHitCounter = new client.Counter({
  name: "knowledge_citation_hits_total",
  help: "Citation resolves served (counts ok + not_found separately).",
  labelNames: ["tenant_id", "outcome"],
  registers: [knowledgeRegistry],
});

// ---------- permission / slow query ----------
export const aclDenyCounter = new client.Counter({
  name: "knowledge_acl_denies_total",
  help: "Searches / citations / answers blocked by ACL (silently filtered).",
  labelNames: ["tenant_id", "stage"],
  registers: [knowledgeRegistry],
});

export const qdrantSlowQueryCounter = new client.Counter({
  name: "knowledge_qdrant_slow_query_total",
  help: "Qdrant searches above the slow query threshold (500ms).",
  labelNames: ["tenant_id"],
  registers: [knowledgeRegistry],
});

// ---------- gc worker ----------
export const gcRunsTotal = new client.Counter({
  name: "knowledge_gc_runs_total",
  help: "GC worker scan loops executed.",
  registers: [knowledgeRegistry],
});

export const gcSpacesPurgedTotal = new client.Counter({
  name: "knowledge_gc_spaces_purged_total",
  help: "Soft-deleted knowledge spaces physically purged.",
  registers: [knowledgeRegistry],
});

export const gcSpacesFailedTotal = new client.Counter({
  name: "knowledge_gc_spaces_failed_total",
  help: "GC purge / cleanup failures (final-state 'failed' or tx rollback).",
  registers: [knowledgeRegistry],
});

export const gcPendingCleanupGauge = new client.Gauge({
  name: "knowledge_gc_pending_cleanup_gauge",
  help: "Soft-deleted spaces with at least one cleanup target still pending/failed.",
  registers: [knowledgeRegistry],
});

export const gcOldestDeletedAgeSeconds = new client.Gauge({
  name: "knowledge_gc_oldest_deleted_age_seconds",
  help: "Age (seconds) of the oldest soft-deleted space still on disk.",
  registers: [knowledgeRegistry],
});

/** Convenience wrapper used by call-sites to avoid sprinkling sanitization. */
export function withTenant<L extends Record<string, string>>(tenantId: string, labels: L): L & { tenant_id: string } {
  return { ...labels, tenant_id: sanitizeLabel(tenantId) };
}
