import { describe, expect, it, vi } from "vitest";
import {
  PrismaKnowledgeAnchorStore,
  PrismaKnowledgeAssetStore,
  PrismaKnowledgeChunkStore,
  PrismaKnowledgeEvalDatasetStore,
  PrismaKnowledgeEvalRunStore,
} from "./prisma-stores.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("PrismaKnowledgeAssetStore", () => {
  const assetInput = (over: Record<string, unknown> = {}) => ({
    ...scope,
    assetId: "asset_1",
    documentId: "doc_1",
    versionId: "ver_1",
    type: "image",
    uri: "s3://bucket/a.png",
    sha256: "a".repeat(64),
    mimeType: "image/png",
    sizeBytes: 1234,
    pageNo: 2,
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
    metadata: null,
    createdAt: new Date("2026-05-18T00:00:00.000Z"),
    deletedAt: null,
    ...over,
  });

  it("新内容走 create（按 versionId+sha256+type 查无命中）+ BigInt size_bytes 还原", async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async ({ data }: any) => ({ ...data, sizeBytes: BigInt(data.sizeBytes ?? 0) }));
    const prisma = { knowledgeAsset: { findFirst, create } } as any;
    const store = new PrismaKnowledgeAssetStore(prisma);

    const result = await store.upsert(assetInput() as any);

    expect(result.sizeBytes).toBe(1234);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ versionId: "ver_1", sha256: "a".repeat(64), type: "image" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.assetId).toBe("asset_1");
  });

  it("重试幂等：同 (versionId,sha256,type) 命中已存行 → update 保留旧 assetId，不再 create", async () => {
    // 复现 dead_letter bug 的修复：assetId 每次随机生成，但去重键是版本内内容标识。
    const findFirst = vi.fn(async () => ({ assetId: "asset_OLD" }));
    const create = vi.fn();
    const update = vi.fn(async ({ data }: any) => ({ ...data, assetId: "asset_OLD", sizeBytes: BigInt(data.sizeBytes ?? 0) }));
    const prisma = { knowledgeAsset: { findFirst, create, update } } as any;
    const store = new PrismaKnowledgeAssetStore(prisma);

    // 传入一个全新的随机 assetId（模拟重试），应被忽略、复用已存行的 assetId。
    const result = await store.upsert(assetInput({ assetId: "asset_NEW_RANDOM" }) as any);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where.sourceSystemId_tenantId_assetId.assetId).toBe("asset_OLD");
    // update data 不含 assetId / createdAt（不覆盖已存行的身份）。
    expect(update.mock.calls[0][0].data).not.toHaveProperty("assetId");
    expect(update.mock.calls[0][0].data).not.toHaveProperty("createdAt");
    expect(result.assetId).toBe("asset_OLD");
  });

  it("listForVersion 只回未软删的资产", async () => {
    const findMany = vi.fn(async () => [
      { ...scope, assetId: "a1", documentId: "d", versionId: "v", type: "image", uri: "u", sha256: "x", sizeBytes: 1, createdAt: new Date() },
    ]);
    const prisma = { knowledgeAsset: { findMany } } as any;
    const store = new PrismaKnowledgeAssetStore(prisma);

    const list = await store.listForVersion(scope, "v");
    expect(list).toHaveLength(1);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ versionId: "v", deletedAt: null });
  });
});

describe("PrismaKnowledgeChunkStore", () => {
  it("insertMany 写 createMany 后回查并按 chunkIndex 排序", async () => {
    const createMany = vi.fn(async () => ({ count: 2 }));
    const findMany = vi.fn(async () => [
      baseChunk({ chunkId: "c1", chunkIndex: 0 }),
      baseChunk({ chunkId: "c2", chunkIndex: 1 }),
    ]);
    const prisma = { knowledgeChunk: { createMany, findMany } } as any;
    const store = new PrismaKnowledgeChunkStore(prisma);

    const out = await store.insertMany(scope, [
      bulkChunk({ chunkId: "c1", chunkIndex: 0 }),
      bulkChunk({ chunkId: "c2", chunkIndex: 1 }),
    ]);
    expect(out).toHaveLength(2);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ chunkId: "c1", deletedAt: null });
    expect(findMany.mock.calls[0][0].where.chunkId.in).toEqual(["c1", "c2"]);
  });

  it("promoteShadow 只翻 status=shadow 的本版本 chunk", async () => {
    const updateMany = vi.fn(async () => ({ count: 3 }));
    const prisma = { knowledgeChunk: { updateMany } } as any;
    const store = new PrismaKnowledgeChunkStore(prisma);

    const promoted = await store.promoteShadow(scope, "ver-2");
    expect(promoted).toBe(3);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { versionId: "ver-2", status: "shadow" },
      data: { status: "active" },
    });
  });

  it("markDeletedForVersion 写 status=deleted + deletedAt", async () => {
    const updateMany = vi.fn(async () => ({ count: 5 }));
    const prisma = { knowledgeChunk: { updateMany } } as any;
    const store = new PrismaKnowledgeChunkStore(prisma);

    const now = new Date("2026-05-18T01:00:00.000Z");
    const n = await store.markDeletedForVersion(scope, "ver-1", now);
    expect(n).toBe(5);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ versionId: "ver-1", deletedAt: null });
    expect(call.data).toMatchObject({ status: "deleted", deletedAt: now });
  });

  it("getMany 空数组直接返回 []", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { knowledgeChunk: { findMany } } as any;
    const store = new PrismaKnowledgeChunkStore(prisma);

    const out = await store.getMany(scope, []);
    expect(out).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("PrismaKnowledgeAnchorStore", () => {
  it("upsert 同时写入 nodeIds(JSON) 和 nodeId(scalar 兼容旧表)", async () => {
    const upsert = vi.fn(async ({ create }: any) => ({ ...create }));
    const prisma = { knowledgeCitationAnchor: { upsert } } as any;
    const store = new PrismaKnowledgeAnchorStore(prisma);

    await store.upsert({
      ...scope,
      anchorId: "anc_1",
      chunkId: "c1",
      documentId: "d1",
      versionId: "v1",
      spaceId: "space-1",
      aclHash: "h",
      aclVersion: 7,
      page: 3,
      bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
      charSpan: { start: 10, end: 20 },
      nodeIds: ["n1", "n2"],
      headingPath: ["A", "B"],
      createdAt: new Date(),
    });

    const create = upsert.mock.calls[0][0].create;
    expect(create.nodeIds).toEqual(["n1", "n2"]);
    expect(create.nodeId).toBe("n1");
    expect(create.charStart).toBe(10);
    expect(create.charEnd).toBe(20);
    expect(create.charSpan).toEqual({ start: 10, end: 20 });
    expect(create.aclVersion).toBe(7);
  });

  it("getByChunk 跨 tenant 不命中", async () => {
    const findFirst = vi.fn(async () => null);
    const prisma = { knowledgeCitationAnchor: { findFirst } } as any;
    const store = new PrismaKnowledgeAnchorStore(prisma);

    const r = await store.getByChunk(scope, "chunk-x");
    expect(r).toBeNull();
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      sourceSystemId: "octopus",
      tenantId: "tenant-1",
      chunkId: "chunk-x",
    });
  });
});

describe("PrismaKnowledgeEvalDatasetStore", () => {
  it("create 把 annotator + samples + metadata 序列化进 manifest JSON", async () => {
    const create = vi.fn(async ({ data }: any) => ({ ...data }));
    const prisma = { knowledgeEvaluationDataset: { create } } as any;
    const store = new PrismaKnowledgeEvalDatasetStore(prisma);

    const record = await store.create({
      ...scope,
      datasetId: "ds_1",
      name: "ops",
      version: "v1",
      annotator: "user-x",
      samples: [{ sampleId: "s1", query: "q", expectedDocumentIds: ["d1"] }],
      metadata: { source: "prod" },
      createdAt: new Date(),
    });

    const data = create.mock.calls[0][0].data;
    expect(data.manifest.annotator).toBe("user-x");
    expect(data.manifest.samples).toHaveLength(1);
    expect(data.createdBy).toBe("user-x");
    expect(record.samples).toHaveLength(1);
  });

  it("get 回放 manifest 还原 EvalDatasetRecord", async () => {
    const findFirst = vi.fn(async () => ({
      ...scope,
      datasetId: "ds_1",
      name: "n",
      version: "v",
      manifest: { annotator: "u", samples: [{ sampleId: "s", query: "q", expectedDocumentIds: [] }], metadata: null },
      createdBy: "u",
      createdAt: new Date(),
    }));
    const prisma = { knowledgeEvaluationDataset: { findFirst } } as any;
    const store = new PrismaKnowledgeEvalDatasetStore(prisma);

    const r = await store.get(scope, "ds_1");
    expect(r?.annotator).toBe("u");
    expect(r?.samples[0].sampleId).toBe("s");
  });
});

describe("PrismaKnowledgeEvalRunStore", () => {
  it("create 把 config + failedSamples 进 metrics JSON blob", async () => {
    const create = vi.fn(async ({ data }: any) => ({ ...data, status: "queued" }));
    const prisma = { knowledgeEvaluationRun: { create } } as any;
    const store = new PrismaKnowledgeEvalRunStore(prisma);

    const created = await store.create({
      ...scope,
      runId: "run_1",
      datasetId: "ds_1",
      status: "queued",
      config: { topK: 10, finalK: 5 },
      failedSamples: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const data = create.mock.calls[0][0].data;
    expect(data.metrics.config).toMatchObject({ topK: 10, finalK: 5 });
    expect(data.metrics.failedSamples).toEqual([]);
    expect(created.status).toBe("queued");
  });

  it("update 合并 patch 后回写 metrics blob", async () => {
    const existing = {
      ...scope,
      runId: "run_1",
      datasetId: "ds_1",
      status: "running",
      config: { topK: 10 },
      metrics: null,
      failedSamples: [],
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    };
    let currentStatus = "running";
    const findFirst = vi.fn(async () => ({
      ...existing,
      status: currentStatus,
      metrics: { config: existing.config, failedSamples: existing.failedSamples, metrics: null },
      startedAt: null,
      finishedAt: null,
    }));
    const updateMany = vi.fn(async ({ data }: any) => {
      currentStatus = data.status;
      return { count: 1 };
    });
    const prisma = { knowledgeEvaluationRun: { findFirst, updateMany } } as any;
    const store = new PrismaKnowledgeEvalRunStore(prisma);

    const result = await store.update(scope, "run_1", { status: "succeeded" });
    expect(result?.status).toBe("succeeded");
    expect(updateMany.mock.calls[0][0].data.status).toBe("succeeded");
  });

  it("update 在 run 不存在时返回 null", async () => {
    const findFirst = vi.fn(async () => null);
    const prisma = { knowledgeEvaluationRun: { findFirst, updateMany: vi.fn() } } as any;
    const store = new PrismaKnowledgeEvalRunStore(prisma);
    const r = await store.update(scope, "nope", { status: "failed" });
    expect(r).toBeNull();
  });
});

function baseChunk(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...scope,
    chunkId: "c",
    spaceId: "sp",
    documentId: "d",
    versionId: "v",
    versionNumber: 1,
    chunkIndex: 0,
    status: "active",
    text: "t",
    textHash: "h",
    tokenCount: 1,
    nodeIds: [],
    headingPath: [],
    pageStart: null,
    pageEnd: null,
    bboxRefs: [],
    aclHash: "a",
    aclVersion: 1,
    embeddingModel: null,
    embeddingVersion: null,
    vectorPointId: null,
    fulltextDocId: null,
    metadata: {},
    createdAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

function bulkChunk(over: Partial<Record<string, unknown>>) {
  const { createdAt: _c, deletedAt: _d, ...rest } = baseChunk(over) as any;
  return rest;
}
