export const DOCUMENT_STATUSES = [
  "queued",
  "parsing",
  "indexing",
  "searchable",
  "degraded",
  "parse_failed",
  "deleted",
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "degraded",
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const DOCUMENT_JOB_STATUS_MAP: Record<DocumentStatus, JobStatus[]> = {
  queued: ["queued"],
  parsing: ["running"],
  indexing: ["running"],
  searchable: ["succeeded"],
  degraded: ["degraded", "succeeded"],
  parse_failed: ["failed", "dead_lettered"],
  deleted: ["cancelled", "succeeded", "failed", "dead_lettered"],
};
