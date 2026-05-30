import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeChunkStore, type ChunkBulkInsert } from "./chunk-store.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

function makeChunk(over: Partial<ChunkBulkInsert>): ChunkBulkInsert {
  return {
    ...scope,
    chunkId: `chunk_${Math.random().toString(36).slice(2, 10)}`,
    spaceId: "space_1",
    documentId: "doc_1",
    versionId: "ver_1",
    versionNumber: 1,
    chunkIndex: 0,
    status: "active",
    text: "body",
    textHash: "h",
    tokenCount: 10,
    nodeIds: [],
    headingPath: [],
    pageStart: null,
    pageEnd: null,
    bboxRefs: [],
    aclHash: "acl",
    aclVersion: 1,
    sectionId: "sec",
    embeddingModel: null,
    embeddingVersion: null,
    vectorPointId: null,
    fulltextDocId: null,
    metadata: {},
    ...over,
  } as ChunkBulkInsert;
}

describe("KnowledgeChunkStore.listByIndexRange", () => {
  it("返回 [lo, hi] 内的活跃 chunk，按 chunkIndex 升序", async () => {
    const store = new InMemoryKnowledgeChunkStore();
    await store.insertMany(scope, [
      makeChunk({ chunkId: "a", chunkIndex: 0, text: "0" }),
      makeChunk({ chunkId: "b", chunkIndex: 1, text: "1" }),
      makeChunk({ chunkId: "c", chunkIndex: 2, text: "2" }),
      makeChunk({ chunkId: "d", chunkIndex: 3, text: "3" }),
    ]);
    const r = await store.listByIndexRange(scope, "ver_1", 1, 2);
    expect(r.map((c) => c.chunkId)).toEqual(["b", "c"]);
  });

  it("跨 versionId 不串", async () => {
    const store = new InMemoryKnowledgeChunkStore();
    await store.insertMany(scope, [
      makeChunk({ chunkId: "v1a", versionId: "ver_1", chunkIndex: 0 }),
      makeChunk({ chunkId: "v2a", versionId: "ver_2", chunkIndex: 0 }),
    ]);
    const r = await store.listByIndexRange(scope, "ver_1", 0, 5);
    expect(r.map((c) => c.chunkId)).toEqual(["v1a"]);
  });

  it("跳过 shadow / deleted / 跨 tenant", async () => {
    const store = new InMemoryKnowledgeChunkStore();
    await store.insertMany(scope, [
      makeChunk({ chunkId: "active", chunkIndex: 0 }),
      makeChunk({ chunkId: "shadow", chunkIndex: 1, status: "shadow" }),
    ]);
    await store.insertMany({ sourceSystemId: "other", tenantId: "tenant-1" }, [
      makeChunk({ chunkId: "wrong-source", sourceSystemId: "other", chunkIndex: 0 }),
    ]);
    const r = await store.listByIndexRange(scope, "ver_1", 0, 10);
    expect(r.map((c) => c.chunkId)).toEqual(["active"]);
  });
});

describe("KnowledgeChunkStore.listForSection", () => {
  it("按 sectionId 聚合，按 chunkIndex 升序", async () => {
    const store = new InMemoryKnowledgeChunkStore();
    await store.insertMany(scope, [
      makeChunk({ chunkId: "s1a", sectionId: "sec_A", chunkIndex: 0 }),
      makeChunk({ chunkId: "s2a", sectionId: "sec_B", chunkIndex: 1 }),
      makeChunk({ chunkId: "s1b", sectionId: "sec_A", chunkIndex: 2 }),
    ]);
    const r = await store.listForSection(scope, "sec_A");
    expect(r.map((c) => c.chunkId)).toEqual(["s1a", "s1b"]);
  });

  it("跨 tenant 不串", async () => {
    const store = new InMemoryKnowledgeChunkStore();
    await store.insertMany(scope, [
      makeChunk({ chunkId: "ok", sectionId: "shared-id" }),
    ]);
    await store.insertMany({ sourceSystemId: "octopus", tenantId: "tenant-2" }, [
      makeChunk({ chunkId: "leak", tenantId: "tenant-2", sectionId: "shared-id" }),
    ]);
    const r = await store.listForSection(scope, "shared-id");
    expect(r.map((c) => c.chunkId)).toEqual(["ok"]);
  });
});
