import { describe, expect, it, vi } from "vitest";
import { PrismaKnowledgeJobStore } from "./prisma-stores.js";
import type { KnowledgeJobRecord } from "./job-store.js";
import { JobsHub } from "../services/JobsHub.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

/** 用真 JobsHub + spy on emitStatus 记录所有被 ping 的 jobId(顺序保留)。 */
function hubWithSpy() {
  const hub = new JobsHub();
  const pings: string[] = [];
  const spy = vi.spyOn(hub, "emitStatus").mockImplementation((jobId: string) => {
    pings.push(jobId);
  });
  return { hub, pings, spy };
}

/** 取某个 mock 第一次调用的第一个入参(as any，避开 mock.calls 元组在不同 tsconfig 下的推断分叉)。 */
function firstCallArg(fn: { mock: { calls: unknown[][] } }): any {
  return (fn.mock.calls[0] as unknown[])[0];
}

function runningJob(overrides: Partial<KnowledgeJobRecord> = {}): KnowledgeJobRecord {
  return {
    ...scope,
    jobId: "job_1",
    type: "ingest",
    status: "running",
    priority: 100,
    attempt: 0,
    maxRetries: 1,
    lockedBy: "worker-1",
    runAfterAt: new Date("2026-05-18T00:00:00.000Z"),
    ...overrides,
  } as KnowledgeJobRecord;
}

describe("PrismaKnowledgeJobStore — emit jobId ping on status transitions", () => {
  describe("complete", () => {
    it("emits when the conditional update affects a row (count === 1)", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const ok = await store.complete(scope, "job_1", "worker-1");

      expect(ok).toBe(true);
      expect(prisma.knowledgeJob.updateMany).toHaveBeenCalledTimes(1);
      expect(pings).toEqual(["job_1"]);
    });

    it("does NOT emit when the update affects no rows (count === 0)", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const ok = await store.complete(scope, "job_1", "worker-1");

      expect(ok).toBe(false);
      expect(pings).toEqual([]);
    });
  });

  describe("markDegraded", () => {
    it("emits when the conditional update affects a row (count === 1)", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const ok = await store.markDegraded(scope, "job_1", "worker-1", "embedding 500");

      expect(ok).toBe(true);
      expect(pings).toEqual(["job_1"]);
    });

    it("does NOT emit when the update affects no rows (count === 0)", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const ok = await store.markDegraded(scope, "job_1", "worker-1", "embedding 500");

      expect(ok).toBe(false);
      expect(pings).toEqual([]);
    });
  });

  describe("fail", () => {
    it("emits on the retry path (→ queued)", async () => {
      const { hub, pings } = hubWithSpy();
      // get() 被调用两次:进入时校验 + 收尾返回最新记录。第一次返回 running、收尾返回 queued。
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce(runningJob({ attempt: 0, maxRetries: 1 }))
        .mockResolvedValueOnce(runningJob({ status: "queued", attempt: 1, lockedBy: null }));
      const prisma = {
        knowledgeJob: {
          findFirst,
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const record = await store.fail(scope, "job_1", "worker-1", {
        errorCode: "PARSER_UNAVAILABLE",
        errorMessage: "parser down",
        retryDelayMs: 1000,
      });

      expect(record?.status).toBe("queued");
      expect(prisma.knowledgeJob.updateMany).toHaveBeenCalledTimes(1);
      expect(pings).toEqual(["job_1"]);
    });

    it("emits on the dead-letter path (→ dead_lettered)", async () => {
      const { hub, pings } = hubWithSpy();
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce(runningJob({ attempt: 1, maxRetries: 1 }))
        .mockResolvedValueOnce(runningJob({ status: "dead_lettered", attempt: 2, lockedBy: null }));
      const prisma = {
        knowledgeJob: {
          findFirst,
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const record = await store.fail(scope, "job_1", "worker-1", {
        errorCode: "PARSER_UNAVAILABLE",
        errorMessage: "parser still down",
      });

      expect(record?.status).toBe("dead_lettered");
      expect(pings).toEqual(["job_1"]);
    });

    it("does NOT emit when the job is not an owned running job", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          // 进入时校验直接拿不到 owned-running job → 提前 return null。
          findFirst: vi.fn().mockResolvedValueOnce(null),
          updateMany: vi.fn(),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const record = await store.fail(scope, "job_1", "worker-1", {
        errorCode: "X",
        errorMessage: "y",
      });

      expect(record).toBeNull();
      expect(prisma.knowledgeJob.updateMany).not.toHaveBeenCalled();
      expect(pings).toEqual([]);
    });
  });

  describe("claimNext / claimNextAny", () => {
    it("claimNext emits the claimed jobId (no $transaction path)", async () => {
      const { hub, pings } = hubWithSpy();
      const candidate = runningJob({ jobId: "job_claim", status: "queued", lockedBy: null });
      const prisma = {
        // 无 $transaction → 走 claim(this.prisma)
        knowledgeJob: {
          findFirst: vi
            .fn()
            // claim 内 candidate 查询
            .mockResolvedValueOnce(candidate)
            // 收尾 this.get() 返回 running 记录
            .mockResolvedValueOnce(runningJob({ jobId: "job_claim", lockedBy: "worker-1" })),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const record = await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T01:00:00.000Z") });

      expect(record?.jobId).toBe("job_claim");
      expect(pings).toEqual(["job_claim"]);
    });

    it("claimNext does NOT emit when there is no candidate", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          findFirst: vi.fn().mockResolvedValueOnce(null),
          updateMany: vi.fn(),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const record = await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T01:00:00.000Z") });

      expect(record).toBeNull();
      expect(pings).toEqual([]);
    });
  });

  describe("cancelDocumentJobs", () => {
    it("findMany picks ids, updateMany cancels, and each id is pinged", async () => {
      const { hub, pings } = hubWithSpy();
      const findMany = vi.fn(async () => [{ jobId: "job_a" }, { jobId: "job_b" }, { jobId: "job_c" }]);
      const updateMany = vi.fn(async () => ({ count: 3 }));
      const prisma = { knowledgeJob: { findMany, updateMany } };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const count = await store.cancelDocumentJobs(scope, "doc_1", "document_deleted");

      expect(count).toBe(3);
      expect(updateMany).toHaveBeenCalledTimes(1);
      // findMany 与 updateMany 的 where 必须完全一致(否则 emit 的 id 集与实际改的不符)。
      expect(firstCallArg(findMany).where).toEqual(firstCallArg(updateMany).where);
      expect(pings).toEqual(["job_a", "job_b", "job_c"]);
    });

    it("emits nothing when no document jobs match", async () => {
      const { hub, pings } = hubWithSpy();
      const prisma = {
        knowledgeJob: {
          findMany: vi.fn(async () => []),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const count = await store.cancelDocumentJobs(scope, "doc_1", "document_deleted");

      expect(count).toBe(0);
      expect(pings).toEqual([]);
    });
  });

  describe("cancelBySpace", () => {
    it("findMany picks ids, updateMany cancels, and each id is pinged", async () => {
      const { hub, pings } = hubWithSpy();
      const findMany = vi.fn(async () => [{ jobId: "job_x" }, { jobId: "job_y" }]);
      const updateMany = vi.fn(async () => ({ count: 2 }));
      const prisma = { knowledgeJob: { findMany, updateMany } };
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const count = await store.cancelBySpace(scope, "space_1", "space_deleted");

      expect(count).toBe(2);
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(firstCallArg(findMany).where).toEqual(firstCallArg(updateMany).where);
      // where 选中非终态(含 degraded),与 Prisma 实现保持一致。
      expect(firstCallArg(updateMany).where.status).toEqual({ in: ["queued", "running", "degraded"] });
      expect(pings).toEqual(["job_x", "job_y"]);
    });

    it("routes through the provided tx client for both findMany and updateMany", async () => {
      const { hub, pings } = hubWithSpy();
      const txFindMany = vi.fn(async () => [{ jobId: "job_tx" }]);
      const txUpdateMany = vi.fn(async () => ({ count: 1 }));
      const tx = { knowledgeJob: { findMany: txFindMany, updateMany: txUpdateMany } };
      // this.prisma 故意不带 knowledgeJob,确认未被误用(全部走 tx)。
      const prisma = {};
      const store = new PrismaKnowledgeJobStore(prisma as any, hub);

      const count = await store.cancelBySpace(scope, "space_1", "space_deleted", new Date(), tx as any);

      expect(count).toBe(1);
      expect(txFindMany).toHaveBeenCalledTimes(1);
      expect(txUpdateMany).toHaveBeenCalledTimes(1);
      expect(pings).toEqual(["job_tx"]);
    });
  });

  it("never throws when no hub is wired (hub is optional)", async () => {
    const prisma = {
      knowledgeJob: {
        findMany: vi.fn(async () => [{ jobId: "job_a" }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const store = new PrismaKnowledgeJobStore(prisma as any);
    await expect(store.cancelDocumentJobs(scope, "doc_1", "x")).resolves.toBe(1);
    await expect(store.complete(scope, "job_1", "worker-1")).resolves.toBe(true);
  });
});
