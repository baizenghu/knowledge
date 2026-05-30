import type { JobStatus } from "@octopus/knowledge-contracts";
import {
  canClaimJobWithLease,
  cancelRunningJob,
  decideFailedJobTransition,
  markJobDegraded,
} from "../domain/jobs.js";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";
import type { JobsHub } from "../services/JobsHub.js";

export type KnowledgeJobRecord = TenantScope & {
  jobId: string;
  type: string;
  status: JobStatus;
  priority: number;
  /**
   * 顶层 space_id（schema.prisma 已有 model 字段，Phase A 起 runtime 也必须填写）。
   *
   * 用途：SpaceDeletionService 软删空间时按 spaceId 批量取消空间下所有未完成 job
   * （cancelBySpace），不再依赖 payload 内 space_id 或 documentId IN (...) fallback。
   *
   * 所有 enqueue 入口（document-service / reindex-service / upload-service）必须写入；
   * 单测在创建后断言 record.spaceId 非空，防止回归。
   */
  spaceId?: string | null;
  documentId?: string | null;
  payload?: unknown;
  progress?: unknown;
  attempt: number;
  maxRetries: number;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  runAfterAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  deadLetterAt?: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  degradedReason?: string | null;
};

export type ClaimJobOptions = {
  workerId: string;
  now?: Date;
  leaseTimeoutMs?: number;
};

export type JobFailureInput = {
  errorCode: string;
  errorMessage: string;
  now?: Date;
  retryDelayMs?: number;
};

export interface KnowledgeJobStore {
  add(job: KnowledgeJobRecord, tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord>;
  get(scope: TenantScope, jobId: string, tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null>;
  /**
   * Atomically transitions one queued or stale-lease running job to running.
   * Durable implementations MUST use SELECT ... FOR UPDATE SKIP LOCKED, a conditional
   * UPDATE with affected_rows check, or an equivalent atomic primitive.
   * Non-atomic read-then-write implementations can duplicate job processing.
   */
  claimNext(scope: TenantScope, options: ClaimJobOptions, tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null>;
  /**
   * Atomically claims the next job across all tenants. Worker pools should prefer this
   * over tenant-bound claimNext unless they intentionally run one worker per tenant.
   */
  claimNextAny(options: ClaimJobOptions, tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null>;
  heartbeat(scope: TenantScope, jobId: string, workerId: string, now?: Date, tx?: KnowledgeTxClient): Promise<boolean>;
  complete(scope: TenantScope, jobId: string, workerId: string, now?: Date, tx?: KnowledgeTxClient): Promise<boolean>;
  fail(scope: TenantScope, jobId: string, workerId: string, input: JobFailureInput, tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null>;
  markDegraded(scope: TenantScope, jobId: string, workerId: string, reason: string, now?: Date, tx?: KnowledgeTxClient): Promise<boolean>;
  cancelDocumentJobs(scope: TenantScope, documentId: string, reason: string, now?: Date, tx?: KnowledgeTxClient): Promise<number>;
  /**
   * 批量取消 space 下所有非终态 job。
   * 终态: succeeded | failed | dead_lettered | cancelled。
   * SpaceDeletionService 在同事务中调用，返回受影响行数。
   */
  cancelBySpace(scope: TenantScope, spaceId: string, reason: string, now?: Date, tx?: KnowledgeTxClient): Promise<number>;
  /**
   * GC worker 内部使用：物理删除空间下所有 job 行（含终态、cancelled）。
   * 与 cancelBySpace 不同：不检查 status，直接 deleteMany。
   */
  hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<number>;
  /**
   * Returns the most recently created job of the given type for the document,
   * regardless of status. Used by reindex to recover the original source
   * object_uri without storing it on the document record.
   */
  findLatestForDocument(scope: TenantScope, documentId: string, type: string, tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null>;
}

export class InMemoryKnowledgeJobStore implements KnowledgeJobStore {
  private readonly jobs = new Map<string, KnowledgeJobRecord>();

  constructor(seedJobs: KnowledgeJobRecord[] = [], private readonly hub?: JobsHub) {
    for (const job of seedJobs) {
      this.jobs.set(this.key(job.sourceSystemId, job.tenantId, job.jobId), { ...job });
    }
  }

  snapshot(): KnowledgeJobRecord[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  async add(job: KnowledgeJobRecord, _tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord> {
    requireTenantScope(job);
    const key = this.key(job.sourceSystemId, job.tenantId, job.jobId);
    if (this.jobs.has(key)) {
      throw new Error(`job already exists: ${job.jobId}`);
    }
    this.jobs.set(key, { ...job });
    return { ...job };
  }

  async get(scope: TenantScope, jobId: string, _tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const job = this.jobs.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, jobId));
    return job ? { ...job } : null;
  }

  async claimNext(scope: TenantScope, options: ClaimJobOptions, _tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const now = options.now ?? new Date();
    const leaseTimeoutMs = options.leaseTimeoutMs ?? 5 * 60_000;
    const candidates = [...this.jobs.values()]
      .filter((job) => job.sourceSystemId === safeScope.sourceSystemId && job.tenantId === safeScope.tenantId)
      .filter((job) => job.runAfterAt.getTime() <= now.getTime())
      .filter((job) => canClaimJobWithLease(job, now, leaseTimeoutMs))
      .sort((left, right) =>
        right.priority - left.priority
        || left.runAfterAt.getTime() - right.runAfterAt.getTime()
        || left.jobId.localeCompare(right.jobId),
      );

    const job = candidates[0];
    if (!job) {
      return null;
    }
    job.status = "running";
    job.lockedBy = options.workerId;
    job.lockedAt = now;
    job.startedAt ??= now;
    this.hub?.emitStatus(job.jobId);
    return { ...job };
  }

  async claimNextAny(options: ClaimJobOptions, _tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null> {
    const now = options.now ?? new Date();
    const leaseTimeoutMs = options.leaseTimeoutMs ?? 5 * 60_000;
    const candidates = [...this.jobs.values()]
      .filter((job) => job.runAfterAt.getTime() <= now.getTime())
      .filter((job) => canClaimJobWithLease(job, now, leaseTimeoutMs))
      .sort((left, right) =>
        right.priority - left.priority
        || left.runAfterAt.getTime() - right.runAfterAt.getTime()
        || left.jobId.localeCompare(right.jobId),
      );

    const job = candidates[0];
    if (!job) {
      return null;
    }
    job.status = "running";
    job.lockedBy = options.workerId;
    job.lockedAt = now;
    job.startedAt ??= now;
    this.hub?.emitStatus(job.jobId);
    return { ...job };
  }

  async heartbeat(scope: TenantScope, jobId: string, workerId: string, now = new Date(), _tx?: KnowledgeTxClient): Promise<boolean> {
    const job = this.getOwnedRunningJob(scope, jobId, workerId);
    if (!job) {
      return false;
    }
    job.lockedAt = now;
    return true;
  }

  async complete(scope: TenantScope, jobId: string, workerId: string, now = new Date(), _tx?: KnowledgeTxClient): Promise<boolean> {
    const job = this.getOwnedRunningJob(scope, jobId, workerId);
    if (!job) {
      return false;
    }
    job.status = "succeeded";
    job.finishedAt = now;
    job.lockedBy = null;
    job.lockedAt = null;
    this.hub?.emitStatus(job.jobId);
    return true;
  }

  async fail(scope: TenantScope, jobId: string, workerId: string, input: JobFailureInput, _tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null> {
    const job = this.getOwnedRunningJob(scope, jobId, workerId);
    if (!job) {
      return null;
    }
    const now = input.now ?? new Date();
    const decision = decideFailedJobTransition(job, now, input.retryDelayMs);
    job.status = decision.nextStatus;
    job.attempt = decision.nextAttempt;
    job.errorCode = input.errorCode;
    job.errorMessage = sanitizeJobErrorMessage(input.errorMessage);
    job.lockedBy = null;
    job.lockedAt = null;
    if (decision.nextStatus === "queued") {
      job.runAfterAt = decision.runAfterAt;
    } else {
      job.deadLetterAt = decision.deadLetterAt;
      job.finishedAt = now;
    }
    this.hub?.emitStatus(job.jobId);
    return { ...job };
  }

  async markDegraded(scope: TenantScope, jobId: string, workerId: string, reason: string, now = new Date(), _tx?: KnowledgeTxClient): Promise<boolean> {
    const job = this.getOwnedRunningJob(scope, jobId, workerId);
    if (!job) {
      return false;
    }
    const decision = markJobDegraded(reason, now);
    job.status = decision.nextStatus;
    job.degradedReason = decision.degradedReason;
    job.finishedAt = decision.finishedAt;
    job.lockedBy = null;
    job.lockedAt = null;
    this.hub?.emitStatus(job.jobId);
    return true;
  }

  async findLatestForDocument(scope: TenantScope, documentId: string, type: string, _tx?: KnowledgeTxClient): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const candidates = [...this.jobs.values()]
      .filter((job) =>
        job.sourceSystemId === safeScope.sourceSystemId
        && job.tenantId === safeScope.tenantId
        && job.documentId === documentId
        && job.type === type,
      )
      .sort((left, right) => right.runAfterAt.getTime() - left.runAfterAt.getTime());
    const job = candidates[0];
    return job ? { ...job } : null;
  }

  async cancelDocumentJobs(scope: TenantScope, documentId: string, reason: string, now = new Date(), _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (
        job.sourceSystemId === safeScope.sourceSystemId
        && job.tenantId === safeScope.tenantId
        && job.documentId === documentId
        && (job.status === "queued" || job.status === "running")
      ) {
        const decision = cancelRunningJob(now);
        job.status = decision.nextStatus;
        job.finishedAt = decision.finishedAt;
        job.errorCode = "JOB_CANCELLED";
        job.errorMessage = sanitizeJobErrorMessage(reason);
        job.lockedBy = null;
        job.lockedAt = null;
        this.hub?.emitStatus(job.jobId);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let count = 0;
    for (const [key, job] of this.jobs) {
      if (
        job.sourceSystemId === safeScope.sourceSystemId
        && job.tenantId === safeScope.tenantId
        && job.spaceId === spaceId
      ) {
        this.jobs.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async cancelBySpace(scope: TenantScope, spaceId: string, reason: string, now: Date = new Date(), _tx?: KnowledgeTxClient): Promise<number> {
    const safeScope = requireTenantScope(scope);
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (
        job.sourceSystemId === safeScope.sourceSystemId
        && job.tenantId === safeScope.tenantId
        && job.spaceId === spaceId
        && CANCELLABLE_BY_SPACE_STATUSES.has(job.status)
      ) {
        job.status = "cancelled";
        job.errorMessage = sanitizeJobErrorMessage(reason);
        job.finishedAt = now;
        job.lockedBy = null;
        job.lockedAt = null;
        this.hub?.emitStatus(job.jobId);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private getOwnedRunningJob(scope: TenantScope, jobId: string, workerId: string): KnowledgeJobRecord | null {
    const safeScope = requireTenantScope(scope);
    const job = this.jobs.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, jobId));
    if (!job || job.status !== "running" || job.lockedBy !== workerId) {
      return null;
    }
    return job;
  }

  private key(sourceSystemId: string, tenantId: string, jobId: string): string {
    return `${sourceSystemId}:${tenantId}:${jobId}`;
  }
}

/**
 * 生命周期终态(SSE 端点据此关闭推送流):succeeded | failed | dead_lettered | cancelled | degraded。
 * 与 domain/jobs.ts 的 TERMINAL_JOB_STATUSES 及 SSE 端点终态枚举保持一致。
 * 导出供 SSE 端点复用(避免各处各写一份)。
 */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["succeeded", "failed", "dead_lettered", "cancelled", "degraded"]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * cancelBySpace 的可取消状态集 —— 注意与「生命周期终态」不同:
 * degraded 虽是生命周期终态,但空间删除时仍应被取消(与 Prisma 实现的 where
 * `status IN (queued, running, degraded)` 完全一致),否则 InMemory/Prisma 行为分叉。
 */
const CANCELLABLE_BY_SPACE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["queued", "running", "degraded"]);

export function sanitizeJobErrorMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?\/[\w./-]+/g, "[path]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 1024);
}
