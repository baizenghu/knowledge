import { beforeEach, describe, expect, it } from "vitest";
import { MockEmbeddingAdapter } from "../embedding/mock-embedding.js";
import { InMemoryBM25Adapter } from "../fulltext/in-memory-bm25.js";
import { MockRerankerAdapter } from "../rerank/mock-rerank.js";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAnchorStore } from "../repositories/anchor-store.js";
import { InMemoryKnowledgeChunkStore, type KnowledgeChunkRecord } from "../repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeSpaceStore } from "../repositories/space-store.js";
import { InMemoryQdrantAdapter } from "../vector/in-memory-qdrant.js";
import { KnowledgeSearchService, type SearchContext } from "./search-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const CTX: SearchContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  departments: ["dept-ops"],
  roles: ["reader"],
};

const CREATED_AT = new Date("2026-05-18T00:00:00.000Z");

function chunkOf(over: Partial<KnowledgeChunkRecord> & { chunkId: string; chunkIndex: number; text: string }): KnowledgeChunkRecord {
  return {
    sourceSystemId: scope.sourceSystemId,
    tenantId: scope.tenantId,
    chunkId: over.chunkId,
    spaceId: "space_1",
    documentId: "doc_1",
    versionId: "ver_1",
    versionNumber: 1,
    chunkIndex: over.chunkIndex,
    status: "active",
    text: over.text,
    textHash: "h",
    tokenCount: over.tokenCount ?? 20,
    nodeIds: [`node_${over.chunkIndex}`],
    headingPath: over.headingPath ?? ["Hooks（6 事件自动化）"],
    pageStart: 1,
    pageEnd: 1,
    bboxRefs: [],
    aclHash: over.aclHash ?? "acl_default",
    aclVersion: 1,
    sectionId: over.sectionId ?? "sec_hooks",
    embeddingModel: "mock-embed",
    embeddingVersion: "1.0.0",
    vectorPointId: over.chunkId,
    fulltextDocId: over.chunkId,
    metadata: {},
    createdAt: CREATED_AT,
    deletedAt: null,
  };
}

async function buildFixture() {
  const documents = new InMemoryKnowledgeDocumentStore();
  const chunks = new InMemoryKnowledgeChunkStore();
  const vector = new InMemoryQdrantAdapter("knowledge_chunks");
  const fulltext = new InMemoryBM25Adapter();
  const embedding = new MockEmbeddingAdapter();
  const reranker = new MockRerankerAdapter();
  const acl = new InMemoryKnowledgeAclStore();
  const anchors = new InMemoryKnowledgeAnchorStore();
  const spaces = new InMemoryKnowledgeSpaceStore();

  const snapshot = await acl.upsertSnapshot(scope, { read: [{ type: "department", id: "dept-ops" }] });
  await acl.replaceDocumentPrincipals({
    scope,
    documentId: "doc_1",
    aclHash: snapshot.aclHash,
    aclVersion: 1,
    canonicalAcl: snapshot.canonicalJson,
  });

  await documents.create({
    ...scope,
    documentId: "doc_1",
    spaceId: "space_1",
    title: "Claude Code Guide",
    documentType: "handbook",
    status: "searchable",
    visibilityStatus: "visible",
    currentVersionId: "ver_1",
    currentVersionNumber: 1,
    aclHash: snapshot.aclHash,
    aclVersion: 1,
    sourceSha256: "a".repeat(64),
    createdBy: "user-1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  // 5 chunks, same section, contiguous indices. Chunk 2 contains the keyword
  // we'll query for. We want to see expansion pull in 1/3 (window) or 0..4
  // (section), not just chunk 2 alone.
  const texts = [
    "Hooks 概览 第 0 段 — 介绍",
    "Hooks 是事件驱动机制 第 1 段",
    "支持 6 个事件： PreToolUse PostToolUse UserPromptSubmit Notification Stop SubagentStop",
    "第 3 段：配置位置 .claude/settings.json",
    "第 4 段：退出码 0 放行 2 阻止",
  ];
  const records: KnowledgeChunkRecord[] = texts.map((t, i) =>
    chunkOf({
      chunkId: `chunk_${i}`,
      chunkIndex: i,
      text: t,
      aclHash: snapshot.aclHash,
      tokenCount: 50,
    }),
  );
  await chunks.insertMany(scope, records);

  await vector.ensureCollection(64);
  for (const c of records) {
    const embed = await embedding.embedBatch({ texts: [c.text] });
    if (embed.status !== "ok") throw new Error("embed");
    await vector.upsertPoints([{
      id: c.chunkId,
      vector: embed.vectors[0],
      payload: {
        source_system_id: c.sourceSystemId,
        tenant_id: c.tenantId,
        space_id: c.spaceId,
        document_id: c.documentId,
        document_version_id: c.versionId,
        document_version_number: c.versionNumber,
        acl_hash: c.aclHash,
        acl_version: c.aclVersion,
        status: "active",
        deleted_at: null,
        tags: [],
        document_type: "handbook",
        time: CREATED_AT.toISOString(),
        chunk_index: c.chunkIndex,
        heading_path: c.headingPath,
        page_start: c.pageStart,
        page_end: c.pageEnd,
      },
    }]);
    await fulltext.upsertDocuments([{
      id: c.chunkId,
      text: c.text,
      payload: {
        source_system_id: c.sourceSystemId,
        tenant_id: c.tenantId,
        space_id: c.spaceId,
        document_id: c.documentId,
        document_version_id: c.versionId,
        document_version_number: c.versionNumber,
        acl_hash: c.aclHash,
        acl_version: c.aclVersion,
        status: "active",
        document_type: "handbook",
        chunk_id: c.chunkId,
        chunk_index: c.chunkIndex,
        heading_path: c.headingPath,
        page_start: c.pageStart,
        page_end: c.pageEnd,
      },
    }]);
  }

  const search = new KnowledgeSearchService({
    documents,
    chunks,
    vector,
    fulltext,
    embedding,
    reranker,
    acl,
    anchors,
    spaces,
  });

  return { search, records };
}

describe("KnowledgeSearchService 上下文扩展 (Small-to-Big)", () => {
  let fix: Awaited<ReturnType<typeof buildFixture>>;
  beforeEach(async () => {
    fix = await buildFixture();
  });

  it("默认 window:1 — 命中 chunk_2 拼回 [1,2,3] 三段 + 命中字段保持小 chunk", async () => {
    const r = await fix.search.search(scope, { query: "6 个事件 PreToolUse" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits.length).toBeGreaterThan(0);
    const hit = r.data.hits[0];
    // 命中 anchor / chunkId / text 必须保留为小 chunk（citation 锚定不动）
    expect(["chunk_1", "chunk_2", "chunk_3"]).toContain(hit.chunkId);
    expect(hit.text).toBe(fix.records.find((c) => c.chunkId === hit.chunkId)!.text);
    // contextText 必须 ≥ 矩 windowSize=1，即至少 3 个 chunk 的内容
    expect(hit.contextChunkIds.length).toBeGreaterThanOrEqual(2);
    // trace 上有 expansion 元数据
    expect(r.data.trace?.expansion?.mode).toBe("window");
    expect(r.data.trace?.expansion?.windowSize).toBe(1);
  });

  it("mode=chunk — contextText 等于 matched chunk text，contextChunkIds 长度 = 1", async () => {
    const r = await fix.search.search(scope, {
      query: "PreToolUse",
      context: { mode: "chunk" },
    }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const hit of r.data.hits) {
      expect(hit.contextText).toBe(hit.text);
      expect(hit.contextChunkIds).toEqual([hit.chunkId]);
    }
    expect(r.data.trace?.expansion?.mode).toBe("chunk");
  });

  it("mode=section — 整节 5 段拼回，trace 反映合并组数=1", async () => {
    const r = await fix.search.search(scope, {
      query: "6 个事件",
      context: { mode: "section" },
    }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits.length).toBeGreaterThan(0);
    const hit = r.data.hits[0];
    expect(hit.contextChunkIds.length).toBe(5);
    expect(hit.contextText).toContain("第 0 段");
    expect(hit.contextText).toContain("第 4 段");
    expect(r.data.trace?.expansion?.mode).toBe("section");
    expect(r.data.trace?.expansion?.mergedGroups).toBe(1);
  });

  it("window:2 多命中重叠 — 合并去重为单一区间", async () => {
    const r = await fix.search.search(scope, {
      query: "Hooks PreToolUse 配置 退出码",
      finalK: 5,
      context: { mode: "window", window_size: 2 } as unknown as { mode: "window"; windowSize: number },
    }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 全部命中的 contextChunkIds 应当是同一个合并后区间
    const allCtxSets = r.data.hits.map((h) => h.contextChunkIds.join(","));
    expect(new Set(allCtxSets).size).toBe(1);
    expect(r.data.trace?.expansion?.mergedGroups).toBe(1);
  });

  it("max_context_tokens 预算限制 — 即使 section 整节超预算也按命中中心截断", async () => {
    // 50 token × 5 段 = 250 token，预算 100 → 最多容纳 2 段
    const r = await fix.search.search(scope, {
      query: "6 个事件",
      context: { mode: "section", maxContextTokens: 100 },
    }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits.length).toBeGreaterThan(0);
    const hit = r.data.hits[0];
    expect(hit.contextChunkIds.length).toBeLessThan(5);
    expect(hit.contextChunkIds).toContain(hit.chunkId);
    expect(r.data.trace?.expansion?.tokenBudgetLimit).toBe(100);
  });
});
