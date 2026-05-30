/**
 * Adapter contract for the BM25 full-text index used by knowledge-service M5
 * dual-path retrieval. The vector adapter handles semantic recall; this one
 * handles lexical/keyword recall via BM25 scoring. We model the surface as a
 * narrow interface so M5 can ship on an in-memory implementation while M6
 * swaps in a real Elasticsearch/OpenSearch cluster.
 *
 * Payload fields mirror the qdrant payload's retrieval/governance metadata so
 * that ACL/tenant/space filtering can run identically on both legs.
 */

export type FulltextPayload = {
  source_system_id: string;
  tenant_id: string;
  space_id: string;
  document_id: string;
  document_version_id: string;
  document_version_number: number;
  acl_hash: string;
  acl_version: number;
  status: "active" | "shadow" | "deleted";
  document_type: string | null;
  chunk_id: string;
  chunk_index: number;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
};

export type FulltextDocument = {
  /** Chunk id; must be unique within the index. */
  id: string;
  text: string;
  payload: FulltextPayload;
};

export type FulltextFilter = {
  must?: Array<Record<string, unknown>>;
  must_not?: Array<Record<string, unknown>>;
};

export type FulltextHit = {
  id: string;
  /** BM25 relevance score (higher is better). */
  score: number;
  payload: FulltextPayload;
};

export type FulltextUpsertResult =
  | { status: "ok"; written: number }
  | { status: "failed"; reason: string; retryable: boolean };

export interface FulltextAdapter {
  upsertDocuments(docs: FulltextDocument[]): Promise<FulltextUpsertResult>;
  search(query: string, limit: number, filter?: FulltextFilter): Promise<FulltextHit[]>;
  deleteByFilter(filter: FulltextFilter): Promise<number>;
}
