import { createOpaqueId, type KnowledgeErrorCode } from "@octopus/knowledge-contracts";
import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { KnowledgeAclStore } from "../repositories/acl-store.js";
import type { KnowledgeDocumentStore, KnowledgeDocumentRecord } from "../repositories/document-store.js";
import type { KnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import type { KnowledgeIdempotencyStore } from "../repositories/idempotency-store.js";
import type { KnowledgeJobStore } from "../repositories/job-store.js";
import type { KnowledgeObjectStore } from "../repositories/object-store.js";
import type { KnowledgeSpaceStore } from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import { NoopKnowledgeUnitOfWork, type KnowledgeUnitOfWork } from "../repositories/unit-of-work.js";
import type { KnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";

export type ServiceResult<T> =
  | { ok: true; data: T; replayed?: boolean }
  | { ok: false; code: KnowledgeErrorCode; message: string };

export type IngestInput = {
  spaceId: string;
  title?: string;
  documentType?: string;
  sourceType?: string;
  sourceUri?: string;
  uploadId?: string;
  filename?: string;
  sourceSha256?: string;
  createdBy: string;
  idempotencyKey?: string;
};

export type IngestOutput = {
  document_id: string;
  document_version_id: string;
  document_version_number: number;
  job_id: string;
  status: "queued" | "succeeded";
};

export class KnowledgeDocumentService {
  constructor(private readonly deps: {
    documents: KnowledgeDocumentStore;
    versions?: KnowledgeDocumentVersionStore;
    jobs: KnowledgeJobStore;
    idempotency: KnowledgeIdempotencyStore;
    audit: KnowledgeAuditEventWriter;
    spaces: KnowledgeSpaceStore;
    acl: KnowledgeAclStore;
    uploads?: KnowledgeUploadSessionStore;
    objects?: KnowledgeObjectStore;
    unitOfWork?: KnowledgeUnitOfWork;
  }) {}

  async ingest(scope: TenantScope, input: IngestInput, now = new Date()): Promise<ServiceResult<IngestOutput>> {
    if (!input.sourceSha256 || !/^[a-f0-9]{64}$/i.test(input.sourceSha256)) {
      return { ok: false, code: "BAD_REQUEST", message: "source.sha256 is required and must be a 64-character hex digest" };
    }
    const sourceSha256 = input.sourceSha256.toLowerCase();
    const sourceValidation = await this.validateSource(scope, input, sourceSha256);
    if (!sourceValidation.ok) {
      return sourceValidation;
    }
    const source = sourceValidation.data;
    if (input.idempotencyKey) {
      const reservation = await this.deps.idempotency.begin<IngestOutput>(
        scope,
        input.idempotencyKey,
        "POST",
        "/v1/documents/ingest",
        input,
        new Date(now.getTime() + 24 * 60 * 60_000),
        now,
      );
      if (reservation.status === "conflict") {
        return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: "idempotency key reused with a different request" };
      }
      if (reservation.status === "replayed" && reservation.record.responseJson) {
        return { ok: true, data: reservation.record.responseJson, replayed: true };
      }
    }

    const unitOfWork = this.deps.unitOfWork ?? new NoopKnowledgeUnitOfWork();
    return unitOfWork.run(async () => {
      const space = await this.deps.spaces.get(scope, input.spaceId);
      if (!space) {
        return { ok: false, code: "NOT_FOUND", message: "space not found" };
      }
      const documentId = createOpaqueId("doc");
      const versionId = createOpaqueId("ver");
      const jobId = createOpaqueId("job");
      const existing = await this.deps.documents.findBySourceSha256(scope, input.spaceId, sourceSha256);
      if (existing?.currentVersionId && existing.currentVersionNumber) {
        await this.deps.jobs.add({
          ...scope,
          jobId,
          type: "ingest_duplicate",
          status: "succeeded",
          priority: 100,
          spaceId: input.spaceId,
          documentId: existing.documentId,
          payload: {
            version_id: existing.currentVersionId,
            space_id: input.spaceId,
            duplicate: true,
            object_uri: source.objectUri,
            upload_id: source.uploadId,
            source_sha256: sourceSha256,
            source_filename: input.filename ?? null,
            source_type: input.sourceType ?? null,
          },
          attempt: 0,
          maxRetries: 0,
          runAfterAt: now,
          finishedAt: now,
        });
        const duplicateOutput: IngestOutput = {
          document_id: existing.documentId,
          document_version_id: existing.currentVersionId,
          document_version_number: existing.currentVersionNumber,
          job_id: jobId,
          status: "succeeded",
        };
        if (input.idempotencyKey) {
          await this.deps.idempotency.complete(scope, input.idempotencyKey, duplicateOutput, "document", existing.documentId, now);
        }
        return { ok: true, data: duplicateOutput };
      }
      const defaultAcl = space?.defaultAcl ?? { read: [{ type: "tenant", id: scope.tenantId }], write: [], admin: [] };
      const aclSnapshot = await this.deps.acl.upsertSnapshot(scope, defaultAcl, null, null, now);
      const document: KnowledgeDocumentRecord = {
        ...scope,
        documentId,
        spaceId: input.spaceId,
        title: input.title || "Untitled document",
        documentType: input.documentType || null,
        status: "queued",
        visibilityStatus: "hidden",
        currentVersionId: versionId,
        currentVersionNumber: 1,
        aclHash: aclSnapshot.aclHash,
        aclVersion: 1,
        sourceSha256,
        sourceFilename: input.filename ?? null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.documents.create(document);
      await this.deps.acl.replaceDocumentPrincipals({
        scope,
        documentId,
        aclHash: aclSnapshot.aclHash,
        aclVersion: 1,
        canonicalAcl: aclSnapshot.canonicalJson,
        now,
      });
      await this.deps.versions?.create({
        ...scope,
        versionId,
        documentId,
        versionNumber: 1,
        status: "queued",
        contentSha256: sourceSha256,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      });

      await this.deps.jobs.add({
        ...scope,
        jobId,
        type: "ingest",
        status: "queued",
        priority: 100,
        spaceId: input.spaceId,
        documentId,
        payload: {
          version_id: versionId,
          space_id: input.spaceId,
          object_uri: source.objectUri,
          upload_id: source.uploadId,
          source_sha256: sourceSha256,
          source_filename: input.filename ?? null,
          source_type: input.sourceType ?? null,
        },
        attempt: 0,
        maxRetries: 3,
        runAfterAt: now,
      });

      const output: IngestOutput = {
        document_id: documentId,
        document_version_id: versionId,
        document_version_number: 1,
        job_id: jobId,
        status: "queued",
      };

      if (input.idempotencyKey) {
        await this.deps.idempotency.complete(scope, input.idempotencyKey, output, "document", documentId, now);
      }
      await this.deps.audit.write({
        ...scope,
        userId: input.createdBy,
        action: "ingest",
        resourceType: "document",
        resourceId: documentId,
        details: { job_id: jobId, space_id: input.spaceId },
        createdAt: now,
      });
      return { ok: true, data: output };
    });
  }

  private async validateSource(scope: TenantScope, input: IngestInput, sourceSha256: string): Promise<ServiceResult<{ objectUri: string | null; uploadId: string | null }>> {
    if (input.uploadId && this.deps.uploads) {
      const session = await this.deps.uploads.get(scope, input.uploadId);
      if (!session || session.spaceId !== input.spaceId || session.status !== "consumed" || !session.actualSha256) {
        return { ok: false, code: "NOT_FOUND", message: "uploaded source not found" };
      }
      if (session.actualSha256.toLowerCase() !== sourceSha256) {
        return { ok: false, code: "CONTENT_HASH_MISMATCH", message: "source.sha256 does not match uploaded object sha256" };
      }
      return { ok: true, data: { objectUri: session.objectUri, uploadId: session.uploadId } };
    }
    if (input.sourceUri && this.deps.objects) {
      // Bind sourceUri back to a consumed upload session in the same scope so that
      // knowing a legitimate objectUri is not enough to ingest someone else's file
      // (defense beyond the assertObjectUriInScope marker check).
      if (this.deps.uploads) {
        const session = await this.deps.uploads.getByObjectUri(scope, input.sourceUri);
        if (!session || session.spaceId !== input.spaceId || session.status !== "consumed" || !session.actualSha256) {
          return { ok: false, code: "NOT_FOUND", message: "source object not found" };
        }
        if (session.actualSha256.toLowerCase() !== sourceSha256) {
          return { ok: false, code: "CONTENT_HASH_MISMATCH", message: "source.sha256 does not match object sha256" };
        }
        return { ok: true, data: { objectUri: session.objectUri, uploadId: session.uploadId } };
      }
      const actualSha256 = await this.deps.objects.sha256(scope, input.sourceUri);
      if (!actualSha256) {
        return { ok: false, code: "NOT_FOUND", message: "source object not found" };
      }
      if (actualSha256.toLowerCase() !== sourceSha256) {
        return { ok: false, code: "CONTENT_HASH_MISMATCH", message: "source.sha256 does not match object sha256" };
      }
      return { ok: true, data: { objectUri: input.sourceUri, uploadId: input.uploadId ?? null } };
    }
    if (input.sourceType === "object_uri") {
      return { ok: false, code: "SERVICE_UNAVAILABLE", message: "object store is not configured" };
    }
    return { ok: true, data: { objectUri: input.sourceUri ?? null, uploadId: input.uploadId ?? null } };
  }

  async deleteDocument(scope: TenantScope, documentId: string, userId: string, now = new Date()): Promise<ServiceResult<{ document_id: string; status: "deleted"; cancelled_jobs: number }>> {
    const document = await this.deps.documents.softDelete(scope, documentId, now);
    if (!document) {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    const cancelledJobs = await this.deps.jobs.cancelDocumentJobs(scope, documentId, `document_deleted by ${userId}`, now);
    await this.deps.audit.write({
      ...scope,
      userId,
      action: "delete",
      resourceType: "document",
      resourceId: documentId,
      details: { cancelled_jobs: cancelledJobs },
      createdAt: now,
    });
    return { ok: true, data: { document_id: documentId, status: "deleted", cancelled_jobs: cancelledJobs } };
  }

  async listDocumentsBySpace(
    scope: TenantScope,
    spaceId: string,
    input: { limit?: number; cursor?: string | null; includeDeleted?: boolean },
  ): Promise<ServiceResult<{ items: unknown[]; next_cursor: string | null }>> {
    const space = await this.deps.spaces.get(scope, spaceId);
    if (!space) {
      return { ok: false, code: "NOT_FOUND", message: "space not found" };
    }
    const result = await this.deps.documents.listBySpace(scope, spaceId, input);
    return {
      ok: true,
      data: {
        items: result.items.map((doc) => ({
          document_id: doc.documentId,
          space_id: doc.spaceId,
          title: doc.title,
          document_type: doc.documentType ?? null,
          status: doc.status,
          visibility_status: doc.visibilityStatus,
          current_version_id: doc.currentVersionId ?? null,
          current_version_number: doc.currentVersionNumber ?? null,
          source_filename: doc.sourceFilename ?? null,
          source_sha256: doc.sourceSha256 ?? null,
          created_by: doc.createdBy,
          created_at: doc.createdAt.toISOString(),
          updated_at: doc.updatedAt.toISOString(),
        })),
        next_cursor: result.nextCursor,
      },
    };
  }
}
