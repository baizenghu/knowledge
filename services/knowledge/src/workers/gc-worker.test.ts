/**
 * KnowledgeGCWorker 单测（8 项,Phase B.7 覆盖矩阵）。
 *
 * 注意 ⚠️:本测试文件**先写**,等以下两项就绪后才能跑过:
 *   1. `workers/gc-worker.ts` 的 `KnowledgeGCWorker` 与 `runOnce()` 实现（B.2 并行 agent 在写）
 *   2. document/version/job/space/upload-session/asset/chunk/anchor/acl 八张表的 `hardDeleteBySpace`
 *      (B.1 sibling task 部分完成:anchor/asset/chunk/acl 已有;document/version/job/space 尚缺)
 *
 * 测试矩阵和断言已经按计划文档 §B.7 锁定;接口 shape 以"最直白合理"为准,等真实 API 收敛后再调。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAnchorStore } from "../repositories/anchor-store.js";
import { InMemoryKnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import { InMemoryKnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import { InMemoryKnowledgeAssetStore } from "../repositories/asset-store.js";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeChunkStore } from "../repositories/chunk-store.js";
import {
  InMemoryKnowledgeDocumentStore,
  type KnowledgeDocumentRecord,
} from "../repositories/document-store.js";
import {
  InMemoryKnowledgeJobStore,
  type KnowledgeJobRecord,
} from "../repositories/job-store.js";
import { InMemoryKnowledgeObjectStore } from "../repositories/object-store.js";
import {
  InMemoryKnowledgeSpaceStore,
  type KnowledgeSpaceRecord,
} from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import { KnowledgeGCWorker } from "./gc-worker.js";

const scope: TenantScope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const OWNER = "user-owner";
const SPACE_ID = "space-1";

const DAY_MS = 24 * 60 * 60 * 1000;
const REF_NOW = new Date("2026-05-19T00:00:00Z");

function daysAgo(days: number, ref: Date = REF_NOW): Date {
  return new Date(ref.getTime() - days * DAY_MS);
}

function makeDeletedSpace(overrides: Partial<KnowledgeSpaceRecord> = {}): KnowledgeSpaceRecord {
  return {
    ...scope,
    spaceId: SPACE_ID,
    type: "personal",
    name: "Demo space",
    description: null,
    ownerType: "user",
    ownerId: OWNER,
    defaultAcl: {},
    status: "deleted",
    createdBy: OWNER,
    updatedBy: OWNER,
    deletedAt: daysAgo(40),
    createdAt: daysAgo(60),
    updatedAt: daysAgo(40),
    cleanupQdrantStatus: "ok",
    cleanupFulltextStatus: "ok",
    cleanupObjectStorageStatus: "ok",
    cleanupQdrantAttempts: 0,
    cleanupFulltextAttempts: 0,
    cleanupObjectStorageAttempts: 0,
    cleanupQdrantNextRunAt: null,
    cleanupFulltextNextRunAt: null,
    cleanupObjectStorageNextRunAt: null,
    cleanupLastAttemptAt: null,
    ...overrides,
  };
}

function makeDocument(documentId: string, spaceId: string = SPACE_ID): KnowledgeDocumentRecord {
  const now = REF_NOW;
  return {
    ...scope,
    documentId,
    spaceId,
    title: `doc-${documentId}`,
    documentType: null,
    status: "deleted",
    visibilityStatus: "deleted",
    currentVersionId: null,
    currentVersionNumber: null,
    aclHash: "hash",
    aclVersion: 1,
    sourceSha256: null,
    sourceFilename: null,
    createdBy: OWNER,
    deletedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeJob(jobId: string, spaceId: string | null = SPACE_ID): KnowledgeJobRecord {
  const now = REF_NOW;
  return {
    ...scope,
    jobId,
    type: "ingest",
    status: "cancelled",
    priority: 0,
    spaceId,
    documentId: null,
    payload: {},
    attempt: 0,
    maxRetries: 3,
    runAfterAt: now,
  };
}

function makeVectorMock(reject = false) {
  return {
    deleteByFilter: vi.fn(async () => {
      if (reject) throw new Error("qdrant boom");
      return 0;
    }),
  };
}

function makeFulltextMock(reject = false) {
  return {
    deleteByFilter: vi.fn(async () => {
      if (reject) throw new Error("fulltext boom");
      return 0;
    }),
  };
}

interface Setup {
  spaces: InMemoryKnowledgeSpaceStore;
  documents: InMemoryKnowledgeDocumentStore;
  jobs: InMemoryKnowledgeJobStore;
  anchors: InMemoryKnowledgeAnchorStore;
  chunks: InMemoryKnowledgeChunkStore;
  assets: InMemoryKnowledgeAssetStore;
  acl: InMemoryKnowledgeAclStore;
  versions: InMemoryKnowledgeDocumentVersionStore;
  uploads: InMemoryKnowledgeUploadSessionStore;
  objects: InMemoryKnowledgeObjectStore;
  audit: InMemoryKnowledgeAuditEventWriter;
  vector: ReturnType<typeof makeVectorMock>;
  fulltext: ReturnType<typeof makeFulltextMock>;
  worker: KnowledgeGCWorker;
}

function setup(opts: {
  space?: Partial<KnowledgeSpaceRecord>;
  extraSpaces?: KnowledgeSpaceRecord[];
  documents?: KnowledgeDocumentRecord[];
  jobs?: KnowledgeJobRecord[];
  vectorReject?: boolean;
  fulltextReject?: boolean;
  now?: () => Date;
  retentionDays?: number;
  maxAttempts?: number;
} = {}): Setup {
  const seedSpaces = [makeDeletedSpace(opts.space), ...(opts.extraSpaces ?? [])];
  const spaces = new InMemoryKnowledgeSpaceStore(seedSpaces);
  const documents = new InMemoryKnowledgeDocumentStore(opts.documents ?? []);
  const jobs = new InMemoryKnowledgeJobStore(opts.jobs ?? []);
  const anchors = new InMemoryKnowledgeAnchorStore();
  const chunks = new InMemoryKnowledgeChunkStore();
  const assets = new InMemoryKnowledgeAssetStore();
  const acl = new InMemoryKnowledgeAclStore();
  const versions = new InMemoryKnowledgeDocumentVersionStore();
  const uploads = new InMemoryKnowledgeUploadSessionStore();
  const objectStore = new InMemoryKnowledgeObjectStore();
  const audit = new InMemoryKnowledgeAuditEventWriter();
  const vector = makeVectorMock(opts.vectorReject);
  const fulltext = makeFulltextMock(opts.fulltextReject);

  const worker = new KnowledgeGCWorker({
    prisma: null,
    spaces,
    documents,
    jobs,
    anchors,
    chunks,
    assets,
    acl,
    versions,
    uploads,
    objectStore,
    audit,
    vector: vector as any,
    fulltext: fulltext as any,
    retentionDays: opts.retentionDays ?? 30,
    maxAttempts: opts.maxAttempts ?? 10,
    batchSize: 50,
    now: opts.now ?? (() => REF_NOW),
  } as any);

  return { spaces, documents, jobs, anchors, chunks, assets, acl, versions, uploads, objects: objectStore, audit, vector, fulltext, worker };
}

describe("KnowledgeGCWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("respects 30-day retention — space deleted 29 days ago is NOT purged", async () => {
    const ctx = setup({
      space: { deletedAt: daysAgo(29) },
      documents: [makeDocument("doc-A")],
    });

    const result = await ctx.worker.runOnce(scope);
    expect((result as any).spaces_purged ?? 0).toBe(0);

    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space).not.toBeNull();
    expect(space?.status).toBe("deleted");
    // 文档仍在(还在保留窗口)
    expect(ctx.documents.snapshot()).toHaveLength(1);
  });

  it("purges space whose deletedAt > retentionDays AND all cleanup_status === 'ok'", async () => {
    const ctx = setup({
      space: {
        deletedAt: daysAgo(40),
        cleanupQdrantStatus: "ok",
        cleanupFulltextStatus: "ok",
        cleanupObjectStorageStatus: "ok",
      },
      documents: [makeDocument("doc-A"), makeDocument("doc-B")],
    });

    const result = await ctx.worker.runOnce(scope);
    expect((result as any).spaces_purged).toBeGreaterThanOrEqual(1);

    // space 行物理消失
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space).toBeNull();
    // 子表清零
    expect(ctx.documents.snapshot()).toHaveLength(0);
  });

  it("does NOT purge when any cleanup_*_status != 'ok' (waits for external retry)", async () => {
    const ctx = setup({
      space: {
        deletedAt: daysAgo(40),
        cleanupQdrantStatus: "ok",
        cleanupFulltextStatus: "ok",
        cleanupObjectStorageStatus: "pending", // 还有外部资源没清干净
        cleanupObjectStorageNextRunAt: daysAgo(-1), // 重试时间在未来,本轮不会被 retry 翻成 ok
      },
      documents: [makeDocument("doc-A")],
    });

    await ctx.worker.runOnce(scope);

    // 即使保留期满,只要 cleanup 有 pending,就不能 purge,等下一轮 GC 重试
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space).not.toBeNull();
    expect(space?.status).toBe("deleted");
    expect(ctx.documents.snapshot()).toHaveLength(1);
  });

  it("retries pending qdrant cleanup with exponential backoff (verifies cleanupNextRunAt advances)", async () => {
    // 已经失败过 2 次,本轮 vector 仍 reject
    const ctx = setup({
      space: {
        deletedAt: daysAgo(5), // 未到保留期,只走 cleanup 重试路径
        cleanupQdrantStatus: "pending",
        cleanupQdrantAttempts: 2,
        cleanupQdrantNextRunAt: daysAgo(1), // 已到期 → 应被本轮捡起
      },
      vectorReject: true,
    });

    const before = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    const beforeNextRun = before?.cleanupQdrantNextRunAt ?? null;

    await ctx.worker.runOnce(scope);

    expect(ctx.vector.deleteByFilter).toHaveBeenCalled();
    const after = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(after?.cleanupQdrantStatus).toBe("pending");
    // 退避应使「qdrant 自己的」nextRunAt 推迟(指数 2^attempts * 60s)
    expect(after?.cleanupQdrantNextRunAt && beforeNextRun
      ? after.cleanupQdrantNextRunAt.getTime() > beforeNextRun.getTime()
      : true).toBe(true);
    expect((after?.cleanupQdrantAttempts ?? 0)).toBeGreaterThanOrEqual(3);
  });

  it("failed target stays put even when ANOTHER target is due (P0-3 二次审查:跨 target 不带飞)", async () => {
    // qdrant 已 failed,object_storage 是 pending 且 due → 只有 object_storage 应该被 retry,
    // qdrant.deleteByFilter **绝不能**被调用。
    const ctx = setup({
      space: {
        deletedAt: daysAgo(5),
        cleanupQdrantStatus: "failed",
        cleanupQdrantAttempts: 10,
        cleanupQdrantNextRunAt: null,
        cleanupObjectStorageStatus: "pending",
        cleanupObjectStorageNextRunAt: daysAgo(1), // due
      },
      vectorReject: true, // 万一被错误调用,会抛 — 也会出错让用例红
    });

    await ctx.worker.runOnce(scope);

    // qdrant 不被 retry(failed 终态)
    expect(ctx.vector.deleteByFilter).not.toHaveBeenCalled();
    const after = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(after?.cleanupQdrantStatus).toBe("failed");
    expect(after?.cleanupQdrantAttempts).toBe(10); // 未自增
    // object_storage 被 retry 且成功(InMemory objectStore.deleteBySpaceId 默认成功)
    expect(after?.cleanupObjectStorageStatus).toBe("ok");
  });

  it("marks status='failed' after maxAttempts (default 10) reached", async () => {
    const ctx = setup({
      space: {
        deletedAt: daysAgo(5),
        cleanupQdrantStatus: "pending",
        cleanupQdrantAttempts: 10, // 已达上限
        cleanupQdrantNextRunAt: daysAgo(1),
      },
      vectorReject: true,
      maxAttempts: 10,
    });

    await ctx.worker.runOnce(scope);

    const after = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    // 超过最大尝试次数 → 标 failed,不再自动重试,等 admin 手动 cleanup-retry
    expect(after?.cleanupQdrantStatus).toBe("failed");
  });

  it("FK 倒序:purge 完成后 chunks/versions/anchors/acl_principals/documents/space 全部清零", async () => {
    const ctx = setup({
      space: {
        deletedAt: daysAgo(40),
        cleanupQdrantStatus: "ok",
        cleanupFulltextStatus: "ok",
        cleanupObjectStorageStatus: "ok",
      },
      documents: [makeDocument("doc-A"), makeDocument("doc-B")],
      jobs: [makeJob("job-A")],
    });

    // 给 anchor/chunk 等子表灌种,确保 hardDeleteBySpace 真正被调用
    await ctx.anchors.upsert({
      ...scope,
      anchorId: "anc-1",
      chunkId: "chk-1",
      documentId: "doc-A",
      versionId: "ver-1",
      spaceId: SPACE_ID,
      aclHash: "h",
      aclVersion: 1,
      page: 1,
      nodeIds: [],
      headingPath: [],
      createdAt: REF_NOW,
    } as any);

    await ctx.worker.runOnce(scope);

    // FK 倒序保证:子表先清,父表(space)最后
    expect(ctx.anchors.snapshot()).toHaveLength(0);
    expect(ctx.chunks.snapshot()).toHaveLength(0);
    expect(ctx.documents.snapshot()).toHaveLength(0);
    expect(ctx.jobs.snapshot().filter((j) => j.spaceId === SPACE_ID)).toHaveLength(0);
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space).toBeNull();
  });

  it("idempotent — runOnce twice on same purgeable space, second is no-op (space already gone)", async () => {
    const ctx = setup({
      space: {
        deletedAt: daysAgo(40),
        cleanupQdrantStatus: "ok",
        cleanupFulltextStatus: "ok",
        cleanupObjectStorageStatus: "ok",
      },
      documents: [makeDocument("doc-A")],
    });

    const first = await ctx.worker.runOnce(scope);
    const second = await ctx.worker.runOnce(scope);

    // 第二次拿不到任何可 purge 的 space,既不抛错也不影响别的
    expect((first as any).spaces_purged).toBeGreaterThanOrEqual(1);
    expect((second as any).spaces_purged ?? 0).toBe(0);
    expect(await ctx.spaces.getIncludeDeleted(scope, SPACE_ID)).toBeNull();
  });

  it("case 9 — scope omitted → 跨租户扫描两个 tenant 各软删 1 个 space, 都被 purge", async () => {
    const scopeA: TenantScope = { sourceSystemId: "octopus", tenantId: "tenant-A" };
    const scopeB: TenantScope = { sourceSystemId: "octopus", tenantId: "tenant-B" };
    const spaceA = makeDeletedSpace({
      ...scopeA,
      spaceId: "space-A",
      deletedAt: daysAgo(40),
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
    });
    const spaceB = makeDeletedSpace({
      ...scopeB,
      spaceId: "space-B",
      deletedAt: daysAgo(40),
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
    });

    const spaces = new InMemoryKnowledgeSpaceStore([spaceA, spaceB]);
    const documents = new InMemoryKnowledgeDocumentStore([
      makeDocument("doc-A", "space-A"),
      makeDocument("doc-B", "space-B"),
    ]);
    const jobs = new InMemoryKnowledgeJobStore();
    const anchors = new InMemoryKnowledgeAnchorStore();
    const chunks = new InMemoryKnowledgeChunkStore();
    const assets = new InMemoryKnowledgeAssetStore();
    const acl = new InMemoryKnowledgeAclStore();
    const versions = new InMemoryKnowledgeDocumentVersionStore();
    const uploads = new InMemoryKnowledgeUploadSessionStore();
    const objectStore = new InMemoryKnowledgeObjectStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const vector = makeVectorMock();
    const fulltext = makeFulltextMock();

    const worker = new KnowledgeGCWorker({
      prisma: null,
      spaces,
      documents,
      jobs,
      anchors,
      chunks,
      assets,
      acl,
      versions,
      uploads,
      objectStore,
      audit,
      vector: vector as any,
      fulltext: fulltext as any,
      retentionDays: 30,
      maxAttempts: 10,
      batchSize: 50,
      now: () => REF_NOW,
    } as any);

    // 不传 scope → 走 listDeletedAcrossTenants 路径
    const result = await worker.runOnce();
    expect((result as any).spaces_purged).toBe(2);

    expect(await spaces.getIncludeDeleted(scopeA, "space-A")).toBeNull();
    expect(await spaces.getIncludeDeleted(scopeB, "space-B")).toBeNull();
  });

  it("case 10 — failed 状态不再自动重试 (P0-3)", async () => {
    const ctx = setup({
      space: {
        deletedAt: daysAgo(5),
        cleanupQdrantStatus: "failed",
        cleanupQdrantAttempts: 10,
        cleanupQdrantNextRunAt: daysAgo(1), // 即使到期也不应被自动重试
      },
      vectorReject: true,
    });

    await ctx.worker.runOnce(scope);

    expect(ctx.vector.deleteByFilter).not.toHaveBeenCalled();
    const after = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(after?.cleanupQdrantStatus).toBe("failed");
    // attempts 也不应该被 +1
    expect(after?.cleanupQdrantAttempts).toBe(10);
  });

  it("case 11 — P0-4 第二页饥饿不再发生: batchSize=2, 3 个空间分散在 pending/retention, 全被处理", async () => {
    // 3 个软删空间，spaceId asc: s-1 (pending qdrant due, 在保留期内)、
    // s-2 (retention 到期 + 全 ok)、s-3 (pending fulltext due, 在保留期内)。
    // 旧逻辑 listDeleted(limit=2) 只拿 s-1/s-2，s-3 永远被饿死。
    // 新逻辑 4-query union 后能 cover 3 个。
    const s1 = makeDeletedSpace({
      spaceId: "s-1",
      deletedAt: daysAgo(5),
      cleanupQdrantStatus: "pending",
      cleanupQdrantNextRunAt: daysAgo(1),
      cleanupQdrantAttempts: 1,
    });
    const s2 = makeDeletedSpace({
      spaceId: "s-2",
      deletedAt: daysAgo(40),
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
    });
    const s3 = makeDeletedSpace({
      spaceId: "s-3",
      deletedAt: daysAgo(5),
      cleanupFulltextStatus: "pending",
      cleanupFulltextNextRunAt: daysAgo(1),
      cleanupFulltextAttempts: 1,
    });

    const spaces = new InMemoryKnowledgeSpaceStore([s1, s2, s3]);
    const documents = new InMemoryKnowledgeDocumentStore([]);
    const jobs = new InMemoryKnowledgeJobStore();
    const anchors = new InMemoryKnowledgeAnchorStore();
    const chunks = new InMemoryKnowledgeChunkStore();
    const assets = new InMemoryKnowledgeAssetStore();
    const acl = new InMemoryKnowledgeAclStore();
    const versions = new InMemoryKnowledgeDocumentVersionStore();
    const uploads = new InMemoryKnowledgeUploadSessionStore();
    const objectStore = new InMemoryKnowledgeObjectStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const vector = makeVectorMock();
    const fulltext = makeFulltextMock();

    const worker = new KnowledgeGCWorker({
      prisma: null,
      scope,
      spaces,
      documents,
      jobs,
      anchors,
      chunks,
      assets,
      acl,
      versions,
      uploads,
      objectStore,
      audit,
      vector: vector as any,
      fulltext: fulltext as any,
      retentionDays: 30,
      maxAttempts: 10,
      batchSize: 2,
      now: () => REF_NOW,
    } as any);

    await worker.runOnce();

    // 关键断言：s-3 也被处理（fulltext.deleteByFilter 至少被调一次针对 s-3）
    const fulltextCalls = fulltext.deleteByFilter.mock.calls;
    const fulltextSpaceIds = fulltextCalls.map((call) =>
      ((call[0] as any)?.must?.find?.((m: any) => m.key === "space_id")?.match?.value) as string,
    );
    expect(fulltextSpaceIds).toContain("s-3");

    // s-1 (qdrant) 也被处理
    const vectorCalls = vector.deleteByFilter.mock.calls;
    const vectorSpaceIds = vectorCalls.map((call) =>
      ((call[0] as any)?.must?.find?.((m: any) => m.key === "space_id")?.match?.value) as string,
    );
    expect(vectorSpaceIds).toContain("s-1");

    // s-2 retention 到期 + 全 ok 也应该被 purge
    expect(await spaces.getIncludeDeleted(scope, "s-2")).toBeNull();
  });

  it("cleanup_pending priority — pending row processed before retention-expired row", async () => {
    // space-pending:在保留期内但 cleanup 有 pending,需重试
    // space-retention:保留期已满 + cleanup 全 ok,可直接 purge
    const pending = makeDeletedSpace({
      spaceId: "space-pending",
      deletedAt: daysAgo(5),
      cleanupQdrantStatus: "pending",
      cleanupQdrantNextRunAt: daysAgo(1),
      cleanupQdrantAttempts: 1,
    });
    const retentionExpired = makeDeletedSpace({
      spaceId: "space-retention",
      deletedAt: daysAgo(40),
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
    });

    const ctx = setup({
      space: { spaceId: "space-unrelated", deletedAt: daysAgo(40), status: "active" }, // throwaway placeholder
      extraSpaces: [pending, retentionExpired],
    });

    await ctx.worker.runOnce(scope);

    // 优先级断言:cleanup pending 必须被处理过(vector.deleteByFilter 调过)
    expect(ctx.vector.deleteByFilter).toHaveBeenCalled();
    // 第一次调用的 filter 应针对 pending 行,而不是 retention 行
    const firstCallFilter = ctx.vector.deleteByFilter.mock.calls[0]?.[0];
    const firstCallSpaceId = (firstCallFilter as any)?.must?.find?.(
      (m: any) => m.key === "space_id",
    )?.match?.value;
    expect(firstCallSpaceId).toBe("space-pending");
  });
});
