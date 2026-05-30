import { createOpaqueId, type KnowledgeErrorCode } from "@octopus/knowledge-contracts";
import type { KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import type { KnowledgeChunkStore } from "../repositories/chunk-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { KnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import type { KnowledgeJobStore } from "../repositories/job-store.js";
import type { KnowledgeSpaceStore } from "../repositories/space-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import { NoopKnowledgeUnitOfWork, type KnowledgeUnitOfWork } from "../repositories/unit-of-work.js";
import type { QdrantAdapter } from "../vector/qdrant-adapter.js";

export type ReindexServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: KnowledgeErrorCode; message: string };

export type StartReindexOutput = {
  document_id: string;
  job_id: string;
  new_version_id: string;
  new_version_number: number;
  status: "queued";
};

export type PromoteReindexOutput = {
  document_id: string;
  version_id: string;
  promoted_chunks: number;
  demoted_chunks: number;
};

export type RollbackReindexOutput = {
  document_id: string;
  version_id: string;
  rolled_back_chunks: number;
};

export class KnowledgeReindexService {
  constructor(private readonly deps: {
    documents: KnowledgeDocumentStore;
    versions: KnowledgeDocumentVersionStore;
    jobs: KnowledgeJobStore;
    chunks: KnowledgeChunkStore;
    audit: KnowledgeAuditEventWriter;
    vector: QdrantAdapter;
    spaces: KnowledgeSpaceStore;
    unitOfWork?: KnowledgeUnitOfWork;
  }) {}

  async startReindex(
    scope: TenantScope,
    documentId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<ReindexServiceResult<StartReindexOutput>> {
    const document = await this.deps.documents.get(scope, documentId);
    if (!document || document.status === "deleted") {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    if (!document.currentVersionId || !document.currentVersionNumber || !document.sourceSha256) {
      return { ok: false, code: "BAD_REQUEST", message: "document has no parsed source yet" };
    }
    const currentVersion = await this.deps.versions.get(scope, document.currentVersionId);
    if (!currentVersion) {
      return { ok: false, code: "BAD_REQUEST", message: "document has no parsed source yet" };
    }
    const originalJob = await this.deps.jobs.findLatestForDocument(scope, documentId, "ingest");
    const originalPayload = (originalJob?.payload ?? {}) as { object_uri?: string };
    const objectUri = originalPayload.object_uri ?? null;
    if (!objectUri) {
      return { ok: false, code: "BAD_REQUEST", message: "document has no parsed source yet" };
    }

    const unitOfWork = this.deps.unitOfWork ?? new NoopKnowledgeUnitOfWork();
    return unitOfWork.run(async () => {
      const newVersionId = createOpaqueId("ver");
      const newVersionNumber = document.currentVersionNumber! + 1;
      const jobId = createOpaqueId("job");

      await this.deps.versions.create({
        ...scope,
        versionId: newVersionId,
        documentId,
        versionNumber: newVersionNumber,
        status: "queued",
        contentSha256: document.sourceSha256!,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      await this.deps.jobs.add({
        ...scope,
        jobId,
        type: "ingest",
        status: "queued",
        priority: 100,
        spaceId: document.spaceId,
        documentId,
        payload: {
          version_id: newVersionId,
          space_id: document.spaceId,
          object_uri: objectUri,
          source_sha256: document.sourceSha256,
          source_filename: document.sourceFilename ?? null,
          source_type: "reindex",
          reindex_mode: "shadow",
        },
        attempt: 0,
        maxRetries: 3,
        runAfterAt: now,
      });

      await this.deps.audit.write({
        ...scope,
        userId,
        action: "reindex.start",
        resourceType: "document",
        resourceId: documentId,
        details: { job_id: jobId, new_version_id: newVersionId, new_version_number: newVersionNumber },
        createdAt: now,
      });

      return {
        ok: true,
        data: {
          document_id: documentId,
          job_id: jobId,
          new_version_id: newVersionId,
          new_version_number: newVersionNumber,
          status: "queued" as const,
        },
      };
    });
  }

  async promote(
    scope: TenantScope,
    documentId: string,
    newVersionId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<ReindexServiceResult<PromoteReindexOutput>> {
    const document = await this.deps.documents.get(scope, documentId);
    if (!document || document.status === "deleted") {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    const newVersion = await this.deps.versions.get(scope, newVersionId);
    if (!newVersion || newVersion.documentId !== documentId) {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    const oldVersionId = document.currentVersionId ?? null;

    const unitOfWork = this.deps.unitOfWork ?? new NoopKnowledgeUnitOfWork();
    return unitOfWork.run(async () => {
      const promoted = await this.deps.chunks.promoteShadow(scope, newVersionId, now);
      // Flip Qdrant payload status=shadow → active for the new version so the
      // search filter (status=active) starts surfacing the freshly indexed
      // vectors. Without this the chunk store flips but Qdrant still answers
      // with the old version's points.
      await this.deps.vector.setPayloadByFilter(
        { status: "active" },
        {
          must: [
            { key: "tenant_id", match: { value: scope.tenantId } },
            { key: "source_system_id", match: { value: scope.sourceSystemId } },
            { key: "document_version_id", match: { value: newVersionId } },
          ],
        },
      );
      let demoted = 0;
      if (oldVersionId && oldVersionId !== newVersionId) {
        demoted = await this.deps.chunks.markDeletedForVersion(scope, oldVersionId, now);
        // Hard-delete old vectors from qdrant; chunk store retains them with
        // status=deleted so a rollback window remains in the relational layer.
        await this.deps.vector.deleteByFilter({
          must: [{ key: "document_version_id", match: { value: oldVersionId } }],
        });
        await this.deps.versions.updateStatus(scope, oldVersionId, "deleted", now);
      }
      await this.deps.documents.updateCurrentVersion(scope, documentId, newVersionId, newVersion.versionNumber, now);
      await this.deps.documents.updateStatus(scope, documentId, "searchable", "visible", now);
      await this.deps.versions.updateStatus(scope, newVersionId, "searchable", now);

      await this.deps.audit.write({
        ...scope,
        userId,
        action: "reindex.promote",
        resourceType: "document",
        resourceId: documentId,
        details: {
          version_id: newVersionId,
          previous_version_id: oldVersionId,
          promoted_chunks: promoted,
          demoted_chunks: demoted,
        },
        createdAt: now,
      });

      return {
        ok: true,
        data: {
          document_id: documentId,
          version_id: newVersionId,
          promoted_chunks: promoted,
          demoted_chunks: demoted,
        },
      };
    });
  }

  async rollback(
    scope: TenantScope,
    documentId: string,
    newVersionId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<ReindexServiceResult<RollbackReindexOutput>> {
    const document = await this.deps.documents.get(scope, documentId);
    if (!document || document.status === "deleted") {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    const newVersion = await this.deps.versions.get(scope, newVersionId);
    if (!newVersion || newVersion.documentId !== documentId) {
      return { ok: false, code: "NOT_FOUND", message: "document not found" };
    }
    if (document.currentVersionId === newVersionId) {
      return { ok: false, code: "BAD_REQUEST", message: "cannot rollback a promoted version" };
    }

    const unitOfWork = this.deps.unitOfWork ?? new NoopKnowledgeUnitOfWork();
    return unitOfWork.run(async () => {
      const rolledBack = await this.deps.chunks.markDeletedForVersion(scope, newVersionId, now);
      await this.deps.vector.deleteByFilter({
        must: [{ key: "document_version_id", match: { value: newVersionId } }],
      });
      await this.deps.versions.updateStatus(scope, newVersionId, "deleted", now);

      await this.deps.audit.write({
        ...scope,
        userId,
        action: "reindex.rollback",
        resourceType: "document",
        resourceId: documentId,
        details: { version_id: newVersionId, rolled_back_chunks: rolledBack },
        createdAt: now,
      });

      return {
        ok: true,
        data: {
          document_id: documentId,
          version_id: newVersionId,
          rolled_back_chunks: rolledBack,
        },
      };
    });
  }

}
