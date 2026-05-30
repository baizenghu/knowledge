import { describe, expect, it } from "vitest";
import {
  canClaimJob,
  canClaimJobWithLease,
  cancelRunningJob,
  decideFailedJobTransition,
  isTerminalJobStatus,
  markJobDegraded,
} from "./jobs.js";

describe("job state helpers", () => {
  it("only queued jobs are claimable", () => {
    expect(canClaimJob("queued")).toBe(true);
    expect(canClaimJob("running")).toBe(false);
  });

  it("detects terminal statuses", () => {
    expect(isTerminalJobStatus("succeeded")).toBe(true);
    expect(isTerminalJobStatus("running")).toBe(false);
  });

  it("requeues failed jobs until max retries", () => {
    const decision = decideFailedJobTransition(
      { status: "running", attempt: 0, maxRetries: 1 },
      new Date("2026-05-18T00:00:00.000Z"),
      1000,
    );
    expect(decision.nextStatus).toBe("queued");
    expect(decision.nextAttempt).toBe(1);
  });

  it("dead-letters failed jobs after max retries", () => {
    const decision = decideFailedJobTransition(
      { status: "running", attempt: 1, maxRetries: 1 },
      new Date("2026-05-18T00:00:00.000Z"),
      1000,
    );
    expect(decision.nextStatus).toBe("dead_lettered");
    expect(decision.nextAttempt).toBe(2);
  });

  it("allows stale running jobs to be reclaimed after lease timeout", () => {
    const now = new Date("2026-05-18T00:10:00.000Z");
    expect(canClaimJobWithLease({
      status: "running",
      lockedAt: new Date("2026-05-18T00:00:00.000Z"),
    }, now, 5 * 60_000)).toBe(true);
    expect(canClaimJobWithLease({
      status: "running",
      lockedAt: new Date("2026-05-18T00:09:00.000Z"),
    }, now, 5 * 60_000)).toBe(false);
  });

  it("builds cancellation and degraded terminal updates", () => {
    const now = new Date("2026-05-18T00:00:00.000Z");
    expect(cancelRunningJob(now)).toEqual({ nextStatus: "cancelled", finishedAt: now });
    expect(markJobDegraded("plain_text_fallback", now)).toEqual({
      nextStatus: "degraded",
      degradedReason: "plain_text_fallback",
      finishedAt: now,
    });
  });
});
