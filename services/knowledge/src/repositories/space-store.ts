import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeTxClient } from "./tx.js";

/** Cleanup 状态机的三个外部资源目标。 */
export type CleanupTarget = "qdrant" | "fulltext" | "object_storage";

/** Cleanup 状态机状态。 */
export type CleanupStatus = "ok" | "pending" | "running" | "failed";

export type KnowledgeSpaceRecord = TenantScope & {
  spaceId: string;
  type: "enterprise" | "department" | "personal";
  name: string;
  description?: string | null;
  ownerType: "tenant" | "department" | "user";
  ownerId: string;
  defaultAcl?: unknown;
  status: "active" | "archived" | "deleted";
  createdBy: string;
  updatedBy?: string | null;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // 三个外部资源独立 cleanup 状态机。SpaceDeletionService 在事务外更新；
  // GC worker 优先重试 pending/failed。历史行默认 'ok'。
  // 每 target 独立持有 attempts/nextRunAt/errorCode/errorMessage —— 旧的单字段共享会导致
  // qdrant 60s 重试被 object_storage 30 天 nextRunAt 覆盖（P0-2/P1-7 修复）。
  cleanupQdrantStatus?: CleanupStatus;
  cleanupFulltextStatus?: CleanupStatus;
  cleanupObjectStorageStatus?: CleanupStatus;
  cleanupQdrantAttempts?: number;
  cleanupQdrantNextRunAt?: Date | null;
  cleanupQdrantErrorCode?: string | null;
  cleanupQdrantErrorMessage?: string | null;
  cleanupFulltextAttempts?: number;
  cleanupFulltextNextRunAt?: Date | null;
  cleanupFulltextErrorCode?: string | null;
  cleanupFulltextErrorMessage?: string | null;
  cleanupObjectStorageAttempts?: number;
  cleanupObjectStorageNextRunAt?: Date | null;
  cleanupObjectStorageErrorCode?: string | null;
  cleanupObjectStorageErrorMessage?: string | null;
  cleanupLastAttemptAt?: Date | null;
};

/** 内部 helper：从 target 拼出 4 个字段名（每 target 独立字段集）。 */
export type CleanupFieldNames = {
  statusField: "cleanupQdrantStatus" | "cleanupFulltextStatus" | "cleanupObjectStorageStatus";
  attemptsField: "cleanupQdrantAttempts" | "cleanupFulltextAttempts" | "cleanupObjectStorageAttempts";
  nextRunAtField: "cleanupQdrantNextRunAt" | "cleanupFulltextNextRunAt" | "cleanupObjectStorageNextRunAt";
  errorCodeField: "cleanupQdrantErrorCode" | "cleanupFulltextErrorCode" | "cleanupObjectStorageErrorCode";
  errorMessageField:
    | "cleanupQdrantErrorMessage"
    | "cleanupFulltextErrorMessage"
    | "cleanupObjectStorageErrorMessage";
};

export function cleanupFieldsFor(target: CleanupTarget): CleanupFieldNames {
  switch (target) {
    case "qdrant":
      return {
        statusField: "cleanupQdrantStatus",
        attemptsField: "cleanupQdrantAttempts",
        nextRunAtField: "cleanupQdrantNextRunAt",
        errorCodeField: "cleanupQdrantErrorCode",
        errorMessageField: "cleanupQdrantErrorMessage",
      };
    case "fulltext":
      return {
        statusField: "cleanupFulltextStatus",
        attemptsField: "cleanupFulltextAttempts",
        nextRunAtField: "cleanupFulltextNextRunAt",
        errorCodeField: "cleanupFulltextErrorCode",
        errorMessageField: "cleanupFulltextErrorMessage",
      };
    case "object_storage":
      return {
        statusField: "cleanupObjectStorageStatus",
        attemptsField: "cleanupObjectStorageAttempts",
        nextRunAtField: "cleanupObjectStorageNextRunAt",
        errorCodeField: "cleanupObjectStorageErrorCode",
        errorMessageField: "cleanupObjectStorageErrorMessage",
      };
  }
}

export type ListSpacesInput = {
  type?: string;
  limit?: number;
  cursor?: string | null;
};

export type ListDeletedInput = {
  limit?: number;
  cursor?: string | null;
  /**
   * 只列指定 cleanup target 处于以下任一 status 的空间。
   * GC worker 用 `["pending", "running"]` + `dueAt = now` 把"到期且非终态"过滤下推到 DB,
   * 避免第一页被 'failed' / 未到期 'pending' 占满导致后续行饥饿。
   * Admin 维护页可以传 `["pending", "running", "failed"]` 看所有未清完的。
   * 未传 statuses 时,行为同旧版:status != 'ok'(包含 failed)。
   */
  pendingTarget?: CleanupTarget;
  pendingTargetStatuses?: CleanupStatus[];
  /**
   * 只列指定 target 的 nextRunAt <= dueAt(或 nextRunAt IS NULL)的空间。
   * 必须与 `pendingTarget` 配对;单独传无意义。
   */
  dueAt?: Date;
};

export type SetCleanupStatusInput = {
  target: CleanupTarget;
  status: CleanupStatus;
  /** 写入「指定 target 自己的」errorCode 列。 */
  errorCode?: string | null;
  /** 写入「指定 target 自己的」errorMessage 列。 */
  errorMessage?: string | null;
  /** true → 指定 target 自己的 attempts +=1；false/undefined → 不动 attempts（'ok'/'running' 标记）。 */
  incrementAttempts?: boolean;
  /** 写入「指定 target 自己的」nextRunAt。'ok' 时传 null 清空。undefined 表示不动。 */
  nextRunAt?: Date | null;
  now?: Date;
};

export interface KnowledgeSpaceStore {
  create(space: KnowledgeSpaceRecord, tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord>;
  get(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null>;
  /** 公开列表：自动过滤 deletedAt。 */
  list(scope: TenantScope, input?: ListSpacesInput, tx?: KnowledgeTxClient): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }>;

  /**
   * 软删空间：写 status='deleted'、deletedAt、updatedBy；不动 cleanup_* 字段。
   * 调用方（SpaceDeletionService）在同事务里串联文档/任务的软删。
   */
  softDelete(scope: TenantScope, spaceId: string, userId: string, now?: Date, tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null>;

  /**
   * Admin 视角：包含已软删的单空间查询。
   */
  getIncludeDeleted(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null>;

  /**
   * Admin 视角：列所有已软删空间，支持按 cleanup target 过滤"还没清干净的"。
   */
  listDeleted(scope: TenantScope, input?: ListDeletedInput, tx?: KnowledgeTxClient): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }>;

  /**
   * GC worker 跨租户扫描：列**所有租户**的已软删空间。与 listDeleted 同语义，
   * 但不带 sourceSystemId/tenantId 过滤，cursor 仍按 spaceId asc。
   * 仅供 KnowledgeGCWorker 在未配置 scope 时使用；常规请求路径**不要**调用。
   */
  listDeletedAcrossTenants(input?: ListDeletedInput, tx?: KnowledgeTxClient): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }>;

  /**
   * 更新某个 cleanup target 的状态机（独立维护）。同时维护 attempts / 时间字段。
   */
  setCleanupStatus(scope: TenantScope, spaceId: string, input: SetCleanupStatusInput, tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null>;

  /**
   * GC worker 内部使用：物理删除单个空间行。公开 API 已禁止硬删，
   * 只能通过 GC 走 retention 流程触发（在所有子表 hardDeleteBySpace 完成后才调用）。
   * 返回 true 表示找到并删除；false 表示该空间不存在。
   */
  hardDelete(scope: TenantScope, spaceId: string, tx?: KnowledgeTxClient): Promise<boolean>;

  /**
   * Admin 撤回软删：把 status 改回 'active'、清 deletedAt、写 updatedBy/updatedAt。
   * 同时把三个 cleanup target 的 status 重置为 'ok'，清空 attempts/nextRunAt/errorCode/errorMessage
   * （恢复后这些字段语义不再适用）。
   * 返回 null 表示该空间不存在；若该空间已 active（不在回收站）返回当前记录但调用方应判断状态。
   */
  restoreSpace(
    scope: TenantScope,
    spaceId: string,
    userId: string,
    now?: Date,
    tx?: KnowledgeTxClient,
  ): Promise<KnowledgeSpaceRecord | null>;
}

export class InMemoryKnowledgeSpaceStore implements KnowledgeSpaceStore {
  private readonly spaces = new Map<string, KnowledgeSpaceRecord>();

  constructor(seedSpaces: KnowledgeSpaceRecord[] = []) {
    for (const space of seedSpaces) {
      this.spaces.set(this.key(space.sourceSystemId, space.tenantId, space.spaceId), { ...space });
    }
  }

  async create(space: KnowledgeSpaceRecord, _tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord> {
    requireTenantScope(space);
    const key = this.key(space.sourceSystemId, space.tenantId, space.spaceId);
    if (this.spaces.has(key)) {
      throw new Error(`space already exists: ${space.spaceId}`);
    }
    const withDefaults: KnowledgeSpaceRecord = {
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
      cleanupQdrantAttempts: 0,
      cleanupFulltextAttempts: 0,
      cleanupObjectStorageAttempts: 0,
      ...space,
    };
    this.spaces.set(key, withDefaults);
    return { ...withDefaults };
  }

  async get(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const space = this.spaces.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, spaceId));
    return space && space.status !== "deleted" ? { ...space } : null;
  }

  async list(scope: TenantScope, input: ListSpacesInput = {}, _tx?: KnowledgeTxClient): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const sorted = [...this.spaces.values()]
      .filter((space) => space.sourceSystemId === safeScope.sourceSystemId && space.tenantId === safeScope.tenantId)
      .filter((space) => space.status !== "deleted")
      .filter((space) => !input.type || space.type === input.type)
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId));
    const start = input.cursor ? sorted.findIndex((space) => space.spaceId === input.cursor) + 1 : 0;
    const items = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    const last = items.at(-1);
    const nextCursor = last && sorted.indexOf(last) < sorted.length - 1 ? last.spaceId : null;
    return { items: items.map((space) => ({ ...space })), nextCursor };
  }

  async softDelete(scope: TenantScope, spaceId: string, userId: string, now: Date = new Date(), _tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const key = this.key(safeScope.sourceSystemId, safeScope.tenantId, spaceId);
    const space = this.spaces.get(key);
    if (!space) return null;
    if (space.status === "deleted") return { ...space }; // idempotent
    const updated: KnowledgeSpaceRecord = {
      ...space,
      status: "deleted",
      deletedAt: now,
      updatedBy: userId,
      updatedAt: now,
    };
    this.spaces.set(key, updated);
    return { ...updated };
  }

  async getIncludeDeleted(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const space = this.spaces.get(this.key(safeScope.sourceSystemId, safeScope.tenantId, spaceId));
    return space ? { ...space } : null;
  }

  async listDeleted(scope: TenantScope, input: ListDeletedInput = {}, _tx?: KnowledgeTxClient): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const sorted = [...this.spaces.values()]
      .filter((space) => space.sourceSystemId === safeScope.sourceSystemId && space.tenantId === safeScope.tenantId)
      .filter((space) => space.status === "deleted")
      .filter((space) => matchPendingTarget(space, input))
      // 与 Prisma 一致：cursor 用 spaceId asc 作为 key，避免与 orderBy 错位漏页。
      // UI 需要按 deletedAt 展示自行本地排序。
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId));
    const start = input.cursor ? sorted.findIndex((space) => space.spaceId === input.cursor) + 1 : 0;
    const items = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    const last = items.at(-1);
    const nextCursor = last && sorted.indexOf(last) < sorted.length - 1 ? last.spaceId : null;
    return { items: items.map((space) => ({ ...space })), nextCursor };
  }

  async listDeletedAcrossTenants(input: ListDeletedInput = {}, _tx?: KnowledgeTxClient): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const sorted = [...this.spaces.values()]
      .filter((space) => space.status === "deleted")
      .filter((space) => matchPendingTarget(space, input))
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId));
    const start = input.cursor ? sorted.findIndex((space) => space.spaceId === input.cursor) + 1 : 0;
    const items = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    const last = items.at(-1);
    const nextCursor = last && sorted.indexOf(last) < sorted.length - 1 ? last.spaceId : null;
    return { items: items.map((space) => ({ ...space })), nextCursor };
  }

  async hardDelete(scope: TenantScope, spaceId: string, _tx?: KnowledgeTxClient): Promise<boolean> {
    const safeScope = requireTenantScope(scope);
    const key = this.key(safeScope.sourceSystemId, safeScope.tenantId, spaceId);
    return this.spaces.delete(key);
  }

  async restoreSpace(
    scope: TenantScope,
    spaceId: string,
    userId: string,
    now: Date = new Date(),
    _tx?: KnowledgeTxClient,
  ): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const key = this.key(safeScope.sourceSystemId, safeScope.tenantId, spaceId);
    const space = this.spaces.get(key);
    if (!space) return null;
    const updated: KnowledgeSpaceRecord = {
      ...space,
      status: "active",
      deletedAt: null,
      updatedBy: userId,
      updatedAt: now,
      cleanupQdrantStatus: "ok",
      cleanupFulltextStatus: "ok",
      cleanupObjectStorageStatus: "ok",
      cleanupQdrantAttempts: 0,
      cleanupFulltextAttempts: 0,
      cleanupObjectStorageAttempts: 0,
      cleanupQdrantNextRunAt: null,
      cleanupFulltextNextRunAt: null,
      cleanupObjectStorageNextRunAt: null,
      cleanupQdrantErrorCode: null,
      cleanupQdrantErrorMessage: null,
      cleanupFulltextErrorCode: null,
      cleanupFulltextErrorMessage: null,
      cleanupObjectStorageErrorCode: null,
      cleanupObjectStorageErrorMessage: null,
    };
    this.spaces.set(key, updated);
    return { ...updated };
  }

  async setCleanupStatus(scope: TenantScope, spaceId: string, input: SetCleanupStatusInput, _tx?: KnowledgeTxClient): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const key = this.key(safeScope.sourceSystemId, safeScope.tenantId, spaceId);
    const space = this.spaces.get(key);
    if (!space) return null;
    const now = input.now ?? new Date();
    const f = cleanupFieldsFor(input.target);
    // 每 target 写自己的 4 个字段；cleanupLastAttemptAt 仍是三 target 共用的"最近活动时间"。
    const prevAttempts = (space[f.attemptsField] as number | undefined) ?? 0;
    const updated: KnowledgeSpaceRecord = {
      ...space,
      [f.statusField]: input.status,
      [f.errorCodeField]:
        input.errorCode !== undefined ? input.errorCode : space[f.errorCodeField] ?? null,
      [f.errorMessageField]:
        input.errorMessage !== undefined ? input.errorMessage : space[f.errorMessageField] ?? null,
      [f.attemptsField]: input.incrementAttempts ? prevAttempts + 1 : prevAttempts,
      [f.nextRunAtField]:
        input.nextRunAt === undefined ? space[f.nextRunAtField] ?? null : input.nextRunAt,
      cleanupLastAttemptAt: now,
      updatedAt: now,
    };
    this.spaces.set(key, updated);
    return { ...updated };
  }

  snapshot(): KnowledgeSpaceRecord[] {
    return [...this.spaces.values()].map((space) => ({ ...space }));
  }

  private key(sourceSystemId: string, tenantId: string, spaceId: string): string {
    return `${sourceSystemId}:${tenantId}:${spaceId}`;
  }
}

/**
 * 共享:listDeleted / listDeletedAcrossTenants 的 pendingTarget 过滤。
 * - 默认(无 statuses/dueAt):status != 'ok'(包含 failed) — 兼容旧 admin 维护页查询
 * - 给 statuses:只匹配这些 status
 * - 给 dueAt:还要求 target.nextRunAt <= dueAt 或 nextRunAt is null
 */
function matchPendingTarget(space: KnowledgeSpaceRecord, input: ListDeletedInput): boolean {
  if (!input.pendingTarget) return true;
  const f = cleanupFieldsFor(input.pendingTarget);
  const status = (space[f.statusField] ?? "ok") as CleanupStatus;
  if (input.pendingTargetStatuses) {
    if (!input.pendingTargetStatuses.includes(status)) return false;
  } else {
    if (status === "ok") return false;
  }
  if (input.dueAt) {
    const nextRunAt = space[f.nextRunAtField] as Date | null | undefined;
    if (nextRunAt && nextRunAt.getTime() > input.dueAt.getTime()) return false;
  }
  return true;
}

