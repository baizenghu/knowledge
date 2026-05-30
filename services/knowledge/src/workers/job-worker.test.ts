import { describe, expect, it, vi } from "vitest";
import { InMemoryKnowledgeJobStore, type KnowledgeJobRecord } from "../repositories/job-store.js";
import { KnowledgeJobWorker } from "./job-worker.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

function job(overrides: Partial<KnowledgeJobRecord>): KnowledgeJobRecord {
  return {
    ...scope,
    jobId: "job_1",
    type: "ingest",
    status: "queued",
    priority: 100,
    attempt: 0,
    maxRetries: 0,
    runAfterAt: new Date("2026-05-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("KnowledgeJobWorker", () => {
  it("processes a claimed job and marks it succeeded", async () => {
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_success" })]);
    const processor = vi.fn(async (_job: KnowledgeJobRecord, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return { status: "succeeded" as const };
    });
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: { ingest: processor },
      now: () => new Date("2026-05-18T00:01:00.000Z"),
    });

    expect(await worker.runOnce()).toBe("processed");
    expect(processor).toHaveBeenCalledOnce();
    expect(store.snapshot()[0]?.status).toBe("succeeded");
  });

  it("marks a processor degraded result as degraded", async () => {
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_degraded" })]);
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: { ingest: async () => ({ status: "degraded", reason: "plain_text_fallback" }) },
      now: () => new Date("2026-05-18T00:01:00.000Z"),
    });

    await worker.runOnce();
    expect(store.snapshot()[0]).toMatchObject({
      status: "degraded",
      degradedReason: "plain_text_fallback",
    });
  });

  it("dead-letters when processor is missing and retries are exhausted", async () => {
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_missing_processor", type: "parse" })]);
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: {},
      now: () => new Date("2026-05-18T00:01:00.000Z"),
    });

    await worker.runOnce();
    expect(store.snapshot()[0]).toMatchObject({
      status: "dead_lettered",
      errorCode: "JOB_PROCESSOR_NOT_FOUND",
    });
  });

  it("sends heartbeats while processor is running", async () => {
    vi.useFakeTimers();
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_heartbeat" })]);
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: {
        ingest: async (_job, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 3_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new Error("aborted"));
            });
          });
        },
      },
      now: () => new Date(Date.now()),
      heartbeatIntervalMs: 1_000,
    });

    const running = worker.runOnce();
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toBe("processed");
    expect(store.snapshot()[0]?.status).toBe("succeeded");
    vi.useRealTimers();
  });

  it("aborts processor when heartbeat loses lease", async () => {
    vi.useFakeTimers();
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_lost_lease" })]);
    const lostLease = vi.fn();
    let observedAbort = false;
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: {
        ingest: async (_job, signal) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        },
      },
      now: () => new Date(Date.now()),
      heartbeatIntervalMs: 1_000,
      onLeaseLost: lostLease,
    });

    const running = worker.runOnce();
    await vi.advanceTimersByTimeAsync(100);
    await store.claimNext(scope, {
      workerId: "worker-2",
      now: new Date(Date.now() + 10 * 60_000),
      leaseTimeoutMs: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await running).toBe("processed");
    expect(observedAbort).toBe(true);
    expect(lostLease).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("runs polling lifecycle until stopped", async () => {
    vi.useFakeTimers();
    const store = new InMemoryKnowledgeJobStore([job({ jobId: "job_lifecycle" })]);
    const processor = vi.fn(async () => ({ status: "succeeded" as const }));
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: { ingest: processor },
      now: () => new Date(Date.now()),
    });

    worker.start(1_000);
    await vi.advanceTimersByTimeAsync(10);
    const stopping = worker.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(processor).toHaveBeenCalledOnce();
    expect(store.snapshot()[0]?.status).toBe("succeeded");
    vi.useRealTimers();
  });

  it("processes jobs in parallel when concurrency > 1", async () => {
    const store = new InMemoryKnowledgeJobStore([
      job({ jobId: "job_parallel_a" }),
      job({ jobId: "job_parallel_b" }),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const started: Array<Promise<void>> = [
      new Promise<void>((resolve) => release.push(resolve)),
      new Promise<void>((resolve) => release.push(resolve)),
    ];
    const startedSignals: Array<() => void> = [];
    const startedPromises = [
      new Promise<void>((resolve) => startedSignals.push(resolve)),
      new Promise<void>((resolve) => startedSignals.push(resolve)),
    ];
    let callIdx = 0;
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      scope,
      store,
      processors: {
        ingest: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const idx = callIdx++;
          startedSignals[idx]?.();
          await started[idx];
          inFlight -= 1;
          return { status: "succeeded" as const };
        },
      },
      now: () => new Date(Date.now()),
      concurrency: 2,
    });

    worker.start(50);
    await Promise.all(startedPromises);
    expect(maxInFlight).toBe(2);
    release.forEach((fn) => fn());
    await worker.stop();
    expect(store.snapshot().every((j) => j.status === "succeeded")).toBe(true);
  });

  it("claims jobs across tenants when no worker scope is provided", async () => {
    const otherScope = { sourceSystemId: "octopus", tenantId: "tenant-2" };
    const store = new InMemoryKnowledgeJobStore([
      job({ jobId: "job_tenant_2", ...otherScope }),
    ]);
    const processor = vi.fn(async () => ({ status: "succeeded" as const }));
    const worker = new KnowledgeJobWorker({
      workerId: "worker-1",
      store,
      processors: { ingest: processor },
      now: () => new Date("2026-05-18T00:01:00.000Z"),
    });

    await worker.runOnce();

    expect(processor).toHaveBeenCalledOnce();
    expect(await store.get(otherScope, "job_tenant_2")).toMatchObject({ status: "succeeded" });
  });
});
