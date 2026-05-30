/**
 * Admin maintenance endpoints for the knowledge space lifecycle (Phase C).
 *
 * All routes here require the caller to carry the `knowledge_admin` role in the
 * `x-octopus-roles` header. Non-admins land in 403 FORBIDDEN before any other
 * validation runs.
 *
 * URLs (all prefixed `/v1/admin`):
 *   GET    /spaces/deleted                 — list recycle bin
 *   GET    /spaces/deleted/:space_id       — single soft-deleted space
 *   POST   /spaces/:space_id/restore       — undo soft delete
 *   POST   /spaces/:space_id/purge         — force hard delete (requires confirm_name)
 *   POST   /spaces/:space_id/cleanup-retry — retry one or all cleanup targets
 *   GET    /gc/status                      — GC worker health snapshot
 *   POST   /gc/run                         — run GC once on demand
 *   GET    /audit/cleanup-failures         — list cleanup_failed / purge_failed audit rows
 */
import type { Express, NextFunction, Request, Response } from "express";
import type {
  KnowledgeAuditEventRecord,
  KnowledgeAuditEventWriter,
} from "../repositories/audit-events.js";
import {
  type CleanupTarget,
  type KnowledgeSpaceRecord,
  type KnowledgeSpaceStore,
} from "../repositories/space-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { KnowledgeGCWorker } from "../workers/gc-worker.js";
import { sendError, sendOk } from "./envelope.js";

const ADMIN_ROLE = "knowledge_admin";
const CLEANUP_TARGETS: CleanupTarget[] = ["qdrant", "fulltext", "object_storage"];

type AdminDeps = {
  spaces: KnowledgeSpaceStore;
  documents: KnowledgeDocumentStore;
  audit: KnowledgeAuditEventWriter;
  gcWorker: KnowledgeGCWorker;
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
};

function parseCsv(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter((s) => s.length > 0);
}

function scopeFromRequest(req: Request): TenantScope {
  return {
    sourceSystemId: String(req.headers["x-octopus-source-system"] || "octopus"),
    tenantId: String(req.headers["x-octopus-tenant"] || ""),
  };
}

function userFromRequest(req: Request): string {
  return String(req.headers["x-octopus-user"] || "");
}

function rolesFromRequest(req: Request): string[] {
  return parseCsv(req.headers["x-octopus-roles"]);
}

/** Express middleware that enforces caller has the knowledge_admin role. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const roles = rolesFromRequest(req);
  if (!roles.includes(ADMIN_ROLE)) {
    sendError(res, "FORBIDDEN", "requires knowledge_admin role");
    return;
  }
  next();
}

function serializeSpace(space: KnowledgeSpaceRecord): Record<string, unknown> {
  return {
    space_id: space.spaceId,
    type: space.type,
    name: space.name,
    description: space.description ?? null,
    owner_type: space.ownerType,
    owner_id: space.ownerId,
    default_acl: space.defaultAcl ?? null,
    status: space.status,
    created_by: space.createdBy,
    updated_by: space.updatedBy ?? null,
    created_at: space.createdAt?.toISOString() ?? null,
    updated_at: space.updatedAt?.toISOString() ?? null,
    deleted_at: space.deletedAt?.toISOString() ?? null,
    cleanup_status: {
      qdrant: {
        status: space.cleanupQdrantStatus ?? "ok",
        attempts: space.cleanupQdrantAttempts ?? 0,
        next_run_at: space.cleanupQdrantNextRunAt?.toISOString() ?? null,
        error_code: space.cleanupQdrantErrorCode ?? null,
        error_message: space.cleanupQdrantErrorMessage ?? null,
      },
      fulltext: {
        status: space.cleanupFulltextStatus ?? "ok",
        attempts: space.cleanupFulltextAttempts ?? 0,
        next_run_at: space.cleanupFulltextNextRunAt?.toISOString() ?? null,
        error_code: space.cleanupFulltextErrorCode ?? null,
        error_message: space.cleanupFulltextErrorMessage ?? null,
      },
      object_storage: {
        status: space.cleanupObjectStorageStatus ?? "ok",
        attempts: space.cleanupObjectStorageAttempts ?? 0,
        next_run_at: space.cleanupObjectStorageNextRunAt?.toISOString() ?? null,
        error_code: space.cleanupObjectStorageErrorCode ?? null,
        error_message: space.cleanupObjectStorageErrorMessage ?? null,
      },
    },
  };
}

function serializeAuditEvent(event: KnowledgeAuditEventRecord): Record<string, unknown> {
  return {
    source_system_id: event.sourceSystemId,
    tenant_id: event.tenantId,
    user_id: event.userId ?? null,
    request_id: event.requestId ?? null,
    action: event.action,
    resource_type: event.resourceType ?? null,
    resource_id: event.resourceId ?? null,
    success: event.success ?? true,
    error_code: event.errorCode ?? null,
    details: event.details ?? null,
    created_at: event.createdAt.toISOString(),
  };
}

export function registerAdminRoutes(app: Express, deps: AdminDeps): void {
  const { spaces, documents, audit, gcWorker, requireAuth } = deps;
  const guard = [requireAuth, requireAdmin] as const;

  // GET /v1/admin/spaces/deleted
  app.get("/v1/admin/spaces/deleted", ...guard, async (req, res) => {
    const scope = scopeFromRequest(req);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const pendingTargetRaw = typeof req.query.pending_target === "string" ? req.query.pending_target : null;
    const pendingTarget =
      pendingTargetRaw && (CLEANUP_TARGETS as string[]).includes(pendingTargetRaw)
        ? (pendingTargetRaw as CleanupTarget)
        : undefined;
    const result = await spaces.listDeleted(scope, { cursor, limit, pendingTarget });
    sendOk(res, {
      items: result.items.map(serializeSpace),
      next_cursor: result.nextCursor,
    });
  });

  // GET /v1/admin/spaces/deleted/:space_id
  app.get("/v1/admin/spaces/deleted/:space_id", ...guard, async (req, res) => {
    const scope = scopeFromRequest(req);
    const space = await spaces.getIncludeDeleted(scope, req.params.space_id);
    if (!space) {
      sendError(res, "NOT_FOUND", `space not found: ${req.params.space_id}`);
      return;
    }
    if (space.status !== "deleted") {
      sendError(res, "NOT_FOUND", `space ${req.params.space_id} is not in recycle bin`);
      return;
    }
    sendOk(res, serializeSpace(space));
  });

  // POST /v1/admin/spaces/:space_id/restore
  app.post("/v1/admin/spaces/:space_id/restore", ...guard, async (req, res) => {
    const scope = scopeFromRequest(req);
    const userId = userFromRequest(req);
    const spaceId = req.params.space_id;
    const existing = await spaces.getIncludeDeleted(scope, spaceId);
    if (!existing) {
      sendError(res, "NOT_FOUND", `space not found: ${spaceId}`);
      return;
    }
    if (existing.status === "active") {
      sendError(res, "CONFLICT", `space ${spaceId} is already active`);
      return;
    }
    const now = new Date();
    const restored = await spaces.restoreSpace(scope, spaceId, userId, now);
    if (!restored) {
      sendError(res, "NOT_FOUND", `space not found: ${spaceId}`);
      return;
    }
    // 同时恢复空间内被 softDeleteBySpace 标 deleted 的文档(否则空间可见但文档不可检索)
    const restoredDocs = await documents.restoreBySpace(scope, spaceId, now);
    await audit.write({
      sourceSystemId: scope.sourceSystemId,
      tenantId: scope.tenantId,
      userId,
      action: "space.restore",
      resourceType: "knowledge_space",
      resourceId: spaceId,
      success: true,
      details: {
        previous_deleted_at: existing.deletedAt?.toISOString() ?? null,
        documents_restored: restoredDocs,
      },
      createdAt: now,
    });
    sendOk(res, { space_id: spaceId, status: "active" });
  });

  // POST /v1/admin/spaces/:space_id/purge
  app.post("/v1/admin/spaces/:space_id/purge", ...guard, async (req, res) => {
    const scope = scopeFromRequest(req);
    const spaceId = req.params.space_id;
    const confirmName = typeof req.body?.confirm_name === "string" ? req.body.confirm_name : "";
    const existing = await spaces.getIncludeDeleted(scope, spaceId);
    if (!existing) {
      sendError(res, "NOT_FOUND", `space not found: ${spaceId}`);
      return;
    }
    if (existing.status !== "deleted") {
      sendError(res, "CONFLICT", `space ${spaceId} is not soft-deleted; soft-delete first`);
      return;
    }
    if (!confirmName || confirmName !== existing.name) {
      sendError(res, "BAD_REQUEST", "confirm_name must equal the space name", { code: "NAME_MISMATCH" });
      return;
    }
    const result = await gcWorker.purgeSpaceById(scope, spaceId);
    if (!result.ok) {
      if (result.code === "CLEANUP_PENDING") {
        // 外部资源(qdrant/fulltext/object_storage)清不干净 → 用 CONFLICT 映射,
        // 客户端可以重新调 cleanup-retry 或等待 GC 自动重试。
        sendError(res, "CONFLICT", result.message, {
          code: "CLEANUP_PENDING",
          cleanup_status: result.cleanup_status,
        });
        return;
      }
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, { space_id: spaceId, counts: result.counts });
  });

  // POST /v1/admin/spaces/:space_id/cleanup-retry
  app.post("/v1/admin/spaces/:space_id/cleanup-retry", ...guard, async (req, res) => {
    const scope = scopeFromRequest(req);
    const spaceId = req.params.space_id;
    const targetRaw = typeof req.body?.target === "string" ? req.body.target : "";
    if (targetRaw !== "all" && !(CLEANUP_TARGETS as string[]).includes(targetRaw)) {
      sendError(res, "BAD_REQUEST", "target must be one of qdrant|fulltext|object_storage|all");
      return;
    }
    const target = targetRaw as CleanupTarget | "all";
    const result = await gcWorker.cleanupRetry(scope, spaceId, target);
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    await audit.write({
      sourceSystemId: scope.sourceSystemId,
      tenantId: scope.tenantId,
      userId: userFromRequest(req),
      action: "space.cleanup_retry",
      resourceType: "knowledge_space",
      resourceId: spaceId,
      success: true,
      details: { target, status_after: result.status_after },
    });
    sendOk(res, { space_id: spaceId, target, status_after: result.status_after });
  });

  // GET /v1/admin/gc/status
  app.get("/v1/admin/gc/status", ...guard, async (_req, res) => {
    const status = gcWorker.getStatus();
    sendOk(res, {
      last_run_at: status.lastRunAt?.toISOString() ?? null,
      last_run_result: status.lastRunResult,
      gauges: {
        pending_cleanup: status.pendingCleanup,
        oldest_deleted_age_seconds: status.oldestDeletedAgeSeconds,
        runs_total: status.runsTotal,
        spaces_purged_total: status.spacesPurgedTotal,
        spaces_failed_total: status.spacesFailedTotal,
      },
    });
  });

  // POST /v1/admin/gc/run
  // P0(C 二审):**默认走请求 header 的 tenant scope**,而不是无 scope 触发跨租户扫描。
  // 跨租户 GC 必须显式传 body { cross_tenant: true },将来加平台级角色门禁;
  // 当前的 knowledge_admin 是 tenant 内角色,不应能影响其他租户的数据。
  app.post("/v1/admin/gc/run", ...guard, async (req, res) => {
    const requestScope = scopeFromRequest(req);
    const bodyScope = req.body?.scope;
    let scopeOverride: TenantScope | undefined = requestScope;
    if (bodyScope && typeof bodyScope === "object") {
      const ssi = typeof bodyScope.sourceSystemId === "string" ? bodyScope.sourceSystemId : requestScope.sourceSystemId;
      const tid = typeof bodyScope.tenantId === "string" ? bodyScope.tenantId : requestScope.tenantId;
      // 即使 body 给了 scope,也只能在自己的 tenant 内(避免越权);严格匹配 header tenant。
      if (tid !== requestScope.tenantId) {
        sendError(res, "FORBIDDEN", "scope.tenantId must match request tenant; cross-tenant GC requires platform-level role (not yet implemented)");
        return;
      }
      scopeOverride = { sourceSystemId: ssi, tenantId: tid };
    }
    const result = await gcWorker.runOnce(scopeOverride);
    sendOk(res, result);
  });

  // GET /v1/admin/audit/cleanup-failures
  app.get("/v1/admin/audit/cleanup-failures", ...guard, async (req, res) => {
    const scope = scopeFromRequest(req);
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const result = await audit.list(scope, {
      actions: ["space.purge_failed", "space.cleanup_failed", "cleanup_failed"],
      limit,
      cursor,
    });
    sendOk(res, {
      items: result.items.map(serializeAuditEvent),
      next_cursor: result.nextCursor,
    });
  });
}
