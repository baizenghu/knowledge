import { describe, expect, it } from "vitest";
import { InMemoryBM25Adapter, tokenize } from "./in-memory-bm25.js";
import type { FulltextDocument, FulltextPayload } from "./fulltext-adapter.js";

function payload(overrides: Partial<FulltextPayload> = {}): FulltextPayload {
  return {
    source_system_id: "octopus",
    tenant_id: "tenant-1",
    space_id: "space-1",
    document_id: "doc-1",
    document_version_id: "ver-1",
    document_version_number: 1,
    acl_hash: "acl-a",
    acl_version: 1,
    status: "active",
    chunk_id: "chunk-1",
    chunk_index: 0,
    heading_path: [],
    page_start: null,
    page_end: null,
    ...overrides,
  };
}

function doc(id: string, text: string, overrides: Partial<FulltextPayload> = {}): FulltextDocument {
  return { id, text, payload: payload({ chunk_id: id, ...overrides }) };
}

describe("tokenize", () => {
  it("handles mixed Chinese/English text via ascii words + CJK bigrams", () => {
    const tokens = tokenize("知识库 search");
    expect(tokens).toContain("search");
    // "知识库" -> bigrams "知识", "识库"
    expect(tokens).toContain("知识");
    expect(tokens).toContain("识库");
    expect(tokens.length).toBe(3);
  });

  it("lowercases ascii and splits on punctuation/whitespace", () => {
    expect(tokenize("Hello, World! BM25-Search")).toEqual(["hello", "world", "bm25", "search"]);
  });

  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ,,, ")).toEqual([]);
  });
});

describe("InMemoryBM25Adapter", () => {
  it("ranks the most relevant document highest for a keyword query", async () => {
    const idx = new InMemoryBM25Adapter();
    await idx.upsertDocuments([
      doc("a", "the cat sat on the mat"),
      doc("b", "dogs and cats are common pets"),
      doc("c", "completely unrelated content about cooking"),
    ]);
    const hits = await idx.search("cat mat", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("a");
  });

  it("isolates tenants via must filter on tenant_id", async () => {
    const idx = new InMemoryBM25Adapter();
    await idx.upsertDocuments([
      doc("a", "shared keyword content", { tenant_id: "tenant-1" }),
      doc("b", "shared keyword content", { tenant_id: "tenant-2" }),
    ]);
    const hits = await idx.search("keyword", 10, {
      must: [{ key: "tenant_id", match: { value: "tenant-1" } }],
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("supports must match.any for acl_hash pre-filtering", async () => {
    const idx = new InMemoryBM25Adapter();
    await idx.upsertDocuments([
      doc("a", "policy document", { acl_hash: "acl-a" }),
      doc("b", "policy document", { acl_hash: "acl-b" }),
      doc("c", "policy document", { acl_hash: "acl-c" }),
    ]);
    const hits = await idx.search("policy", 10, {
      must: [{ key: "acl_hash", match: { any: ["acl-a", "acl-c"] } }],
    });
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("excludes deleted documents via must_not", async () => {
    const idx = new InMemoryBM25Adapter();
    await idx.upsertDocuments([
      doc("a", "alpha beta", { status: "active" }),
      doc("b", "alpha beta", { status: "deleted" }),
    ]);
    const hits = await idx.search("alpha", 10, {
      must_not: [{ key: "status", match: { value: "deleted" } }],
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("deleteByFilter removes docs from inverted index so they are no longer hit", async () => {
    const idx = new InMemoryBM25Adapter();
    await idx.upsertDocuments([
      doc("a", "alpha beta gamma", { tenant_id: "tenant-1" }),
      doc("b", "alpha beta gamma", { tenant_id: "tenant-2" }),
    ]);
    const removed = await idx.deleteByFilter({
      must: [{ key: "tenant_id", match: { value: "tenant-1" } }],
    });
    expect(removed).toBe(1);

    const all = await idx.search("alpha", 10);
    expect(all.map((h) => h.id)).toEqual(["b"]);
    expect(idx.snapshot()).toHaveLength(1);
  });

  it("upsertDocuments is idempotent: re-upsert overwrites without leaking inverted entries", async () => {
    const idx = new InMemoryBM25Adapter();
    await idx.upsertDocuments([doc("a", "alpha beta")]);
    await idx.upsertDocuments([doc("a", "gamma delta")]);
    const hitsOld = await idx.search("alpha", 10);
    expect(hitsOld).toHaveLength(0);
    const hitsNew = await idx.search("gamma", 10);
    expect(hitsNew.map((h) => h.id)).toEqual(["a"]);
  });
});
