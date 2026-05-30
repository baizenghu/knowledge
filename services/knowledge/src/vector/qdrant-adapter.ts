/**
 * Adapter contract for Qdrant — the vector store used by knowledge-service M4
 * retrieval. We model the surface as a narrow interface so unit tests can use
 * an in-memory fake while production wires up the HTTP REST adapter against a
 * real Qdrant cluster.
 *
 * Payload fields are the M4-mandated retrieval/governance metadata: every
 * point carries enough context to honour tenant/space isolation, ACL versions,
 * soft deletes and time/type filters without re-reading the relational store.
 */

export type QdrantPointPayload = {
  source_system_id: string;
  tenant_id: string;
  space_id: string;
  document_id: string;
  document_version_id: string;
  document_version_number: number;
  acl_hash: string;
  acl_version: number;
  status: "active" | "shadow" | "deleted";
  deleted_at: string | null;
  tags: string[];
  document_type: string | null;
  /** ISO8601 of indexed_at — used for recency filters. */
  time: string;
  // Returned alongside hits for snippet rendering — not part of the filter
  // contract but still stored in the payload so retrieval avoids extra hops.
  chunk_index: number;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
};

export type QdrantPoint = {
  /** Chunk id; must be unique within the collection. */
  id: string;
  vector: number[];
  payload: QdrantPointPayload;
};

export type QdrantFilter = {
  must?: Array<Record<string, unknown>>;
  must_not?: Array<Record<string, unknown>>;
  should?: Array<Record<string, unknown>>;
};

export type QdrantSearchHit = {
  id: string;
  score: number;
  payload: QdrantPointPayload;
};

export type QdrantUpsertResult =
  | { status: "ok"; written: number }
  | { status: "failed"; reason: string; retryable: boolean };

export interface QdrantAdapter {
  readonly collectionName: string;
  ensureCollection(vectorSize: number): Promise<void>;
  upsertPoints(points: QdrantPoint[]): Promise<QdrantUpsertResult>;
  searchByVector(
    vector: number[],
    limit: number,
    filter?: QdrantFilter,
  ): Promise<QdrantSearchHit[]>;
  deleteByFilter(filter: QdrantFilter): Promise<number>;
  /**
   * Partially update payload on all points matching the filter. Used by the
   * shadow-reindex promote path to flip status=shadow → active without
   * re-upserting the vectors.
   */
  setPayloadByFilter(
    payload: Partial<QdrantPointPayload>,
    filter: QdrantFilter,
  ): Promise<number>;
}
