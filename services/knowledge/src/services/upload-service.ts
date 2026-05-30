import { createOpaqueId } from "@octopus/knowledge-contracts";
import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { KnowledgeObjectStore } from "../repositories/object-store.js";
import type { KnowledgeSpaceStore } from "../repositories/space-store.js";
import type { KnowledgeUploadSessionRecord, KnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { ServiceResult } from "./document-service.js";

export type CreateUploadUrlInput = {
  spaceId: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string | null;
  issuedBy: string;
};

export class KnowledgeUploadService {
  constructor(private readonly deps: {
    spaces: KnowledgeSpaceStore;
    uploads: KnowledgeUploadSessionStore;
    objects?: KnowledgeObjectStore;
    audit: KnowledgeAuditEventWriter;
    objectUriPrefix?: string;
    publicUploadBasePath?: string;
  }) {}

  async createUploadUrl(scope: TenantScope, input: CreateUploadUrlInput, now = new Date()): Promise<ServiceResult<{
    upload_id: string;
    asset_id: string;
    object_uri: string;
    presigned_url: string | null;
    status: "stub" | "ready";
    expires_in_seconds: number;
    headers: Record<string, string>;
  }>> {
    const space = await this.deps.spaces.get(scope, input.spaceId);
    if (!space) {
      return { ok: false, code: "NOT_FOUND", message: "space not found" };
    }
    if (!input.filename?.trim()) {
      return { ok: false, code: "BAD_REQUEST", message: "filename is required" };
    }
    const sizeBytes = Number(input.sizeBytes ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return { ok: false, code: "BAD_REQUEST", message: "size_bytes must be positive" };
    }

    const uploadId = createOpaqueId("upload");
    const assetId = createOpaqueId("asset");
    const expiresInSeconds = 900;
    const mimeType = input.mimeType || "application/octet-stream";
    const objectUri = `${this.deps.objectUriPrefix ?? "mem://octopus-knowledge"}/${scope.sourceSystemId}/${scope.tenantId}/raw/${uploadId}/${encodeURIComponent(input.filename.trim())}`;
    const session: KnowledgeUploadSessionRecord = {
      ...scope,
      uploadId,
      spaceId: input.spaceId,
      assetId,
      objectUri,
      filename: input.filename.trim(),
      mimeType,
      sizeBytes,
      claimedSha256: input.sha256 ?? null,
      status: "issued",
      issuedBy: input.issuedBy,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.uploads.create(session);
    await this.deps.audit.write({
      ...scope,
      userId: input.issuedBy,
      action: "upload.issue",
      resourceType: "upload",
      resourceId: uploadId,
      details: { space_id: input.spaceId, asset_id: assetId, size_bytes: sizeBytes },
      createdAt: now,
    });
    return {
      ok: true,
      data: {
        upload_id: uploadId,
        asset_id: assetId,
        object_uri: objectUri,
        presigned_url: `${this.deps.publicUploadBasePath ?? "/v1/assets/uploads"}/${uploadId}/content`,
        status: this.deps.objects ? "ready" : "stub",
        expires_in_seconds: expiresInSeconds,
        headers: { "Content-Type": mimeType },
      },
    };
  }

  async putUploadedContent(scope: TenantScope, input: {
    uploadId: string;
    body: Buffer;
    userId: string;
    mimeType?: string | null;
    now?: Date;
  }): Promise<ServiceResult<{ upload_id: string; asset_id: string; object_uri: string; sha256: string; size_bytes: number; status: "consumed" }>> {
    if (!this.deps.objects) {
      return { ok: false, code: "SERVICE_UNAVAILABLE", message: "object store is not configured" };
    }
    const now = input.now ?? new Date();
    const session = await this.deps.uploads.get(scope, input.uploadId);
    if (!session || session.status !== "issued" || session.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, code: "NOT_FOUND", message: "upload session not found" };
    }
    if (session.issuedBy !== input.userId) {
      // Indistinguishable error to avoid leaking the existence of an upload session
      // belonging to another user within the same tenant.
      return { ok: false, code: "NOT_FOUND", message: "upload session not found" };
    }
    const object = await this.deps.objects.put(scope, session.objectUri, input.body, {
      mimeType: input.mimeType ?? session.mimeType,
      now,
      // 让 GC worker(Phase B)能通过 listBySpace/deleteBySpaceId 定位本对象。
      spaceId: session.spaceId,
    });
    if (session.claimedSha256 && session.claimedSha256.toLowerCase() !== object.sha256) {
      return { ok: false, code: "CONTENT_HASH_MISMATCH", message: "uploaded content sha256 does not match claimed sha256" };
    }
    const consumed = await this.deps.uploads.consume(scope, input.uploadId, object.sha256, now);
    if (!consumed) {
      return { ok: false, code: "CONFLICT", message: "upload session could not be consumed" };
    }
    await this.deps.audit.write({
      ...scope,
      userId: session.issuedBy,
      action: "upload.consume",
      resourceType: "upload",
      resourceId: input.uploadId,
      details: { asset_id: session.assetId, object_uri: session.objectUri, sha256: object.sha256, size_bytes: object.sizeBytes },
      createdAt: now,
    });
    return {
      ok: true,
      data: {
        upload_id: input.uploadId,
        asset_id: session.assetId,
        object_uri: session.objectUri,
        sha256: object.sha256,
        size_bytes: object.sizeBytes,
        status: "consumed",
      },
    };
  }
}
