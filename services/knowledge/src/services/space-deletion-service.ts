/**
 * SpaceDeletionService — knowledge 空间软删 + 三资源补偿清理。
 *
 * 设计要点（与 docs/plans/2026-05-19-knowledge-space-deletion-and-gc.md 对齐）：
 * 1. 校验：space 必须存在；调用方必须是 createdBy 本人或具备 'knowledge_admin' 角色。
 *    **editor 角色不允许删空间**。
 * 2. 事务边界：DB 三步（jobs.cancelBySpace + documents.softDeleteBySpace + spaces.softDelete）
 *    必须串进一个事务；外部资源（Qdrant / Fulltext / Object Storage）**不能进事务**——它们是
 *    远端调用，失败/超时会拖垮 DB 连接，且 rollback 也无法回滚 Qdrant 已写的删除。
 * 3. 补偿：三类外部资源各自独立 try/catch；失败时 setCleanupStatus(target, 'pending', …) 让
 *    GC worker 按 nextRunAt 重试。成功时 setCleanupStatus(target, 'ok', null, null, false, null)。
 * 4. 审计：action='space.soft_delete'，details 含三个 cleanup_* status + 计数。
 */

import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { KnowledgeJobStore } from "../repositories/job-store.js";
import type { KnowledgeObjectStore } from "../repositories/object-store.js";
import type {
  CleanupStatus,
  CleanupTarget,
  KnowledgeSpaceStore,
} from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { KnowledgeTxClient } from "../repositories/tx.js";
import type { FulltextAdapter } from "../fulltext/fulltext-adapter.js";
import type { QdrantAdapter } from "../vector/qdrant-adapter.js";

export type SpaceDeletionContext = {
  userId: string;
  roles: string[];
};

export type SpaceCleanupSummary = {
  qdrant: "ok" | "pending";
  fulltext: "ok" | "pending";
  object_storage: "ok" | "pending";
};

export type SpaceDeletionResult =
  | {
      ok: true;
      data: {
        space_id: string;
        documents_soft_deleted: number;
        jobs_cancelled: number;
        cleanup_status: SpaceCleanupSummary;
      };
    }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN"; message: string };

/**
 * Prisma 事务客户端的鸭子类型门面。Memory 模式可传 null，service 会顺序执行。
 */
export type SpaceDeletionPrismaLike = {
  $transaction: <T>(fn: (tx: KnowledgeTxClient) => Promise<T>) => Promise<T>;
};

/** 重试退避：补偿失败后 1 分钟由 GC worker 重新拾取。 */
const CLEANUP_RETRY_DELAY_MS = 60_000;

/** 'knowledge_admin' 之外的角色都不放行——editor/viewer 没有删空间的权力。 */
const ADMIN_ROLE = "knowledge_admin";

export class SpaceDeletionService {
  constructor(
    private readonly deps: {
      spaces: KnowledgeSpaceStore;
      documents: KnowledgeDocumentStore;
      jobs: KnowledgeJobStore;
      audit: KnowledgeAuditEventWriter;
      vector: QdrantAdapter;
      fulltext: FulltextAdapter;
      /** in-memory 测试可能不提供；缺省则把 object_storage cleanup 标 'ok' 跳过。 */
      objectStore?: KnowledgeObjectStore;
      /** null 代表 memory 模式：直接顺序调用，跳过事务。 */
      prisma: SpaceDeletionPrismaLike | null;
    },
  ) {}

  async softDelete(
    scope: TenantScope,
    spaceId: string,
    ctx: SpaceDeletionContext,
    now: Date = new Date(),
  ): Promise<SpaceDeletionResult> {
    // 1) 校验存在性 —— 走 getIncludeDeleted，幂等：已软删的空间也认为是 NOT_FOUND 之外的合法路径，
    //    但若 createdBy 不匹配且非 admin，仍要拒绝（防止 admin 之外的人通过删除接口探测他人空间）。
    const space = await this.deps.spaces.getIncludeDeleted(scope, spaceId);
    if (!space) {
      return { ok: false, code: "NOT_FOUND", message: `space not found: ${spaceId}` };
    }

    // 2) 权限：admin 或 createdBy 本人。editor 不放行。
    const isAdmin = ctx.roles.includes(ADMIN_ROLE);
    const isOwner = space.createdBy === ctx.userId;
    if (!isAdmin && !isOwner) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "only space creator or knowledge_admin can delete this space",
      };
    }

    // 3) DB 事务：取消 job + 软删文档 + 软删空间。
    const dbResult = await this.runInTx(async (tx) => {
      const jobsCancelled = await this.deps.jobs.cancelBySpace(scope, spaceId, "space_soft_deleted", now, tx);
      const documentsSoftDeleted = await this.deps.documents.softDeleteBySpace(scope, spaceId, now, tx);
      await this.deps.spaces.softDelete(scope, spaceId, ctx.userId, now, tx);
      return { jobsCancelled, documentsSoftDeleted };
    });

    // 4) 事务外：三资源独立补偿。每个目标独立 try/catch + setCleanupStatus。
    const qdrantStatus = await this.cleanupQdrant(scope, spaceId, now);
    const fulltextStatus = await this.cleanupFulltext(scope, spaceId, now);
    const objectStatus = await this.cleanupObjectStorage(scope, spaceId, now);

    const cleanup: SpaceCleanupSummary = {
      qdrant: qdrantStatus,
      fulltext: fulltextStatus,
      object_storage: objectStatus,
    };

    // 5) 审计
    await this.deps.audit.write({
      sourceSystemId: scope.sourceSystemId,
      tenantId: scope.tenantId,
      userId: ctx.userId,
      action: "space.soft_delete",
      resourceType: "knowledge_space",
      resourceId: spaceId,
      success: true,
      details: {
        documents_soft_deleted: dbResult.documentsSoftDeleted,
        jobs_cancelled: dbResult.jobsCancelled,
        cleanup_qdrant_status: cleanup.qdrant,
        cleanup_fulltext_status: cleanup.fulltext,
        cleanup_object_storage_status: cleanup.object_storage,
      },
      createdAt: now,
    });

    return {
      ok: true,
      data: {
        space_id: spaceId,
        documents_soft_deleted: dbResult.documentsSoftDeleted,
        jobs_cancelled: dbResult.jobsCancelled,
        cleanup_status: cleanup,
      },
    };
  }

  // ----------------- helpers -----------------

  private async runInTx<T>(fn: (tx: KnowledgeTxClient | undefined) => Promise<T>): Promise<T> {
    if (!this.deps.prisma) {
      // Memory 模式：单进程内顺序执行就够一致。
      return fn(undefined);
    }
    return this.deps.prisma.$transaction(async (tx) => fn(tx));
  }

  private buildScopedFilter(scope: TenantScope, spaceId: string) {
    return {
      must: [
        { key: "source_system_id", match: { value: scope.sourceSystemId } },
        { key: "tenant_id", match: { value: scope.tenantId } },
        { key: "space_id", match: { value: spaceId } },
      ],
    };
  }

  private async cleanupQdrant(
    scope: TenantScope,
    spaceId: string,
    now: Date,
  ): Promise<"ok" | "pending"> {
    try {
      await this.deps.vector.deleteByFilter(this.buildScopedFilter(scope, spaceId));
      await this.markCleanup(scope, spaceId, "qdrant", "ok", now, null, null, false, null);
      return "ok";
    } catch (err) {
      await this.markCleanupFailure(scope, spaceId, "qdrant", err, now);
      return "pending";
    }
  }

  private async cleanupFulltext(
    scope: TenantScope,
    spaceId: string,
    now: Date,
  ): Promise<"ok" | "pending"> {
    try {
      await this.deps.fulltext.deleteByFilter(this.buildScopedFilter(scope, spaceId));
      await this.markCleanup(scope, spaceId, "fulltext", "ok", now, null, null, false, null);
      return "ok";
    } catch (err) {
      await this.markCleanupFailure(scope, spaceId, "fulltext", err, now);
      return "pending";
    }
  }

  private async cleanupObjectStorage(
    scope: TenantScope,
    spaceId: string,
    _now: Date,
  ): Promise<"ok" | "pending"> {
    // Phase A 不做对象存储清理：KnowledgeObjectStore 当前缺 deleteBySpaceId/listBySpace 批量
    // 接口（对象按 sourceSystemId:tenantId:uri keying，必须先列出 uri 才能删）。
    //
    // 为避免 admin 误判"已清理"，**始终标 pending**：DB 立刻软删 + 用户看不见，但物理对象
    // 还在；Phase B 会补 KnowledgeObjectStore.listBySpace + 批量删，由 GC worker 重试 pending
    // 行直至变 ok。
    //
    // 注意：这里 *不* 写入 DB 把字段改成 pending——schema 默认 'ok'，但 Phase A 的语义是
    // "Phase A 不动",所以我们 setCleanupStatus 写 'pending' 让 GC 看到，并把 next_run_at
    // 设到将来,避免 GC worker 还没就绪时被反复扫描。
    await this.markCleanup(
      scope,
      spaceId,
      "object_storage",
      "pending",
      _now,
      "PHASE_A_NO_OBJECT_CLEANUP",
      "object storage cleanup deferred to Phase B (KnowledgeObjectStore lacks batch delete)",
      false,
      // Phase B 上线前 GC 不要反复跑这个；上线后 GC 把 next_run_at 重置为 now 主动重试。
      new Date(_now.getTime() + 30 * 24 * 60 * 60 * 1000),
    );
    return "pending";
  }

  private async markCleanup(
    scope: TenantScope,
    spaceId: string,
    target: CleanupTarget,
    status: CleanupStatus,
    now: Date,
    errorCode: string | null,
    errorMessage: string | null,
    incrementAttempts: boolean,
    nextRunAt: Date | null,
  ): Promise<void> {
    await this.deps.spaces.setCleanupStatus(scope, spaceId, {
      target,
      status,
      errorCode,
      errorMessage,
      incrementAttempts,
      nextRunAt,
      now,
    });
  }

  private async markCleanupFailure(
    scope: TenantScope,
    spaceId: string,
    target: CleanupTarget,
    err: unknown,
    now: Date,
  ): Promise<void> {
    const errorCode = extractErrorCode(err);
    const errorMessage = String(err).slice(0, 500);
    await this.markCleanup(
      scope,
      spaceId,
      target,
      "pending",
      now,
      errorCode,
      errorMessage,
      true,
      new Date(now.getTime() + CLEANUP_RETRY_DELAY_MS),
    );
  }
}

function extractErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "EXTERNAL_CLEANUP_FAILED";
}

