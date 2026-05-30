import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeJobStore, type KnowledgeJobRecord } from "./job-store.js";
import { JobsHub } from "../services/JobsHub.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

function job(overrides: Partial<KnowledgeJobRecord>): KnowledgeJobRecord {
  return {
    ...scope,
    jobId: "job_1",
    type: "ingest",
    status: "queued",
    priority: 100,
    attempt: 0,
    maxRetries: 1,
    runAfterAt: new Date("2026-05-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("InMemoryKnowledgeJobStore", () => {
  it("claims only jobs in the requested tenant scope", async () => {
    const store = new InMemoryKnowledgeJobStore([
      job({ jobId: "job_1" }),
      job({ sourceSystemId: "octopus", tenantId: "tenant-2", jobId: "job_2", priority: 1 }),
    ]);

    const claimed = await store.claimNext(scope, {
      workerId: "worker-1",
      now: new Date("2026-05-18T00:01:00.000Z"),
    });

    expect(claimed?.jobId).toBe("job_1");
    expect(claimed?.status).toBe("running");
  });

  it("claims higher numeric priority first", async () => {
    const store = new InMemoryKnowledgeJobStore([
      job({ jobId: "job_normal", priority: 100 }),
      job({ jobId: "job_urgent", priority: 500 }),
    ]);

    const claimed = await store.claimNext(scope, {
      workerId: "worker-1",
      now: new Date("2026-05-18T00:01:00.000Z"),
    });

    expect(claimed?.jobId).toBe("job_urgent");
  });

  it("reclaims stale running jobs", async () => {
    const store = new InMemoryKnowledgeJobStore([
      job({
        jobId: "job_stale",
        status: "running",
        lockedBy: "dead-worker",
        lockedAt: new Date("2026-05-18T00:00:00.000Z"),
      }),
    ]);

    const claimed = await store.claimNext(scope, {
      workerId: "worker-2",
      now: new Date("2026-05-18T00:10:00.000Z"),
      leaseTimeoutMs: 5 * 60_000,
    });

    expect(claimed?.jobId).toBe("job_stale");
    expect(claimed?.lockedBy).toBe("worker-2");
  });

  it("moves failed jobs to retry queue and then dead letter", async () => {
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_retry" })]);
    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:00:00.000Z") });
    const retry = await store.fail(scope, "job_retry", "worker-1", {
      errorCode: "PARSER_UNAVAILABLE",
      errorMessage: "parser down",
      now: new Date("2026-05-18T00:00:01.000Z"),
      retryDelayMs: 1000,
    });

    expect(retry?.status).toBe("queued");
    expect(retry?.attempt).toBe(1);

    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:00:02.000Z") });
    const dead = await store.fail(scope, "job_retry", "worker-1", {
      errorCode: "PARSER_UNAVAILABLE",
      errorMessage: "parser still down",
      now: new Date("2026-05-18T00:00:03.000Z"),
      retryDelayMs: 1000,
    });

    expect(dead?.status).toBe("dead_lettered");
    expect(dead?.deadLetterAt).toEqual(new Date("2026-05-18T00:00:03.000Z"));
  });

  it("cancels queued and running jobs for a deleted document", async () => {
    const store = new InMemoryKnowledgeJobStore([
      job({ jobId: "job_queued", documentId: "doc_1" }),
      job({ jobId: "job_running", documentId: "doc_1", status: "running", lockedBy: "worker-1" }),
      job({ jobId: "job_other", documentId: "doc_2" }),
    ]);

    const cancelled = await store.cancelDocumentJobs(scope, "doc_1", "document_deleted by user-1", new Date("2026-05-18T00:00:00.000Z"));
    expect(cancelled).toBe(2);
    expect(store.snapshot().filter((item) => item.documentId === "doc_1").map((item) => item.status))
      .toEqual(["cancelled", "cancelled"]);
    expect(store.snapshot().find((item) => item.jobId === "job_queued")?.errorMessage)
      .toBe("document_deleted by user-1");
  });

  it("sanitizes sensitive error messages", async () => {
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_sensitive", maxRetries: 0 })]);
    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:00:00.000Z") });
    const failed = await store.fail(scope, "job_sensitive", "worker-1", {
      errorCode: "FAILED",
      errorMessage: "failed at /home/user/secret.txt token=abc123",
      now: new Date("2026-05-18T00:00:01.000Z"),
    });
    expect(failed?.errorMessage).toContain("[path]");
    expect(failed?.errorMessage).toContain("token=[redacted]");
  });
});

describe("InMemoryKnowledgeJobStore — emit jobId ping into a real JobsHub", () => {
  /** 订阅一组 jobId,把收到的 ping(按 jobId 计数)记进 Map。返回 [hub, pings, offAll]。 */
  function hubFor(jobIds: string[]): { hub: JobsHub; pings: string[]; offAll: () => void } {
    const hub = new JobsHub();
    const pings: string[] = [];
    const offs = jobIds.map((id) => hub.on(id, () => pings.push(id)));
    return { hub, pings, offAll: () => offs.forEach((off) => off()) };
  }

  it("claimNext pings the claimed job", async () => {
    const { hub, pings, offAll } = hubFor(["job_1"]);
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_1" })], hub);

    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:01:00.000Z") });

    expect(pings).toEqual(["job_1"]);
    offAll();
  });

  it("complete pings the completed job", async () => {
    const { hub, pings, offAll } = hubFor(["job_1"]);
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_1" })], hub);
    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:01:00.000Z") });
    pings.length = 0; // 丢掉 claimNext 的 ping，只看 complete

    const ok = await store.complete(scope, "job_1", "worker-1", new Date("2026-05-18T00:02:00.000Z"));

    expect(ok).toBe(true);
    expect(pings).toEqual(["job_1"]);
    offAll();
  });

  it("fail pings on both retry and dead-letter transitions", async () => {
    const { hub, pings, offAll } = hubFor(["job_retry"]);
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_retry" })], hub);

    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:00:00.000Z") });
    pings.length = 0;
    const retry = await store.fail(scope, "job_retry", "worker-1", {
      errorCode: "PARSER_UNAVAILABLE",
      errorMessage: "down",
      now: new Date("2026-05-18T00:00:01.000Z"),
      retryDelayMs: 1000,
    });
    expect(retry?.status).toBe("queued");
    expect(pings).toEqual(["job_retry"]); // retry ping

    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:00:02.000Z") });
    pings.length = 0;
    const dead = await store.fail(scope, "job_retry", "worker-1", {
      errorCode: "PARSER_UNAVAILABLE",
      errorMessage: "still down",
      now: new Date("2026-05-18T00:00:03.000Z"),
      retryDelayMs: 1000,
    });
    expect(dead?.status).toBe("dead_lettered");
    expect(pings).toEqual(["job_retry"]); // dead-letter ping
    offAll();
  });

  it("markDegraded pings the degraded job", async () => {
    const { hub, pings, offAll } = hubFor(["job_1"]);
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_1" })], hub);
    await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:00:00.000Z") });
    pings.length = 0;

    const ok = await store.markDegraded(scope, "job_1", "worker-1", "embedding 500", new Date("2026-05-18T00:00:01.000Z"));

    expect(ok).toBe(true);
    expect(pings).toEqual(["job_1"]);
    offAll();
  });

  it("cancelDocumentJobs pings each cancelled job (multiple)", async () => {
    const { hub, pings, offAll } = hubFor(["job_q", "job_r", "job_other"]);
    const store = new InMemoryKnowledgeJobStore(
      [
        job({ jobId: "job_q", documentId: "doc_1" }),
        job({ jobId: "job_r", documentId: "doc_1", status: "running", lockedBy: "worker-1" }),
        job({ jobId: "job_other", documentId: "doc_2" }),
      ],
      hub,
    );

    const cancelled = await store.cancelDocumentJobs(scope, "doc_1", "document_deleted", new Date("2026-05-18T00:00:00.000Z"));

    expect(cancelled).toBe(2);
    expect(pings.sort()).toEqual(["job_q", "job_r"]); // 逐条 ping，不含 doc_2 的 job_other
    offAll();
  });

  it("cancelBySpace pings each cancelled job including degraded (multiple)", async () => {
    const { hub, pings, offAll } = hubFor(["job_q", "job_run", "job_deg", "job_done"]);
    const store = new InMemoryKnowledgeJobStore(
      [
        job({ jobId: "job_q", spaceId: "space_1" }),
        job({ jobId: "job_run", spaceId: "space_1", status: "running", lockedBy: "worker-1" }),
        job({ jobId: "job_deg", spaceId: "space_1", status: "degraded" }),
        job({ jobId: "job_done", spaceId: "space_1", status: "succeeded" }),
      ],
      hub,
    );

    const cancelled = await store.cancelBySpace(scope, "space_1", "space_deleted", new Date("2026-05-18T00:00:00.000Z"));

    // queued + running + degraded 被取消(与 Prisma where 一致);succeeded 不动。
    expect(cancelled).toBe(3);
    expect(pings.sort()).toEqual(["job_deg", "job_q", "job_run"]);
    offAll();
  });

  it("does not throw and works without a hub (hub optional)", async () => {
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_1" })]);
    const claimed = await store.claimNext(scope, { workerId: "worker-1", now: new Date("2026-05-18T00:01:00.000Z") });
    expect(claimed?.status).toBe("running");
  });
});
