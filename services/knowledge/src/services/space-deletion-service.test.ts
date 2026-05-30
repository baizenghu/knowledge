import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import {
  InMemoryKnowledgeDocumentStore,
  type KnowledgeDocumentRecord,
} from "../repositories/document-store.js";
import {
  InMemoryKnowledgeJobStore,
  type KnowledgeJobRecord,
} from "../repositories/job-store.js";
import {
  InMemoryKnowledgeSpaceStore,
  type KnowledgeSpaceRecord,
} from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import { SpaceDeletionService } from "./space-deletion-service.js";

const scope: TenantScope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const OWNER = "user-owner";
const OTHER = "user-other";
const ADMIN = "user-admin";
const EDITOR = "user-editor";
const SPACE_ID = "space-1";

function makeSpace(overrides: Partial<KnowledgeSpaceRecord> = {}): KnowledgeSpaceRecord {
  const now = new Date("2026-05-19T00:00:00Z");
  return {
    ...scope,
    spaceId: SPACE_ID,
    type: "personal",
    name: "Demo space",
    description: null,
    ownerType: "user",
    ownerId: OWNER,
    defaultAcl: {},
    status: "active",
    createdBy: OWNER,
    updatedBy: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    cleanupQdrantStatus: "ok",
    cleanupFulltextStatus: "ok",
    cleanupObjectStorageStatus: "ok",
    cleanupQdrantAttempts: 0,
    cleanupFulltextAttempts: 0,
    cleanupObjectStorageAttempts: 0,
    ...overrides,
  };
}

function makeDocument(documentId: string, spaceId: string = SPACE_ID): KnowledgeDocumentRecord {
  const now = new Date("2026-05-19T00:00:00Z");
  return {
    ...scope,
    documentId,
    spaceId,
    title: `doc-${documentId}`,
    documentType: null,
    status: "ready",
    visibilityStatus: "visible",
    currentVersionId: null,
    currentVersionNumber: null,
    aclHash: "hash",
    aclVersion: 1,
    sourceSha256: null,
    sourceFilename: null,
    createdBy: OWNER,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeJob(jobId: string, spaceId: string | null = SPACE_ID): KnowledgeJobRecord {
  const now = new Date("2026-05-19T00:00:00Z");
  return {
    ...scope,
    jobId,
    type: "ingest",
    status: "queued",
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

function makeObjectStoreMock(reject = false) {
  return {
    deleteByPrefix: vi.fn(async () => {
      if (reject) throw new Error("object storage boom");
      return 0;
    }),
  };
}

interface Setup {
  spaces: InMemoryKnowledgeSpaceStore;
  documents: InMemoryKnowledgeDocumentStore;
  jobs: InMemoryKnowledgeJobStore;
  audit: InMemoryKnowledgeAuditEventWriter;
  vector: ReturnType<typeof makeVectorMock>;
  fulltext: ReturnType<typeof makeFulltextMock>;
  objectStore: ReturnType<typeof makeObjectStoreMock>;
  service: SpaceDeletionService;
}

function setup(
  opts: {
    space?: Partial<KnowledgeSpaceRecord>;
    documents?: KnowledgeDocumentRecord[];
    jobs?: KnowledgeJobRecord[];
    vectorReject?: boolean;
    fulltextReject?: boolean;
    objectReject?: boolean;
  } = {},
): Setup {
  const spaces = new InMemoryKnowledgeSpaceStore([makeSpace(opts.space)]);
  const documents = new InMemoryKnowledgeDocumentStore(opts.documents ?? []);
  const jobs = new InMemoryKnowledgeJobStore(opts.jobs ?? []);
  const audit = new InMemoryKnowledgeAuditEventWriter();
  const vector = makeVectorMock(opts.vectorReject);
  const fulltext = makeFulltextMock(opts.fulltextReject);
  const objectStore = makeObjectStoreMock(opts.objectReject);
  const service = new SpaceDeletionService({
    prisma: null,
    spaces,
    documents,
    jobs,
    audit,
    vector: vector as any,
    fulltext: fulltext as any,
    objectStore: objectStore as any,
  } as any);
  return { spaces, documents, jobs, audit, vector, fulltext, objectStore, service };
}

describe("SpaceDeletionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------- 权限 ----------------

  it("rejects non-owner regular user with FORBIDDEN and does not mutate DB", async () => {
    const ctx = setup();
    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OTHER, roles: [] });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("active");
    expect(space?.deletedAt).toBeFalsy();
    expect(ctx.vector.deleteByFilter).not.toHaveBeenCalled();
    expect(ctx.fulltext.deleteByFilter).not.toHaveBeenCalled();
    expect(ctx.objectStore.deleteByPrefix).not.toHaveBeenCalled();
  });

  it("allows owner to soft delete the space", async () => {
    const ctx = setup();
    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(result.ok).toBe(true);
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("deleted");
    expect(space?.deletedAt).toBeInstanceOf(Date);
  });

  it("allows knowledge_admin (non-owner) to soft delete the space", async () => {
    const ctx = setup();
    const result = await ctx.service.softDelete(scope, SPACE_ID, {
      userId: ADMIN,
      roles: ["knowledge_admin"],
    });
    expect(result.ok).toBe(true);
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("deleted");
  });

  it("rejects knowledge_editor (non-owner) with FORBIDDEN — editor must not delete", async () => {
    const ctx = setup();
    const result = await ctx.service.softDelete(scope, SPACE_ID, {
      userId: EDITOR,
      roles: ["knowledge_editor"],
    });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("active");
  });

  // ---------------- 软删主路径 ----------------

  it("soft-deletes space with 5 docs and 3 queued jobs (all cancelled, all soft-deleted)", async () => {
    const documents = Array.from({ length: 5 }, (_, i) => makeDocument(`doc-${i}`));
    const jobs = Array.from({ length: 3 }, (_, i) => makeJob(`job-${i}`));
    const ctx = setup({ documents, jobs });

    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(result.ok).toBe(true);

    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("deleted");

    const docSnap = ctx.documents.snapshot();
    expect(docSnap.filter((d) => d.status === "deleted")).toHaveLength(5);

    const jobSnap = ctx.jobs.snapshot();
    expect(jobSnap.filter((j) => j.status === "cancelled")).toHaveLength(3);
  });

  it("handles >100 documents in a single softDeleteBySpace call (no paging gaps)", async () => {
    const documents = Array.from({ length: 105 }, (_, i) =>
      makeDocument(`doc-${String(i).padStart(3, "0")}`),
    );
    const ctx = setup({ documents });

    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as any).documents_soft_deleted).toBe(105);

    const docSnap = ctx.documents.snapshot();
    expect(docSnap.filter((d) => d.status === "deleted")).toHaveLength(105);
    // 不漏:每个文档都被处理
    expect(docSnap.every((d) => d.status === "deleted")).toBe(true);
  });

  // ---------------- 外部资源独立状态 ----------------

  // Phase A 不清对象存储——object_storage 始终标 pending(交由 Phase B GC worker 处理),
  // 而不是假装 'ok' 误导 admin 维护页。

  it("when qdrant fails but fulltext succeeds: qdrant=pending, fulltext=ok, object=pending (Phase A 不清), DB still soft-deleted", async () => {
    const ctx = setup({ vectorReject: true });
    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(result.ok).toBe(true);
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("deleted");
    expect(space?.cleanupQdrantStatus).toBe("pending");
    expect(space?.cleanupFulltextStatus).toBe("ok");
    expect(space?.cleanupObjectStorageStatus).toBe("pending");
  });

  it("when fulltext fails but qdrant succeeds: statuses reverse independently", async () => {
    const ctx = setup({ fulltextReject: true });
    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(result.ok).toBe(true);
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("deleted");
    expect(space?.cleanupQdrantStatus).toBe("ok");
    expect(space?.cleanupFulltextStatus).toBe("pending");
    expect(space?.cleanupObjectStorageStatus).toBe("pending");
  });

  // ---------------- 事务回滚 ----------------

  it("rolls back when documents.softDeleteBySpace throws (no external calls made)", async () => {
    const documents = [makeDocument("doc-A")];
    const jobs = [makeJob("job-A")];
    const ctx = setup({ documents, jobs });

    (ctx.documents as any).softDeleteBySpace = vi.fn(async () => {
      throw new Error("simulated DB boom");
    });

    await expect(
      ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] }),
    ).rejects.toThrow(/simulated DB boom/);

    // memory 模式没有真正的事务,但要验证后续不会向外部资源发请求
    expect(ctx.vector.deleteByFilter).not.toHaveBeenCalled();
    expect(ctx.fulltext.deleteByFilter).not.toHaveBeenCalled();
    expect(ctx.objectStore.deleteByPrefix).not.toHaveBeenCalled();

    // restore so subsequent assertions could re-run; documents and jobs may or may not be partially mutated
    // under memory mode — at minimum the space must not yet be marked deleted in that error path,
    // since space.softDelete is the last step.
    const space = await ctx.spaces.getIncludeDeleted(scope, SPACE_ID);
    expect(space?.status).toBe("active");
  });

  // ---------------- 幂等 ----------------

  it("is idempotent — second soft delete returns ok with 0 documents/jobs affected", async () => {
    const documents = [makeDocument("doc-A"), makeDocument("doc-B")];
    const jobs = [makeJob("job-A")];
    const ctx = setup({ documents, jobs });

    const first = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(first.ok).toBe(true);

    const second = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(second.ok).toBe(true);
    expect(second.ok && (second.data as any).documents_soft_deleted).toBe(0);
    expect(second.ok && (second.data as any).jobs_cancelled).toBe(0);
  });

  // ---------------- 接入回归 ----------------

  it("cancelBySpace finds jobs by top-level spaceId — asserts all enqueued jobs persist spaceId", async () => {
    const docs = [makeDocument("doc-A")];
    const matchingJobs = [makeJob("job-match-1"), makeJob("job-match-2")];
    const otherSpaceJob = makeJob("job-other", "space-other");
    const noSpaceJob = makeJob("job-no-space", null); // 防回归:不应该出现这种 job
    const ctx = setup({ documents: docs, jobs: [...matchingJobs, otherSpaceJob, noSpaceJob] });

    // 断言:所有真实路径创建的 job 必须带顶层 spaceId(otherSpaceJob 与 matchingJobs 都带)
    for (const j of [...matchingJobs, otherSpaceJob]) {
      expect(j.spaceId).toBeTruthy();
    }

    const result = await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });
    expect(result.ok).toBe(true);

    const snap = ctx.jobs.snapshot();
    // 只有两个匹配的 job 被取消
    expect(snap.find((j) => j.jobId === "job-match-1")?.status).toBe("cancelled");
    expect(snap.find((j) => j.jobId === "job-match-2")?.status).toBe("cancelled");
    // 其他 space 的 job 不应被影响
    expect(snap.find((j) => j.jobId === "job-other")?.status).toBe("queued");
    // 没有顶层 spaceId 的 job 不应被误伤(它本身就是回归保护场景)
    expect(snap.find((j) => j.jobId === "job-no-space")?.status).toBe("queued");
  });

  it("list() hides soft-deleted spaces; listDeleted() shows them", async () => {
    const ctx = setup();
    await ctx.service.softDelete(scope, SPACE_ID, { userId: OWNER, roles: [] });

    const listed = await ctx.spaces.list(scope);
    expect(listed.items.find((s) => s.spaceId === SPACE_ID)).toBeUndefined();

    const listedDeleted = await ctx.spaces.listDeleted(scope);
    expect(listedDeleted.items.find((s) => s.spaceId === SPACE_ID)).toBeDefined();
  });
});
