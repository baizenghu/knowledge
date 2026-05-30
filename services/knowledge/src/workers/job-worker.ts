import type { KnowledgeJobRecord, KnowledgeJobStore } from "../repositories/job-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";

export type JobProcessorResult =
  | { status: "succeeded" }
  | { status: "degraded"; reason: string };

export type JobProcessor = (job: KnowledgeJobRecord, signal: AbortSignal) => Promise<JobProcessorResult | void>;

export type JobWorkerOptions = {
  workerId: string;
  scope?: TenantScope;
  store: KnowledgeJobStore;
  processors: Record<string, JobProcessor>;
  now?: () => Date;
  retryDelayMs?: number;
  leaseTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  onLeaseLost?: (job: KnowledgeJobRecord) => void;
  onError?: (error: unknown) => void;
  /** Number of concurrent processing loops to spawn in start(). Defaults to 1. */
  concurrency?: number;
};

export class KnowledgeJobWorker {
  private running = false;
  private loopPromises: Promise<void>[] = [];

  constructor(private readonly options: JobWorkerOptions) {}

  start(pollIntervalMs = 1_000): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const concurrency = Math.max(1, this.options.concurrency ?? 1);
    this.loopPromises = [];
    for (let i = 0; i < concurrency; i++) {
      this.loopPromises.push(this.loop(pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loopPromises);
    this.loopPromises = [];
  }

  async runOnce(): Promise<"processed" | "idle"> {
    const now = this.options.now?.() ?? new Date();
    const claimOptions = {
      workerId: this.options.workerId,
      now,
      leaseTimeoutMs: this.options.leaseTimeoutMs,
    };
    const job = this.options.scope
      ? await this.options.store.claimNext(this.options.scope, claimOptions)
      : await this.options.store.claimNextAny(claimOptions);
    if (!job) {
      return "idle";
    }

    const processor = this.options.processors[job.type];
    if (!processor) {
      console.error(`[knowledge-worker] no processor registered for job type: ${job.type} (job=${job.jobId})`);
      await this.options.store.fail(jobScope(job), job.jobId, this.options.workerId, {
        errorCode: "JOB_PROCESSOR_NOT_FOUND",
        errorMessage: `no processor registered for job type: ${job.type}`,
        now,
        retryDelayMs: this.options.retryDelayMs,
      });
      return "processed";
    }

    const abortController = new AbortController();
    let leaseLost = false;
    const heartbeatIntervalMs = this.options.heartbeatIntervalMs
      ?? Math.min(30_000, Math.max(1_000, Math.floor((this.options.leaseTimeoutMs ?? 5 * 60_000) / 3)));
    const heartbeatTimer = setInterval(() => {
      void this.options.store
        .heartbeat(jobScope(job), job.jobId, this.options.workerId, this.options.now?.() ?? new Date())
        .then((ok) => {
          if (!ok && !leaseLost) {
            leaseLost = true;
            abortController.abort();
            this.options.onLeaseLost?.(job);
          }
        });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    try {
      const result = await processor(job, abortController.signal);
      const finishedAt = this.options.now?.() ?? new Date();
      if (result?.status === "degraded") {
        const ok = await this.options.store.markDegraded(jobScope(job), job.jobId, this.options.workerId, result.reason, finishedAt);
        if (!ok) {
          this.options.onLeaseLost?.(job);
        }
      } else {
        const ok = await this.options.store.complete(jobScope(job), job.jobId, this.options.workerId, finishedAt);
        if (!ok) {
          this.options.onLeaseLost?.(job);
        }
      }
    } catch (err) {
      if (abortController.signal.aborted || leaseLost) {
        return "processed";
      }
      // 之前这里把错误悄悄吞掉只写 job 状态;document.status 仍然停在 indexing/parsing,
      // 运维只能从 job 表反查。现在至少把 stack 打到 stderr,后续接 pino 时再结构化。
      console.error(
        `[knowledge-worker] job ${job.jobId} (type=${job.type}, attempt=${job.attempt}/${job.maxRetries}) failed:`,
        err instanceof Error ? err.stack ?? err.message : err,
      );
      const failedAt = this.options.now?.() ?? new Date();
      await this.options.store.fail(jobScope(job), job.jobId, this.options.workerId, {
        errorCode: "JOB_PROCESSOR_FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
        now: failedAt,
        retryDelayMs: this.options.retryDelayMs,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }

    return "processed";
  }

  private async loop(pollIntervalMs: number): Promise<void> {
    while (this.running) {
      try {
        const result = await this.runOnce();
        if (result === "idle") {
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        if (this.options.onError) {
          this.options.onError(error);
        } else {
          console.error("[knowledge-worker] polling loop error", error);
        }
        await sleep(pollIntervalMs);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobScope(job: KnowledgeJobRecord): TenantScope {
  return {
    sourceSystemId: job.sourceSystemId,
    tenantId: job.tenantId,
  };
}
