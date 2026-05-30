import type { FulltextAdapter } from "./fulltext-adapter.js";

/**
 * Stub placeholder for the production Elasticsearch/OpenSearch adapter. M5
 * runs on InMemoryBM25Adapter; this throws if instantiated so we don't
 * pretend production paths exist until they do.
 */
export class ElasticsearchAdapter implements FulltextAdapter {
  constructor(_options: { endpoint: string; index: string; apiKey?: string }) {
    throw new Error("ElasticsearchAdapter not implemented; switch FULLTEXT_PROVIDER back to in-memory until M6");
  }
  upsertDocuments(): never { throw new Error("unreachable"); }
  search(): never { throw new Error("unreachable"); }
  deleteByFilter(): never { throw new Error("unreachable"); }
}
