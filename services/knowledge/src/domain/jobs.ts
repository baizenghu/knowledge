import type { JobStatus } from "@octopus/knowledge-contracts";

export type JobTransitionInput = {
  status: JobStatus;
  attempt: number;
  maxRetries: number;
};

export type JobFailureDecision =
  | { nextStatus: "queued"; nextAttempt: number; runAfterAt: Date; deadLetterAt?: undefined }
  | { nextStatus: "dead_lettered"; nextAttempt: number; runAfterAt?: undefined; deadLetterAt: Date };

export type ClaimableJobInput = {
  status: JobStatus;
  lockedAt?: Date | null;
};

const TERMINAL_JOB_STATUSES = new Set<JobStatus>([
  "degraded",
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
]);

export function canClaimJob(status: JobStatus): boolean {
  return status === "queued";
}

export function canClaimJobWithLease(
  input: ClaimableJobInput,
  now = new Date(),
  leaseTimeoutMs = 5 * 60_000,
): boolean {
  if (input.status === "queued") {
    return true;
  }
  if (input.status !== "running" || !input.lockedAt) {
    return false;
  }
  return input.lockedAt.getTime() <= now.getTime() - leaseTimeoutMs;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function cancelRunningJob(now = new Date()) {
  return {
    nextStatus: "cancelled" as const,
    finishedAt: now,
  };
}

export function markJobDegraded(degradedReason: string, now = new Date()) {
  return {
    nextStatus: "degraded" as const,
    degradedReason,
    finishedAt: now,
  };
}

export function decideFailedJobTransition(
  input: JobTransitionInput,
  now = new Date(),
  retryDelayMs = 30_000,
): JobFailureDecision {
  if (isTerminalJobStatus(input.status) && input.status !== "failed") {
    throw new Error(`cannot fail terminal job status: ${input.status}`);
  }
  const nextAttempt = input.attempt + 1;
  if (nextAttempt <= input.maxRetries) {
    return {
      nextStatus: "queued",
      nextAttempt,
      runAfterAt: new Date(now.getTime() + retryDelayMs),
    };
  }
  return {
    nextStatus: "dead_lettered",
    nextAttempt,
    deadLetterAt: now,
  };
}
