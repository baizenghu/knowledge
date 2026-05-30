import { createOpaqueId } from "@octopus/knowledge-contracts";
import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { KnowledgeSpaceRecord, KnowledgeSpaceStore } from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { ServiceResult } from "./document-service.js";

export type CreateSpaceInput = {
  type?: string;
  name?: string;
  description?: string | null;
  ownerType?: string;
  ownerId?: string;
  defaultAcl?: unknown;
  createdBy: string;
};

export class KnowledgeSpaceService {
  constructor(private readonly deps: {
    spaces: KnowledgeSpaceStore;
    audit: KnowledgeAuditEventWriter;
  }) {}

  async createSpace(scope: TenantScope, input: CreateSpaceInput, now = new Date()): Promise<ServiceResult<{ space_id: string; status: string }>> {
    const type = normalizeSpaceType(input.type);
    const ownerType = normalizeOwnerType(input.ownerType, type);
    const ownerId = input.ownerId || defaultOwnerId(scope, input.createdBy, ownerType);
    if (!input.name?.trim()) {
      return { ok: false, code: "BAD_REQUEST", message: "space name is required" };
    }
    const space: KnowledgeSpaceRecord = {
      ...scope,
      spaceId: createOpaqueId("space"),
      type,
      name: input.name.trim(),
      description: input.description ?? null,
      ownerType,
      ownerId,
      defaultAcl: input.defaultAcl ?? defaultAclForSpace(scope, ownerType, ownerId),
      status: "active",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.spaces.create(space);
    await this.deps.audit.write({
      ...scope,
      userId: input.createdBy,
      action: "space.create",
      resourceType: "space",
      resourceId: space.spaceId,
      details: { type: space.type, owner_type: space.ownerType, owner_id: space.ownerId },
      createdAt: now,
    });
    return { ok: true, data: { space_id: space.spaceId, status: space.status } };
  }

  async listSpaces(
    scope: TenantScope,
    input: { type?: string; limit?: number; cursor?: string | null },
    context?: SpaceListContext,
  ): Promise<ServiceResult<{ items: unknown[]; next_cursor: string | null }>> {
    const result = await this.deps.spaces.list(scope, input);
    const filtered = context ? result.items.filter((space) => isSpaceVisible(space, context)) : result.items;
    return {
      ok: true,
      data: {
        items: filtered.map((space) => ({
          space_id: space.spaceId,
          type: space.type,
          name: space.name,
          description: space.description ?? null,
          owner_type: space.ownerType,
          owner_id: space.ownerId,
          status: space.status,
          created_by: space.createdBy,
          created_at: space.createdAt.toISOString(),
          updated_at: space.updatedAt.toISOString(),
        })),
        next_cursor: result.nextCursor,
      },
    };
  }
}

export type SpaceListContext = {
  userId: string;
  departments: string[];
  roles: string[];
};

const ADMIN_ROLES = new Set(["knowledge_admin", "knowledge_editor"]);

/**
 * 三层可见性：
 * - admin/editor 角色：旁路过滤，可见全部（运营/调试场景）
 * - tenant 类型：租户内全可见
 * - department 类型：ownerId ∈ context.departments
 * - user 类型：ownerId === context.userId
 */
function isSpaceVisible(space: KnowledgeSpaceRecord, context: SpaceListContext): boolean {
  if (context.roles.some((role) => ADMIN_ROLES.has(role))) return true;
  if (space.ownerType === "tenant") return true;
  if (space.ownerType === "department") return context.departments.includes(space.ownerId);
  if (space.ownerType === "user") return space.ownerId === context.userId;
  return false;
}

function normalizeSpaceType(type: string | undefined): KnowledgeSpaceRecord["type"] {
  if (type === "department" || type === "personal" || type === "enterprise") {
    return type;
  }
  return "enterprise";
}

function normalizeOwnerType(ownerType: string | undefined, type: KnowledgeSpaceRecord["type"]): KnowledgeSpaceRecord["ownerType"] {
  if (ownerType === "tenant" || ownerType === "department" || ownerType === "user") {
    return ownerType;
  }
  if (type === "department") {
    return "department";
  }
  if (type === "personal") {
    return "user";
  }
  return "tenant";
}

function defaultOwnerId(scope: TenantScope, userId: string, ownerType: KnowledgeSpaceRecord["ownerType"]): string {
  if (ownerType === "user") {
    return userId;
  }
  return scope.tenantId;
}

function defaultAclForSpace(scope: TenantScope, ownerType: KnowledgeSpaceRecord["ownerType"], ownerId: string): Record<string, unknown> {
  if (ownerType === "user") {
    return { read: [{ type: "user", id: ownerId }], write: [{ type: "user", id: ownerId }], admin: [{ type: "user", id: ownerId }] };
  }
  if (ownerType === "department") {
    return { read: [{ type: "department", id: ownerId }], write: [{ type: "department", id: ownerId }], admin: [] };
  }
  return { read: [{ type: "tenant", id: scope.tenantId }], write: [], admin: [] };
}
