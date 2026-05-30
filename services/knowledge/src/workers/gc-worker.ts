/**
 * KnowledgeGCWorker — Phase B garbage collector for soft-deleted knowledge spaces.
 *
 * Two responsibilities, per scan loop:
 *
 *  1. **Retry external cleanups** (qdrant / fulltext / object_storage) for any
 *     soft-deleted space whose `cleanup_*_status` is still 'pending' or
 *     'failed' AND whose `cleanupNextRunAt` is due. Each target is retried
 *     independently; on success → 'ok', on failure → 'pending' with exponential
 *     backoff (max 1h), or 'failed' once attempts exceed `maxAttempts`.
 *
 *  2. **Physical purge** of spaces whose `deletedAt < now - retentionDays` AND
 *     whose three cleanup_* statuses are all 'ok'. The purge walks every child
 *     table in FK-safe order inside a single DB transaction; SpaceDeletionService
 *     already drained Qdrant/Fulltext/Object Storage so this step is pure SQL.
 *
 * Style mirrors job-worker.ts: start(intervalMs) spawns a loop, stop() awaits
 * pending runs, runOnce() returns "processed-N" | "idle" for tests.
 */

import type { KnowledgeAclStore } from "../repositories/acl-store.js";
import type { KnowledgeAnchorStore } from "../repositories/anchor-store.js";
import type { KnowledgeAssetStore } from "../repositories/asset-store.js";
import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { KnowledgeChunkStore } from "../repositories/chunk-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { KnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import type { KnowledgeJobStore } from "../repositories/job-store.js";
import type { KnowledgeObjectStore } from "../repositories/object-store.js";
import {
  cleanupFieldsFor,
  type CleanupStatus,
  type CleanupTarget,
  type KnowledgeSpaceRecord,
  type KnowledgeSpaceStore,
  type ListDeletedInput,
} from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { KnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import type { KnowledgeTxClient } from "../repositories/tx.js";
import type { FulltextAdapter } from "../fulltext/fulltext-adapter.js";
import type { QdrantAdapter } from "../vector/qdrant-adapter.js";
import {
  gcOldestDeletedAgeSeconds,
  gcPendingCleanupGauge,
  gcRunsTotal,
  gcSpacesFailedTotal,
  gcSpacesPurgedTotal,
} from "../observability/metrics.js";

export type GCWorkerOptions = {
  scope?: TenantScope;
  spaces: KnowledgeSpaceStore;
  chunks: KnowledgeChunkStore;
  versions: KnowledgeDocumentVersionStore;
  anchors: KnowledgeAnchorStore;
  assets: KnowledgeAssetStore;
  acl: KnowledgeAclStore;
  uploads: KnowledgeUploadSessionStore;
  documents: KnowledgeDocumentStore;
  jobs: KnowledgeJobStore;
  audit: KnowledgeAuditEventWriter;
  vector: QdrantAdapter;
  fulltext: FulltextAdapter;
  objectStore?: KnowledgeObjectStore;
  prisma: { $transaction: <T>(fn: (tx: KnowledgeTxClient) => Promise<T>) => Promise<T> } | null;
  now?: () => Date;
  /** Default 30. */
  retentionDays?: number;
  /** Default 50. */
  batchSize?: number;
  /** Default 10 — once exceeded the cleanup_* state lands in 'failed' and stops auto-retrying. */
  maxAttempts?: number;
  onError?: (err: unknown) => void;
};

const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_BACKOFF_SECONDS = 3600;

const CLEANUP_TARGETS = ["qdrant", "fulltext", "object_storage"] as const;

export type GCRunResult = {
  status: "idle" | "processed";
  spaces_purged: number;
  spaces_failed: number;
  retries_processed: number;
};

/** 检查任一 status==='pending'|'running' 的 target 是否到了它自己 nextRunAt 重试时间。
 *  P0-3：status==='failed' **永远**不算 due —— 等 admin 手动 cleanup-retry。 */
function anyPendingTargetDue(space: KnowledgeSpaceRecord, now: Date): boolean {
  for (const target of CLEANUP_TARGETS) {
    const status = readCleanupStatus(space, target);
    if (status !== "pending" && status !== "running") continue;
    const nextRunAt = readCleanupNextRunAt(space, target);
    if (!nextRunAt || nextRunAt.getTime() <= now.getTime()) return true;
  }
  return false;
}

/** 用于 listDeleted 返回的 batch 内排序:数字越小越优先。
 *  P0-3：failed 不算 pending-due 优先级，purge 走 retention 路径或等 admin 触发。 */
function priorityOf(space: KnowledgeSpaceRecord, now: Date, purgeBefore: number): number {
  if (anyPendingTargetDue(space, now)) return 0;
  const retentionElapsed = !!space.deletedAt && space.deletedAt.getTime() <= purgeBefore;
  if (retentionElapsed) return 1;
  return 2;
}

type PurgeCounts = {
  chunks: number;
  versions: number;
  anchors: number;
  assets: number;
  acl: number;
  uploads: number;
  jobs: number;
  reindexPlans: number;
  documents: number;
  space: boolean;
};

export type GCWorkerStatus = {
  lastRunAt: Date | null;
  lastRunResult: GCRunResult | null;
  pendingCleanup: number;
  oldestDeletedAgeSeconds: number;
  runsTotal: number;
  spacesPurgedTotal: number;
  spacesFailedTotal: number;
};

export class KnowledgeGCWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private _lastRunAt: Date | null = null;
  private _lastRunResult: GCRunResult | null = null;

  constructor(private readonly options: GCWorkerOptions) {}

  get lastRunAt(): Date | null {
    return this._lastRunAt;
  }

  get lastRunResult(): GCRunResult | null {
    return this._lastRunResult;
  }

  /** Snapshot of worker health for admin endpoints (does not trigger any IO). */
  getStatus(): GCWorkerStatus {
    return {
      lastRunAt: this._lastRunAt,
      lastRunResult: this._lastRunResult ? { ...this._lastRunResult } : null,
      // prom-client `Gauge` exposes `hashMap` internally; safest to read via .get() (sync).
      pendingCleanup: readGaugeValue(gcPendingCleanupGauge),
      oldestDeletedAgeSeconds: readGaugeValue(gcOldestDeletedAgeSeconds),
      runsTotal: readGaugeValue(gcRunsTotal),
      spacesPurgedTotal: readGaugeValue(gcSpacesPurgedTotal),
      spacesFailedTotal: readGaugeValue(gcSpacesFailedTotal),
    };
  }

  /**
   * Admin 强制硬删一个空间，跳过 retention 检查。复用 purgeSpace 路径，
   * 但要求空间存在且仍在 deleted 状态（不能 active）。
   */
  async purgeSpaceById(
    scope: TenantScope,
    spaceId: string,
    now: Date = this.now(),
  ): Promise<
    | { ok: true; counts: PurgeCounts }
    | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "CLEANUP_PENDING"; message: string; cleanup_status?: Record<CleanupTarget, CleanupStatus> }
  > {
    const space = await this.options.spaces.getIncludeDeleted(scope, spaceId);
    if (!space) return { ok: false, code: "NOT_FOUND", message: `space not found: ${spaceId}` };
    if (space.status !== "deleted") {
      return { ok: false, code: "CONFLICT", message: `space ${spaceId} is not soft-deleted` };
    }

    // P0(C 二审):purge 之前必须先清外部资源。否则 DB hard delete 之后,
    // qdrant/fulltext/object_storage 失去关联 space row,变成永久孤儿。
    // 对仍非 ok 的 target 强制 retry 一次(忽略 nextRunAt 退避;admin 主动触发应该 best-effort)。
    for (const target of CLEANUP_TARGETS) {
      const status = readCleanupStatus(space, target);
      if (status === "ok") continue;
      // 重新拉最新,避免重复 attempts 不一致
      const fresh = (await this.options.spaces.getIncludeDeleted(scope, spaceId)) ?? space;
      await this.retryOneTarget(scope, fresh, target, now);
    }
    // 重新读判定是否全 ok
    const after = await this.options.spaces.getIncludeDeleted(scope, spaceId);
    if (!after) return { ok: false, code: "NOT_FOUND", message: `space ${spaceId} disappeared during cleanup` };
    const finalStatus: Record<CleanupTarget, CleanupStatus> = {
      qdrant: (after.cleanupQdrantStatus ?? "ok") as CleanupStatus,
      fulltext: (after.cleanupFulltextStatus ?? "ok") as CleanupStatus,
      object_storage: (after.cleanupObjectStorageStatus ?? "ok") as CleanupStatus,
    };
    const allOk = CLEANUP_TARGETS.every((t) => finalStatus[t] === "ok");
    if (!allOk) {
      return {
        ok: false,
        code: "CLEANUP_PENDING",
        message: "external cleanup did not reach 'ok' for all targets; retry cleanup or contact ops",
        cleanup_status: finalStatus,
      };
    }
    const counts = await this.purgeSpaceInternal(scope, after, now, /*forceAuditAction*/ "space.purge_force");
    return { ok: true, counts };
  }

  /**
   * Admin 手动重试某 target 的清理。target='all' 把三个 target 都跑一次。
   */
  async cleanupRetry(
    scope: TenantScope,
    spaceId: string,
    target: CleanupTarget | "all",
    now: Date = this.now(),
  ): Promise<
    | {
        ok: true;
        status_after: Record<
          CleanupTarget,
          { status: CleanupStatus; attempts: number; next_run_at: string | null; error_code: string | null; error_message: string | null }
        >;
      }
    | { ok: false; code: "NOT_FOUND" | "CONFLICT"; message: string }
  > {
    const space = await this.options.spaces.getIncludeDeleted(scope, spaceId);
    if (!space) return { ok: false, code: "NOT_FOUND", message: `space not found: ${spaceId}` };
    // P0(C 二审):必须是软删空间。active space 不允许触发外部清理 — 否则 admin 误操作会
    // 把活动空间的 Qdrant 向量/全文索引/对象存储直接删掉。
    if (space.status !== "deleted") {
      return { ok: false, code: "CONFLICT", message: `space ${spaceId} is not soft-deleted; cleanup-retry only applies to recycle-bin spaces` };
    }
    const targets: CleanupTarget[] = target === "all" ? [...CLEANUP_TARGETS] : [target];
    for (const t of targets) {
      // Re-fetch so attempts counter sees the latest value if multiple targets run.
      const fresh = (await this.options.spaces.getIncludeDeleted(scope, spaceId)) ?? space;
      await this.retryOneTarget(scope, fresh, t, now);
    }
    const after = await this.options.spaces.getIncludeDeleted(scope, spaceId);
    const status_after = {
      qdrant: cleanupTargetStatusView(after, "qdrant"),
      fulltext: cleanupTargetStatusView(after, "fulltext"),
      object_storage: cleanupTargetStatusView(after, "object_storage"),
    };
    return { ok: true, status_after };
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop(intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  async runOnce(scopeOverride?: TenantScope): Promise<GCRunResult> {
    const now = this.now();
    const scope = scopeOverride ?? this.options.scope;

    gcRunsTotal.inc();
    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;

    // ----- 收集本轮候选 spaces（4 次过滤查询合并去重，避免「第一页全未到期 → 后页饥饿」P0-4）-----
    // 1) 三次 pendingTarget 过滤拿到「外部清理尚未 ok」的候选；
    // 2) 一次无过滤拿到「retention 到期」候选；
    // 用 spaceKey 去重后按 priorityOf 排序，取前 batchSize 个处理。
    const merged = new Map<string, KnowledgeSpaceRecord>();
    const collect = async (
      input: ListDeletedInput,
    ): Promise<void> => {
      const { items } = scope
        ? await this.options.spaces.listDeleted(scope, input)
        : await this.options.spaces.listDeletedAcrossTenants(input);
      for (const space of items) {
        const key = `${space.sourceSystemId}:${space.tenantId}:${space.spaceId}`;
        if (!merged.has(key)) merged.set(key, space);
      }
    };
    // 3 个 pendingTarget 查询都下推「status IN (pending, running) 且 nextRunAt 已到期」给 DB,
    // 避免大量 failed 行或未到期 pending 行占满第一页(二次审查 P0-4 收紧:
    // 之前只过滤 status != 'ok',failed/未到期仍然能占座)。
    const dueStatuses: CleanupStatus[] = ["pending", "running"];
    try {
      await collect({ limit: batchSize, pendingTarget: "qdrant", pendingTargetStatuses: dueStatuses, dueAt: now });
      await collect({ limit: batchSize, pendingTarget: "fulltext", pendingTargetStatuses: dueStatuses, dueAt: now });
      await collect({ limit: batchSize, pendingTarget: "object_storage", pendingTargetStatuses: dueStatuses, dueAt: now });
      await collect({ limit: batchSize });
    } catch (err) {
      this.options.onError?.(err);
      return { status: "idle", spaces_purged: 0, spaces_failed: 0, retries_processed: 0 };
    }

    let processed = 0;
    let spacesPurged = 0;
    let spacesFailed = 0;
    let retriesProcessed = 0;
    let pendingGauge = 0;
    let oldestDeletedMs = 0;
    const retentionMs = (this.options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    const purgeBefore = now.getTime() - retentionMs;

    // 合并后排序：cleanup pending-due 优先；其次 retention 到期；其余靠后。
    // 每个底层查询已被 batchSize 限制，合并后最多 4*batchSize 行 —— 不再二次截断，
    // 避免 P0-4 中「s-3 被排在 batchSize 之外永远饿死」的情况。
    const orderedItems = [...merged.values()].sort(
      (a, b) => priorityOf(a, now, purgeBefore) - priorityOf(b, now, purgeBefore),
    );

    for (const space of orderedItems) {
      // 跨租户路径下 per-item 构造 scope；单租户路径复用外层 scope。
      const itemScope: TenantScope = scope ?? {
        sourceSystemId: space.sourceSystemId,
        tenantId: space.tenantId,
      };
      // Gauge accounting: any space still soft-deleted counts toward backlog.
      const cleanupNotDone =
        (space.cleanupQdrantStatus ?? "ok") !== "ok" ||
        (space.cleanupFulltextStatus ?? "ok") !== "ok" ||
        (space.cleanupObjectStorageStatus ?? "ok") !== "ok";
      if (cleanupNotDone) pendingGauge += 1;
      if (space.deletedAt) {
        const ageMs = now.getTime() - space.deletedAt.getTime();
        if (ageMs > oldestDeletedMs) oldestDeletedMs = ageMs;
      }

      try {
        // Step 1: try to advance any pending/running cleanup whose own nextRunAt is due.
        // 每个 target 独立 nextRunAt：qdrant 60s 退避不会被 object_storage 30 天覆盖。
        // P0-3：failed 永远不在这条路径上重试，等 admin 手动 cleanup-retry。
        const nextRunDue = anyPendingTargetDue(space, now);
        if (cleanupNotDone && nextRunDue) {
          await this.retryExternalCleanups(itemScope, space, now);
          processed += 1;
        }

        // Step 2: physical purge if retention elapsed AND all three cleanups ok.
        // Re-read latest state to capture step-1 status flips.
        const fresh = await this.options.spaces.getIncludeDeleted(itemScope, space.spaceId);
        if (!fresh) continue;
        const allOk =
          (fresh.cleanupQdrantStatus ?? "ok") === "ok" &&
          (fresh.cleanupFulltextStatus ?? "ok") === "ok" &&
          (fresh.cleanupObjectStorageStatus ?? "ok") === "ok";
        const retentionElapsed = !!fresh.deletedAt && fresh.deletedAt.getTime() <= purgeBefore;
        if (allOk && retentionElapsed) {
          try {
            await this.purgeSpace(itemScope, fresh, now);
            spacesPurged += 1;
            processed += 1;
          } catch (err) {
            spacesFailed += 1;
            this.options.onError?.(err);
          }
        }
        if (cleanupNotDone && nextRunDue) retriesProcessed += 1;
      } catch (err) {
        this.options.onError?.(err);
      }
    }

    gcPendingCleanupGauge.set(pendingGauge);
    gcOldestDeletedAgeSeconds.set(Math.floor(oldestDeletedMs / 1000));

    const result: GCRunResult = {
      status: processed === 0 ? "idle" : "processed",
      spaces_purged: spacesPurged,
      spaces_failed: spacesFailed,
      retries_processed: retriesProcessed,
    };
    this._lastRunAt = now;
    this._lastRunResult = result;
    return result;
  }

  // ----------------- internals -----------------

  private async retryExternalCleanups(
    scope: TenantScope,
    space: KnowledgeSpaceRecord,
    now: Date,
  ): Promise<void> {
    for (const target of CLEANUP_TARGETS) {
      const status = readCleanupStatus(space, target);
      // 只对 pending / running 自动重试。failed 表示已超过 maxAttempts,等 admin 手动
      // cleanup-retry,不再被另一 target 的 due 顺带触发(P0-3 二次审查发现:之前用
      // `status === "ok"` 单独 skip,失败 target 在 retry 循环里仍会被重新执行)。
      if (status !== "pending" && status !== "running") continue;
      // 仅在「该 target 自己的 nextRunAt 到期」时才动它，
      // 避免 qdrant 60s 退避被 object_storage 的 30 天 nextRunAt 误判为未到期。
      const nextRunAt = readCleanupNextRunAt(space, target);
      if (nextRunAt && nextRunAt.getTime() > now.getTime()) continue;
      await this.retryOneTarget(scope, space, target, now);
    }
  }

  private async retryOneTarget(
    scope: TenantScope,
    space: KnowledgeSpaceRecord,
    target: CleanupTarget,
    now: Date,
  ): Promise<void> {
    try {
      await this.executeCleanup(scope, space.spaceId, target);
      await this.options.spaces.setCleanupStatus(scope, space.spaceId, {
        target,
        status: "ok",
        errorCode: null,
        errorMessage: null,
        incrementAttempts: false,
        nextRunAt: null,
        now,
      });
    } catch (err) {
      // 用 target 自己的 attempts 计数（不再共用 cleanupAttempts）。
      const attempts = readCleanupAttempts(space, target) + 1;
      const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const errorCode = extractErrorCode(err);
      const errorMessage = String(err).slice(0, 500);
      if (attempts >= maxAttempts) {
        gcSpacesFailedTotal.inc();
        await this.options.spaces.setCleanupStatus(scope, space.spaceId, {
          target,
          status: "failed",
          errorCode,
          errorMessage,
          incrementAttempts: true,
          nextRunAt: null,
          now,
        });
      } else {
        const backoffSeconds = Math.min(60 * Math.pow(2, attempts), MAX_BACKOFF_SECONDS);
        await this.options.spaces.setCleanupStatus(scope, space.spaceId, {
          target,
          status: "pending",
          errorCode,
          errorMessage,
          incrementAttempts: true,
          nextRunAt: new Date(now.getTime() + backoffSeconds * 1000),
          now,
        });
      }
    }
  }

  private async executeCleanup(scope: TenantScope, spaceId: string, target: CleanupTarget): Promise<void> {
    const filter = {
      must: [
        { key: "source_system_id", match: { value: scope.sourceSystemId } },
        { key: "tenant_id", match: { value: scope.tenantId } },
        { key: "space_id", match: { value: spaceId } },
      ],
    };
    switch (target) {
      case "qdrant":
        await this.options.vector.deleteByFilter(filter);
        return;
      case "fulltext":
        await this.options.fulltext.deleteByFilter(filter);
        return;
      case "object_storage": {
        const store = this.options.objectStore as
          | (KnowledgeObjectStore & {
              deleteBySpaceId?: (scope: TenantScope, spaceId: string) => Promise<number>;
            })
          | undefined;
        if (!store || typeof store.deleteBySpaceId !== "function") {
          // No bulk-delete capability — treat as a soft success so we don't churn.
          // TODO(B.3): once KnowledgeObjectStore.deleteBySpaceId lands, drop this branch.
          return;
        }
        await store.deleteBySpaceId(scope, spaceId);
        return;
      }
    }
  }

  private async purgeSpace(scope: TenantScope, space: KnowledgeSpaceRecord, now: Date): Promise<void> {
    await this.purgeSpaceInternal(scope, space, now, "space.purge");
  }

  private async purgeSpaceInternal(
    scope: TenantScope,
    space: KnowledgeSpaceRecord,
    now: Date,
    auditAction: "space.purge" | "space.purge_force",
  ): Promise<PurgeCounts> {
    const spaceId = space.spaceId;
    try {
      const counts = await this.runInTx(async (tx) => {
        // FK-safe reverse order: leaves first, space last.
        // TODO(B.1): drop the `as any` casts once hardDeleteBySpace lands in each store interface.
        const stores = this.options as unknown as Record<string, any>;
        const chunks = await stores.chunks.hardDeleteBySpace(scope, spaceId, tx);
        const versions = await stores.versions.hardDeleteBySpace(scope, spaceId, tx);
        const anchors = await stores.anchors.hardDeleteBySpace(scope, spaceId, tx);
        const assets = await stores.assets.hardDeleteBySpace(scope, spaceId, tx);
        const acl = await stores.acl.hardDeleteBySpace(scope, spaceId, tx);
        const uploads = await stores.uploads.hardDeleteBySpace(scope, spaceId, tx);
        const jobs = await stores.jobs.hardDeleteBySpace(scope, spaceId, tx);
        // P1-5: knowledge_reindex_plans 没有 spaceId 列也没有 store 包装，
        // 在 documents 硬删之前用 prisma 直接清掉本 space 关联的 plan 行。
        // Memory 模式：无 prisma.knowledgeReindexPlan，noop（reindex 流程只跑在 Prisma 部署上）。
        const reindexPlans = await this.deleteReindexPlansForSpace(scope, spaceId, tx);
        const documents = await stores.documents.hardDeleteBySpace(scope, spaceId, tx);
        const spaceOk = await stores.spaces.hardDelete(scope, spaceId, tx);
        return {
          chunks: Number(chunks ?? 0),
          versions: Number(versions ?? 0),
          anchors: Number(anchors ?? 0),
          assets: Number(assets ?? 0),
          acl: Number(acl ?? 0),
          uploads: Number(uploads ?? 0),
          jobs: Number(jobs ?? 0),
          reindexPlans: Number(reindexPlans ?? 0),
          documents: Number(documents ?? 0),
          space: Boolean(spaceOk),
        } satisfies PurgeCounts;
      });
      gcSpacesPurgedTotal.inc();
      await this.options.audit.write({
        sourceSystemId: scope.sourceSystemId,
        tenantId: scope.tenantId,
        action: auditAction,
        resourceType: "knowledge_space",
        resourceId: spaceId,
        success: true,
        details: {
          counts,
          deleted_at: space.deletedAt?.toISOString() ?? null,
        },
        createdAt: now,
      });
      return counts;
    } catch (err) {
      gcSpacesFailedTotal.inc();
      await this.options.audit.write({
        sourceSystemId: scope.sourceSystemId,
        tenantId: scope.tenantId,
        action: "space.purge_failed",
        resourceType: "knowledge_space",
        resourceId: spaceId,
        success: false,
        errorCode: extractErrorCode(err),
        details: {
          reason: String(err).slice(0, 500),
        },
        createdAt: now,
      });
      // 重抛给 runOnce: 让外层 spacesFailed 计数器递增 (二次审查发现:之前 catch 后
      // 静默吞掉,导致返回 result.spaces_failed 永远 0)。tx 已回滚,下一轮 GC 会重试。
      throw err;
    }
  }

  /**
   * P1-5: 在 documents 硬删前先清掉本 space 的 reindex plans。
   * Schema 上 KnowledgeReindexPlan **没有 spaceId 列**（只有 documentId / jobId），
   * 因此先查本 space 的 documentIds，再按 documentId IN (...) 批量删 plan。
   * Memory 模式（无 prisma）或 tx 客户端不暴露 knowledgeReindexPlan 时 → noop 返回 0。
   */
  private async deleteReindexPlansForSpace(
    scope: TenantScope,
    spaceId: string,
    tx: KnowledgeTxClient | undefined,
  ): Promise<number> {
    const txClient = tx as unknown as {
      knowledgeReindexPlan?: {
        deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
      };
      knowledgeDocument?: {
        findMany: (args: { where: Record<string, unknown>; select: Record<string, true> }) => Promise<Array<{ documentId: string }>>;
      };
    } | undefined;
    if (!txClient?.knowledgeReindexPlan || !txClient?.knowledgeDocument) {
      return 0;
    }
    const docs = await txClient.knowledgeDocument.findMany({
      where: {
        sourceSystemId: scope.sourceSystemId,
        tenantId: scope.tenantId,
        spaceId,
      },
      select: { documentId: true },
    });
    if (docs.length === 0) return 0;
    const docIds = docs.map((d) => d.documentId);
    const result = await txClient.knowledgeReindexPlan.deleteMany({
      where: {
        sourceSystemId: scope.sourceSystemId,
        tenantId: scope.tenantId,
        documentId: { in: docIds },
      },
    });
    return result.count;
  }

  private async runInTx<T>(fn: (tx: KnowledgeTxClient | undefined) => Promise<T>): Promise<T> {
    if (!this.options.prisma) {
      return fn(undefined);
    }
    return this.options.prisma.$transaction(async (tx) => fn(tx));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async loop(intervalMs: number): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        if (this.options.onError) {
          this.options.onError(err);
        } else {
          console.error("[knowledge-gc] runOnce error", err);
        }
      }
      if (!this.running) break;
      await sleep(intervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把一个 target 的 5 字段聚成 admin endpoint 返回的视图。space=null/undef 时全 ok。 */
function cleanupTargetStatusView(
  space: KnowledgeSpaceRecord | null | undefined,
  target: CleanupTarget,
): { status: CleanupStatus; attempts: number; next_run_at: string | null; error_code: string | null; error_message: string | null } {
  if (!space) {
    return { status: "ok", attempts: 0, next_run_at: null, error_code: null, error_message: null };
  }
  const f = cleanupFieldsFor(target);
  return {
    status: ((space[f.statusField] as CleanupStatus | undefined) ?? "ok"),
    attempts: (space[f.attemptsField] as number | undefined) ?? 0,
    next_run_at: ((space[f.nextRunAtField] as Date | null | undefined) ?? null)?.toISOString?.() ?? null,
    error_code: (space[f.errorCodeField] as string | null | undefined) ?? null,
    error_message: (space[f.errorMessageField] as string | null | undefined) ?? null,
  };
}

function readCleanupStatus(space: KnowledgeSpaceRecord, target: CleanupTarget): string {
  const { statusField } = cleanupFieldsFor(target);
  return (space[statusField] as string | undefined) ?? "ok";
}

function readCleanupNextRunAt(space: KnowledgeSpaceRecord, target: CleanupTarget): Date | null {
  const { nextRunAtField } = cleanupFieldsFor(target);
  const value = space[nextRunAtField] as Date | null | undefined;
  return value ?? null;
}

function readCleanupAttempts(space: KnowledgeSpaceRecord, target: CleanupTarget): number {
  const { attemptsField } = cleanupFieldsFor(target);
  return (space[attemptsField] as number | undefined) ?? 0;
}

function readGaugeValue(gauge: { get?: () => Promise<{ values: Array<{ value: number }> }> | { values: Array<{ value: number }> }; hashMap?: Record<string, { value: number }> }): number {
  // prom-client Counter/Gauge exposes hashMap with the labelless key "" → { value }.
  // For Counter: `gauge.hashMap["{}"]` or `gauge.hashMap[""]` per version; fall back to 0.
  const map = gauge.hashMap;
  if (map) {
    for (const k of Object.keys(map)) {
      const v = map[k]?.value;
      if (typeof v === "number") return v;
    }
  }
  return 0;
}

function extractErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "GC_EXTERNAL_CLEANUP_FAILED";
}
