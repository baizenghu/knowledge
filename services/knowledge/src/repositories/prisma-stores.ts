import { createHash } from "node:crypto";
import type { JobStatus } from "@octopus/knowledge-contracts";
import { createIdempotencyKeyHash, createRequestHash, type IdempotencyScope } from "../domain/idempotency.js";
import {
  cancelRunningJob,
  decideFailedJobTransition,
  markJobDegraded,
} from "../domain/jobs.js";
import {
  canonicalizeAcl,
  createAclHash,
  stableJsonStringify,
  type AclListContext,
  type CanonicalAcl,
  type KnowledgeAclPrincipalRecord,
  type KnowledgeAclSnapshotRecord,
  type KnowledgeAclStore,
} from "./acl-store.js";
import type { KnowledgeAnchorRecord, KnowledgeAnchorStore } from "./anchor-store.js";
import type { KnowledgeAssetRecord, KnowledgeAssetStore } from "./asset-store.js";
import type {
  KnowledgeAuditEventInput,
  KnowledgeAuditEventRecord,
  KnowledgeAuditEventWriter,
  ListAuditEventsInput,
} from "./audit-events.js";
import type { ChunkBulkInsert, KnowledgeChunkRecord, KnowledgeChunkStore } from "./chunk-store.js";
import type { KnowledgeDocumentRecord, KnowledgeDocumentStore } from "./document-store.js";
import type { KnowledgeDocumentVersionRecord, KnowledgeDocumentVersionStore } from "./document-version-store.js";
import type { EvalDatasetRecord, EvalSample, KnowledgeEvalDatasetStore } from "./eval-dataset-store.js";
import type {
  EvalRunPatch,
  EvalRunRecord,
  EvalRunMetrics,
  EvalSampleResult,
  KnowledgeEvalRunStore,
} from "./eval-run-store.js";
import type { IdempotencyRecord, IdempotencyReservation, KnowledgeIdempotencyStore } from "./idempotency-store.js";
import { sanitizeJobErrorMessage, type ClaimJobOptions, type JobFailureInput, type KnowledgeJobRecord, type KnowledgeJobStore } from "./job-store.js";
import {
  cleanupFieldsFor,
  type KnowledgeSpaceRecord,
  type KnowledgeSpaceStore,
  type ListDeletedInput,
  type ListSpacesInput,
  type SetCleanupStatusInput,
} from "./space-store.js";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";
import type { KnowledgeUnitOfWork } from "./unit-of-work.js";
import type { KnowledgeUploadSessionRecord, KnowledgeUploadSessionStore } from "./upload-session-store.js";
import type { JobsHub } from "../services/JobsHub.js";

type PrismaLike = {
  $transaction?: <T>(operation: (tx: PrismaLike) => Promise<T>) => Promise<T>;
  knowledgeDocument: any;
  knowledgeDocumentVersion: any;
  knowledgeJob: any;
  knowledgeIdempotencyKey: any;
  knowledgeAuditEvent: any;
  knowledgeSpace: any;
  knowledgeUploadSession: any;
  knowledgeAclSnapshot: any;
  knowledgeAclPrincipal: any;
  knowledgeAsset: any;
  knowledgeChunk: any;
  knowledgeCitationAnchor: any;
  knowledgeEvaluationDataset: any;
  knowledgeEvaluationRun: any;
};

export class PrismaKnowledgeUnitOfWork implements KnowledgeUnitOfWork {
  constructor(private readonly prisma: PrismaLike) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.prisma.$transaction) {
      return operation();
    }
    return this.prisma.$transaction(async () => operation());
  }
}

export class PrismaKnowledgeDocumentStore implements KnowledgeDocumentStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(document: KnowledgeDocumentRecord): Promise<KnowledgeDocumentRecord> {
    const record = await this.prisma.knowledgeDocument.create({
      data: {
        sourceSystemId: document.sourceSystemId,
        tenantId: document.tenantId,
        documentId: document.documentId,
        spaceId: document.spaceId,
        title: document.title,
        documentType: document.documentType,
        status: document.status,
        visibilityStatus: document.visibilityStatus,
        currentVersionId: document.currentVersionId,
        currentVersionNumber: document.currentVersionNumber,
        aclHash: document.aclHash,
        aclVersion: document.aclVersion,
        sourceSha256: document.sourceSha256,
        sourceFilename: document.sourceFilename,
        createdBy: document.createdBy,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
    });
    return mapDocument(record);
  }

  async get(scope: TenantScope, documentId: string): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeDocument.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId },
    });
    return record ? mapDocument(record) : null;
  }

  async findBySourceSha256(scope: TenantScope, spaceId: string, sourceSha256: string): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeDocument.findFirst({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
        sourceSha256: sourceSha256.toLowerCase(),
        deletedAt: null,
        status: { not: "deleted" },
      },
      orderBy: { createdAt: "asc" },
    });
    return record ? mapDocument(record) : null;
  }

  async updateAcl(scope: TenantScope, documentId: string, aclHash: string, aclVersion: number, now = new Date()): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    await this.prisma.knowledgeDocument.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, deletedAt: null },
      data: { aclHash, aclVersion, updatedAt: now },
    });
    return this.get(safeScope, documentId);
  }

  async updateStatus(scope: TenantScope, documentId: string, status: KnowledgeDocumentRecord["status"], visibilityStatus?: KnowledgeDocumentRecord["visibilityStatus"], now = new Date()): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeDocument.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, status: { not: "deleted" } },
      data: { status, ...(visibilityStatus ? { visibilityStatus } : {}), updatedAt: now },
    });
    return updated.count === 1 ? this.get(safeScope, documentId) : null;
  }

  async softDelete(scope: TenantScope, documentId: string, now = new Date(), tx?: unknown): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const updated = await client.knowledgeDocument.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, deletedAt: null },
      data: { status: "deleted", visibilityStatus: "deleted", deletedAt: now, updatedAt: now },
    });
    return updated.count > 0 ? this.get(safeScope, documentId) : null;
  }

  async softDeleteBySpace(scope: TenantScope, spaceId: string, now: Date = new Date(), tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeDocument.updateMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
        status: { not: "deleted" },
      },
      data: { status: "deleted", visibilityStatus: "deleted", deletedAt: now, updatedAt: now },
    });
    return result.count;
  }

  async restoreBySpace(scope: TenantScope, spaceId: string, now: Date = new Date(), tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeDocument.updateMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
        status: "deleted",
      },
      data: { status: "searchable", visibilityStatus: "visible", deletedAt: null, updatedAt: now },
    });
    return result.count;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeDocument.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
      },
    });
    return result.count;
  }

  async updateCurrentVersion(scope: TenantScope, documentId: string, versionId: string, versionNumber: number, now = new Date()): Promise<KnowledgeDocumentRecord | null> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeDocument.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, status: { not: "deleted" } },
      data: { currentVersionId: versionId, currentVersionNumber: versionNumber, updatedAt: now },
    });
    return updated.count === 1 ? this.get(safeScope, documentId) : null;
  }

  async isVisible(scope: TenantScope, documentId: string): Promise<boolean> {
    const safeScope = requireTenantScope(scope);
    const count = await this.prisma.knowledgeDocument.count({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, visibilityStatus: "visible", deletedAt: null, status: { not: "deleted" } },
    });
    return count > 0;
  }

  async listBySpace(
    scope: TenantScope,
    spaceId: string,
    input: { limit?: number; cursor?: string | null; includeDeleted?: boolean } = {},
  ): Promise<{ items: KnowledgeDocumentRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = !input.limit || input.limit <= 0 ? 50 : Math.min(200, Math.floor(input.limit));
    const includeDeleted = input.includeDeleted === true;
    const where: Record<string, unknown> = {
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      spaceId,
    };
    if (!includeDeleted) {
      where.deletedAt = null;
      where.status = { not: "deleted" };
    }
    if (input.cursor) {
      where.documentId = { gt: input.cursor };
    }
    const records = await this.prisma.knowledgeDocument.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { documentId: "asc" }],
      take: limit + 1,
    });
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    const nextCursor = hasMore ? page[page.length - 1].documentId : null;
    return { items: page.map(mapDocument), nextCursor };
  }
}

export class PrismaKnowledgeDocumentVersionStore implements KnowledgeDocumentVersionStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(version: KnowledgeDocumentVersionRecord): Promise<KnowledgeDocumentVersionRecord> {
    const record = await this.prisma.knowledgeDocumentVersion.create({ data: version });
    return mapVersion(record);
  }

  async get(scope: TenantScope, versionId: string): Promise<KnowledgeDocumentVersionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeDocumentVersion.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, versionId },
    });
    return record ? mapVersion(record) : null;
  }

  async updateStatus(scope: TenantScope, versionId: string, status: KnowledgeDocumentVersionRecord["status"], now = new Date()): Promise<KnowledgeDocumentVersionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeDocumentVersion.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, versionId },
      data: { status, updatedAt: now },
    });
    if (updated.count !== 1) {
      return null;
    }
    return this.get(safeScope, versionId);
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    // version 表无 spaceId 字段，按 documentId IN (space 下所有文档) 过滤。
    const docs = await client.knowledgeDocument.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
      select: { documentId: true },
    });
    if (docs.length === 0) return 0;
    const result = await client.knowledgeDocumentVersion.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        documentId: { in: docs.map((d: { documentId: string }) => d.documentId) },
      },
    });
    return result.count;
  }
}

export class PrismaKnowledgeJobStore implements KnowledgeJobStore {
  constructor(private readonly prisma: PrismaLike, private readonly hub?: JobsHub) {}

  async add(job: KnowledgeJobRecord): Promise<KnowledgeJobRecord> {
    const record = await this.prisma.knowledgeJob.create({ data: job });
    return mapJob(record);
  }

  async get(scope: TenantScope, jobId: string): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeJob.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, jobId },
    });
    return record ? mapJob(record) : null;
  }

  async claimNext(scope: TenantScope, options: ClaimJobOptions): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const now = options.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (options.leaseTimeoutMs ?? 5 * 60_000));
    const claim = async (tx: PrismaLike): Promise<KnowledgeJobRecord | null> => {
      const candidate = await tx.knowledgeJob.findFirst({
        where: {
          sourceSystemId: safeScope.sourceSystemId,
          tenantId: safeScope.tenantId,
          runAfterAt: { lte: now },
          OR: [
            { status: "queued" },
            { status: "running", lockedAt: { lt: staleBefore } },
          ],
        },
        orderBy: [{ priority: "desc" }, { runAfterAt: "asc" }, { jobId: "asc" }],
      });
      if (!candidate) {
        return null;
      }
      const updated = await tx.knowledgeJob.updateMany({
        where: {
          sourceSystemId: safeScope.sourceSystemId,
          tenantId: safeScope.tenantId,
          jobId: candidate.jobId,
          OR: [
            { status: "queued" },
            { status: "running", lockedAt: { lt: staleBefore } },
          ],
        },
        data: { status: "running", lockedBy: options.workerId, lockedAt: now, startedAt: candidate.startedAt ?? now },
      });
      if (updated.count !== 1) {
        return null;
      }
      return this.get(safeScope, candidate.jobId);
    };
    const record = await (this.prisma.$transaction ? this.prisma.$transaction(claim) : claim(this.prisma));
    if (record) this.hub?.emitStatus(record.jobId);
    return record;
  }

  async claimNextAny(options: ClaimJobOptions): Promise<KnowledgeJobRecord | null> {
    const now = options.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (options.leaseTimeoutMs ?? 5 * 60_000));
    const claim = async (tx: PrismaLike): Promise<KnowledgeJobRecord | null> => {
      const candidate = await tx.knowledgeJob.findFirst({
        where: {
          runAfterAt: { lte: now },
          OR: [
            { status: "queued" },
            { status: "running", lockedAt: { lt: staleBefore } },
          ],
        },
        orderBy: [{ priority: "desc" }, { runAfterAt: "asc" }, { jobId: "asc" }],
      });
      if (!candidate) {
        return null;
      }
      const updated = await tx.knowledgeJob.updateMany({
        where: {
          sourceSystemId: candidate.sourceSystemId,
          tenantId: candidate.tenantId,
          jobId: candidate.jobId,
          OR: [
            { status: "queued" },
            { status: "running", lockedAt: { lt: staleBefore } },
          ],
        },
        data: { status: "running", lockedBy: options.workerId, lockedAt: now, startedAt: candidate.startedAt ?? now },
      });
      if (updated.count !== 1) {
        return null;
      }
      return this.get({ sourceSystemId: candidate.sourceSystemId, tenantId: candidate.tenantId }, candidate.jobId);
    };
    const record = await (this.prisma.$transaction ? this.prisma.$transaction(claim) : claim(this.prisma));
    if (record) this.hub?.emitStatus(record.jobId);
    return record;
  }

  async heartbeat(scope: TenantScope, jobId: string, workerId: string, now = new Date()): Promise<boolean> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeJob.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, jobId, status: "running", lockedBy: workerId },
      data: { lockedAt: now },
    });
    return updated.count === 1;
  }

  async complete(scope: TenantScope, jobId: string, workerId: string, now = new Date()): Promise<boolean> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeJob.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, jobId, status: "running", lockedBy: workerId },
      data: { status: "succeeded", finishedAt: now, lockedBy: null, lockedAt: null },
    });
    const ok = updated.count === 1;
    if (ok) this.hub?.emitStatus(jobId);
    return ok;
  }

  async fail(scope: TenantScope, jobId: string, workerId: string, input: JobFailureInput): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const job = await this.get(safeScope, jobId);
    if (!job || job.status !== "running" || job.lockedBy !== workerId) {
      return null;
    }
    const now = input.now ?? new Date();
    const decision = decideFailedJobTransition(job, now, input.retryDelayMs);
    await this.prisma.knowledgeJob.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, jobId, status: "running", lockedBy: workerId },
      data: {
        status: decision.nextStatus,
        attempt: decision.nextAttempt,
        errorCode: input.errorCode,
        errorMessage: sanitizeJobErrorMessage(input.errorMessage),
        lockedBy: null,
        lockedAt: null,
        runAfterAt: decision.runAfterAt,
        deadLetterAt: decision.deadLetterAt,
        finishedAt: decision.nextStatus === "queued" ? null : now,
      },
    });
    const record = await this.get(safeScope, jobId);
    if (record) this.hub?.emitStatus(jobId);
    return record;
  }

  async markDegraded(scope: TenantScope, jobId: string, workerId: string, reason: string, now = new Date()): Promise<boolean> {
    const safeScope = requireTenantScope(scope);
    const decision = markJobDegraded(reason, now);
    const updated = await this.prisma.knowledgeJob.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, jobId, status: "running", lockedBy: workerId },
      data: { status: decision.nextStatus, degradedReason: decision.degradedReason, finishedAt: decision.finishedAt, lockedBy: null, lockedAt: null },
    });
    const ok = updated.count === 1;
    if (ok) this.hub?.emitStatus(jobId);
    return ok;
  }

  async cancelDocumentJobs(scope: TenantScope, documentId: string, reason: string, now = new Date(), tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const decision = cancelRunningJob(now);
    const where = { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, status: { in: ["queued", "running"] } };
    // 先捞被取消的 jobId(updateMany 拿不到 id),再批量改,最后逐条 emit ping。
    const targets = await client.knowledgeJob.findMany({ where, select: { jobId: true } });
    const result = await client.knowledgeJob.updateMany({
      where,
      data: { status: decision.nextStatus, finishedAt: decision.finishedAt, errorCode: "JOB_CANCELLED", errorMessage: sanitizeJobErrorMessage(reason), lockedBy: null, lockedAt: null },
    });
    for (const t of targets as Array<{ jobId: string }>) this.hub?.emitStatus(t.jobId);
    return result.count;
  }

  async cancelBySpace(scope: TenantScope, spaceId: string, reason: string, now: Date = new Date(), tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    // 非终态: queued | running | degraded
    // 终态: succeeded | failed | dead_lettered | cancelled
    const where = {
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      spaceId,
      status: { in: ["queued", "running", "degraded"] },
    };
    // 先捞被取消的 jobId(updateMany 拿不到 id),再批量改,最后逐条 emit ping。
    const targets = await client.knowledgeJob.findMany({ where, select: { jobId: true } });
    const result = await client.knowledgeJob.updateMany({
      where,
      data: {
        status: "cancelled",
        errorMessage: sanitizeJobErrorMessage(reason),
        finishedAt: now,
        lockedBy: null,
        lockedAt: null,
      },
    });
    for (const t of targets as Array<{ jobId: string }>) this.hub?.emitStatus(t.jobId);
    return result.count;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeJob.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
      },
    });
    return result.count;
  }

  async findLatestForDocument(scope: TenantScope, documentId: string, type: string): Promise<KnowledgeJobRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeJob.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, type },
      orderBy: { runAfterAt: "desc" },
    });
    return record ? mapJob(record) : null;
  }
}

export class PrismaKnowledgeIdempotencyStore implements KnowledgeIdempotencyStore {
  constructor(private readonly prisma: PrismaLike) {}

  async begin<T>(scope: IdempotencyScope, rawKey: string, method: string, path: string, body: unknown, expiresAt: Date, now = new Date()): Promise<IdempotencyReservation<T>> {
    const safeScope = requireTenantScope(scope);
    const keyHash = createIdempotencyKeyHash(safeScope, rawKey);
    const requestHash = createRequestHash(method, path, body);
    try {
      const record = await this.prisma.knowledgeIdempotencyKey.create({
        data: { ...safeScope, keyHash, rawKey: rawKey.trim(), requestHash, method: method.trim().toUpperCase(), path, expiresAt, createdAt: now, updatedAt: now },
      });
      return { status: "started", record: mapIdempotency(record) as IdempotencyRecord<T> };
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.prisma.knowledgeIdempotencyKey.findFirst({
        where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, keyHash, expiresAt: { gt: now } },
      });
      if (!existing) {
        throw error;
      }
      if (existing.requestHash !== requestHash) {
        return { status: "conflict", record: mapIdempotency(existing) as IdempotencyRecord<T> };
      }
      return { status: "replayed", record: mapIdempotency(existing) as IdempotencyRecord<T> };
    }
  }

  async complete<T>(scope: IdempotencyScope, rawKey: string, responseJson: T, resourceType?: string, resourceId?: string, now = new Date()): Promise<IdempotencyRecord<T>> {
    const safeScope = requireTenantScope(scope);
    const keyHash = createIdempotencyKeyHash(safeScope, rawKey);
    const updated = await this.prisma.knowledgeIdempotencyKey.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, keyHash },
      data: { responseJson, resourceType, resourceId, updatedAt: now },
    });
    if (updated.count !== 1) {
      throw new Error("idempotency record not found");
    }
    const record = await this.prisma.knowledgeIdempotencyKey.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, keyHash },
    });
    if (!record) {
      throw new Error("idempotency record not found");
    }
    return mapIdempotency(record) as IdempotencyRecord<T>;
  }
}

export class PrismaKnowledgeAuditEventWriter implements KnowledgeAuditEventWriter {
  constructor(private readonly prisma: PrismaLike) {}

  async write(event: KnowledgeAuditEventInput): Promise<void> {
    requireTenantScope(event);
    await this.prisma.knowledgeAuditEvent.create({
      data: { ...event, success: event.success ?? true, createdAt: event.createdAt ?? new Date() },
    });
  }

  async writeMany(events: KnowledgeAuditEventInput[]): Promise<void> {
    await this.prisma.knowledgeAuditEvent.createMany({
      data: events.map((event) => ({ ...event, success: event.success ?? true, createdAt: event.createdAt ?? new Date() })),
    });
  }

  async list(
    scope: TenantScope,
    input: ListAuditEventsInput = {},
  ): Promise<{ items: KnowledgeAuditEventRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where: Record<string, unknown> = {
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
    };
    if (input.actions && input.actions.length > 0) where["action"] = { in: input.actions };
    if (input.resourceType) where["resourceType"] = input.resourceType;
    if (input.resourceId) where["resourceId"] = input.resourceId;
    const cursor = parseAuditCursor(input.cursor);
    if (cursor) {
      where["OR"] = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, eventId: { lt: cursor.eventId } },
      ];
    }
    const rows = await this.prisma.knowledgeAuditEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { eventId: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows) as KnowledgeAuditEventRecord[];
    const nextCursor =
      hasMore && page.length > 0
        ? formatAuditCursor(page[page.length - 1] as unknown as { createdAt: Date; eventId?: bigint | number | string })
        : null;
    return { items: page.map((r) => ({ ...r })), nextCursor };
  }
}

function parseAuditCursor(cursor: string | null | undefined): { createdAt: Date; eventId: bigint } | null {
  if (!cursor) return null;
  const [msRaw, eventIdRaw] = cursor.split(":");
  const ms = Number(msRaw);
  if (!Number.isFinite(ms)) return null;
  try {
    return { createdAt: new Date(ms), eventId: eventIdRaw ? BigInt(eventIdRaw) : 0n };
  } catch {
    return null;
  }
}

function formatAuditCursor(row: { createdAt: Date; eventId?: bigint | number | string }): string {
  return `${row.createdAt.getTime()}:${String(row.eventId ?? 0)}`;
}

export class PrismaKnowledgeSpaceStore implements KnowledgeSpaceStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(space: KnowledgeSpaceRecord): Promise<KnowledgeSpaceRecord> {
    const record = await this.prisma.knowledgeSpace.create({ data: space });
    return mapSpace(record);
  }

  async get(scope: TenantScope, spaceId: string): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeSpace.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId, deletedAt: null },
    });
    return record ? mapSpace(record) : null;
  }

  async list(scope: TenantScope, input: ListSpacesInput = {}): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const items = await this.prisma.knowledgeSpace.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        deletedAt: null,
        ...(input.type ? { type: input.type } : {}),
        ...(input.cursor ? { spaceId: { gt: input.cursor } } : {}),
      },
      orderBy: { spaceId: "asc" },
      take: limit + 1,
    });
    const page = items.slice(0, limit).map(mapSpace);
    return { items: page, nextCursor: items.length > limit ? page.at(-1)?.spaceId ?? null : null };
  }

  async softDelete(scope: TenantScope, spaceId: string, userId: string, now: Date = new Date(), tx?: unknown): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    await client.knowledgeSpace.updateMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
        deletedAt: null,
      },
      data: {
        status: "deleted",
        deletedAt: now,
        updatedBy: userId,
        updatedAt: now,
      },
    });
    // 已软删,公开 get() 会过滤;fallback 用 includeDeleted 拿最新
    return this.getIncludeDeleted(safeScope, spaceId, tx);
  }

  async getIncludeDeleted(scope: TenantScope, spaceId: string, tx?: unknown): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const record = await client.knowledgeSpace.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
    });
    return record ? mapSpace(record) : null;
  }

  async listDeleted(scope: TenantScope, input: ListDeletedInput = {}, tx?: unknown): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const where: Record<string, unknown> = {
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      deletedAt: { not: null },
    };
    applyPendingTargetFilter(where, input);
    // cursor 与 orderBy 必须严格一致才能稳定翻页：仅按 spaceId asc 排序 + cursor。
    // UI 端如需按 deletedAt 展示，调用方再做本地排序（admin 回收站每页 ≤100 行成本可忽略）。
    if (input.cursor) {
      where.spaceId = { gt: input.cursor };
    }
    const items = await client.knowledgeSpace.findMany({
      where,
      orderBy: { spaceId: "asc" },
      take: limit + 1,
    });
    const hasMore = items.length > limit;
    const page = (hasMore ? items.slice(0, limit) : items).map(mapSpace);
    const nextCursor = hasMore ? page[page.length - 1]?.spaceId ?? null : null;
    return { items: page, nextCursor };
  }

  async listDeletedAcrossTenants(input: ListDeletedInput = {}, tx?: unknown): Promise<{ items: KnowledgeSpaceRecord[]; nextCursor: string | null }> {
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const where: Record<string, unknown> = { deletedAt: { not: null } };
    applyPendingTargetFilter(where, input);
    if (input.cursor) {
      where.spaceId = { gt: input.cursor };
    }
    const items = await client.knowledgeSpace.findMany({
      where,
      orderBy: { spaceId: "asc" },
      take: limit + 1,
    });
    const hasMore = items.length > limit;
    const page = (hasMore ? items.slice(0, limit) : items).map(mapSpace);
    const nextCursor = hasMore ? page[page.length - 1]?.spaceId ?? null : null;
    return { items: page, nextCursor };
  }

  async hardDelete(scope: TenantScope, spaceId: string, tx?: unknown): Promise<boolean> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeSpace.deleteMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
    });
    return result.count > 0;
  }

  async restoreSpace(
    scope: TenantScope,
    spaceId: string,
    userId: string,
    now: Date = new Date(),
    tx?: unknown,
  ): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeSpace.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
      data: {
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
      },
    });
    if (result.count === 0) return null;
    return this.getIncludeDeleted(safeScope, spaceId, tx);
  }

  async setCleanupStatus(scope: TenantScope, spaceId: string, input: SetCleanupStatusInput, tx?: unknown): Promise<KnowledgeSpaceRecord | null> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const now = input.now ?? new Date();
    const f = cleanupFieldsFor(input.target);
    // 写 target 自己的 4 个独立字段（status / errorCode / errorMessage / nextRunAt / attempts）。
    // cleanupLastAttemptAt 三 target 共用，记录最近一次活动时间。
    const data: Record<string, unknown> = {
      [f.statusField]: input.status,
      cleanupLastAttemptAt: now,
      updatedAt: now,
    };
    if (input.errorCode !== undefined) data[f.errorCodeField] = input.errorCode;
    if (input.errorMessage !== undefined) data[f.errorMessageField] = input.errorMessage;
    if (input.nextRunAt !== undefined) data[f.nextRunAtField] = input.nextRunAt;
    if (input.incrementAttempts) data[f.attemptsField] = { increment: 1 };
    await client.knowledgeSpace.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
      data,
    });
    return this.getIncludeDeleted(safeScope, spaceId, tx);
  }
}

export class PrismaKnowledgeUploadSessionStore implements KnowledgeUploadSessionStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(session: KnowledgeUploadSessionRecord): Promise<KnowledgeUploadSessionRecord> {
    const record = await this.prisma.knowledgeUploadSession.create({ data: session });
    return mapUpload(record);
  }

  async get(scope: TenantScope, uploadId: string): Promise<KnowledgeUploadSessionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeUploadSession.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, uploadId },
    });
    return record ? mapUpload(record) : null;
  }

  async getByObjectUri(scope: TenantScope, objectUri: string): Promise<KnowledgeUploadSessionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeUploadSession.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, objectUri },
    });
    return record ? mapUpload(record) : null;
  }

  async consume(scope: TenantScope, uploadId: string, actualSha256: string, now = new Date()): Promise<KnowledgeUploadSessionRecord | null> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeUploadSession.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, uploadId, status: "issued", expiresAt: { gt: now } },
      data: { status: "consumed", actualSha256, consumedAt: now, updatedAt: now },
    });
    return updated.count === 1 ? this.get(safeScope, uploadId) : null;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeUploadSession.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
      },
    });
    return result.count;
  }
}

export class PrismaKnowledgeAclStore implements KnowledgeAclStore {
  constructor(private readonly prisma: PrismaLike) {}

  async upsertSnapshot(scope: TenantScope, acl: unknown, effectiveFrom: Date | null = null, effectiveTo: Date | null = null, now = new Date()): Promise<KnowledgeAclSnapshotRecord> {
    const safeScope = requireTenantScope(scope);
    const canonicalAcl = canonicalizeAcl(safeScope, acl, effectiveFrom, effectiveTo);
    const canonicalJson = stableJsonStringify(canonicalAcl);
    const sha256 = createHash("sha256").update(canonicalJson).digest("hex");
    const aclHash = createAclHash(safeScope, canonicalJson);
    const record = await this.prisma.knowledgeAclSnapshot.upsert({
      where: { sourceSystemId_tenantId_aclHash: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, aclHash } },
      create: { ...safeScope, aclHash, canonicalJson: canonicalAcl, sha256, createdAt: now },
      update: {},
    });
    return mapAclSnapshot(record);
  }

  async replaceDocumentPrincipals(input: {
    scope: TenantScope;
    documentId: string;
    aclHash: string;
    aclVersion: number;
    canonicalAcl: CanonicalAcl;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
    now?: Date;
  }): Promise<KnowledgeAclPrincipalRecord[]> {
    const safeScope = requireTenantScope(input.scope);
    await this.prisma.knowledgeAclPrincipal.deleteMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId: input.documentId },
    });
    const records = (["read", "write", "admin"] as const).flatMap((permission) =>
      input.canonicalAcl[permission].map((principal) => ({
        ...safeScope,
        documentId: input.documentId,
        aclHash: input.aclHash,
        aclVersion: input.aclVersion,
        permission,
        principalType: principal.type,
        principalId: principal.id,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        createdAt: input.now ?? new Date(),
      })),
    );
    if (records.length > 0) {
      await this.prisma.knowledgeAclPrincipal.createMany({ data: records });
    }
    return records.map(mapAclPrincipal);
  }

  async listDocumentPrincipals(scope: TenantScope, documentId: string, aclVersion?: number): Promise<KnowledgeAclPrincipalRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeAclPrincipal.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, documentId, ...(aclVersion === undefined ? {} : { aclVersion }) },
    });
    return records.map(mapAclPrincipal);
  }

  async listAclHashesForContext(scope: TenantScope, context: AclListContext, now?: Date): Promise<Set<string>> {
    const safeScope = requireTenantScope(scope);
    const nowDate = now ?? new Date();
    // SELECT DISTINCT acl_hash FROM knowledge_acl_principals
    // WHERE source_system_id, tenant_id 匹配 + permission='read'
    //   AND (effective_from IS NULL OR <= now) AND (effective_to IS NULL OR > now)
    //   AND principal 匹配 (tenant/user/department/role) 四类之一。
    const principalConds: Array<Record<string, unknown>> = [
      { principalType: "tenant", principalId: context.tenantId },
      { principalType: "user", principalId: context.userId },
    ];
    if (context.departments?.length) {
      principalConds.push({ principalType: "department", principalId: { in: context.departments } });
    }
    if (context.roles?.length) {
      principalConds.push({ principalType: "role", principalId: { in: context.roles } });
    }
    const rows = await this.prisma.knowledgeAclPrincipal.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        permission: "read",
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: nowDate } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: nowDate } }] },
          { OR: principalConds },
        ],
      },
      select: { aclHash: true },
      distinct: ["aclHash"],
    });
    return new Set(rows.map((r: { aclHash: string }) => r.aclHash));
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    // acl_principal 表无 spaceId 字段，按 documentId IN (space 下所有文档) 过滤。
    const docs = await client.knowledgeDocument.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
      select: { documentId: true },
    });
    if (docs.length === 0) return 0;
    const result = await client.knowledgeAclPrincipal.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        documentId: { in: docs.map((d: { documentId: string }) => d.documentId) },
      },
    });
    return result.count;
  }
}

function mapDocument(record: any): KnowledgeDocumentRecord {
  return { ...record };
}

function mapVersion(record: any): KnowledgeDocumentVersionRecord {
  return { ...record };
}

function mapJob(record: any): KnowledgeJobRecord {
  return { ...record, status: record.status as JobStatus };
}

function mapIdempotency(record: any): IdempotencyRecord {
  return { ...record };
}

/**
 * 把 ListDeletedInput 的 pendingTarget / pendingTargetStatuses / dueAt
 * 翻译成 Prisma where 条件,把"到期且非终态"过滤下推到 DB,避免 GC worker 第一页饥饿。
 *
 * - pendingTargetStatuses 缺省 → status != 'ok'(含 failed,admin 维护页用)
 * - pendingTargetStatuses 给定 → status IN (...)
 * - dueAt 给定 → next_run_at <= dueAt OR next_run_at IS NULL
 */
function applyPendingTargetFilter(where: Record<string, unknown>, input: ListDeletedInput): void {
  if (!input.pendingTarget) return;
  const { statusField, nextRunAtField } = cleanupFieldsFor(input.pendingTarget);
  if (input.pendingTargetStatuses && input.pendingTargetStatuses.length > 0) {
    where[statusField] = { in: input.pendingTargetStatuses };
  } else {
    where[statusField] = { not: "ok" };
  }
  if (input.dueAt) {
    where["OR"] = [
      { [nextRunAtField]: null },
      { [nextRunAtField]: { lte: input.dueAt } },
    ];
  }
}

function mapSpace(record: any): KnowledgeSpaceRecord {
  return { ...record };
}

function mapUpload(record: any): KnowledgeUploadSessionRecord {
  return { ...record, sizeBytes: Number(record.sizeBytes) };
}

function mapAclSnapshot(record: any): KnowledgeAclSnapshotRecord {
  return { ...record };
}

function mapAclPrincipal(record: any): KnowledgeAclPrincipalRecord {
  return { ...record };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

// ---------------------------------------------------------------------------
// M3+ artefacts: assets / chunks / anchors / eval datasets / eval runs.
// These were initially in-memory only; landing the Prisma implementations is
// what makes the service survive a restart with persisted parsed-content,
// retrieval index metadata, citation anchors and evaluation history.

export class PrismaKnowledgeAssetStore implements KnowledgeAssetStore {
  constructor(private readonly prisma: PrismaLike) {}

  async upsert(asset: KnowledgeAssetRecord): Promise<KnowledgeAssetRecord> {
    const safeScope = requireTenantScope(asset);
    const data = {
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      assetId: asset.assetId,
      documentId: asset.documentId,
      versionId: asset.versionId,
      type: asset.type,
      uri: asset.uri,
      sha256: asset.sha256,
      mimeType: asset.mimeType ?? null,
      sizeBytes: asset.sizeBytes ?? null,
      pageNo: asset.pageNo ?? null,
      bbox: asset.bbox ?? null,
      metadata: asset.metadata ?? null,
      createdAt: asset.createdAt,
      deletedAt: asset.deletedAt ?? null,
    };
    // 去重键是「版本内的内容标识」(versionId, sha256, type)，不是随机的 assetId
    // ——否则 ingest 重试时 assetId 重新随机生成、撞 (versionId, sha256, type) 唯一约束 P2002，
    // 导致任何「写过 asset 后才失败」的作业重试必死、进死信。
    // 命中已存行时保留其原 assetId/createdAt（citation anchor 等按 assetId 软引用）。
    const { assetId: _assetId, createdAt: _createdAt, ...mutable } = data;
    const existing = await this.prisma.knowledgeAsset.findFirst({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        versionId: asset.versionId,
        sha256: asset.sha256,
        type: asset.type,
      },
      select: { assetId: true },
    });
    if (existing) {
      const record = await this.prisma.knowledgeAsset.update({
        where: {
          sourceSystemId_tenantId_assetId: {
            sourceSystemId: safeScope.sourceSystemId,
            tenantId: safeScope.tenantId,
            assetId: existing.assetId,
          },
        },
        data: mutable,
      });
      return mapAsset(record);
    }
    try {
      const record = await this.prisma.knowledgeAsset.create({ data });
      return mapAsset(record);
    } catch (error) {
      // 并发兜底：两路同时 create 同内容时，输家退回 update（语义同上）。
      if (!isPrismaUniqueViolation(error)) throw error;
      const winner = await this.prisma.knowledgeAsset.findFirst({
        where: {
          sourceSystemId: safeScope.sourceSystemId,
          tenantId: safeScope.tenantId,
          versionId: asset.versionId,
          sha256: asset.sha256,
          type: asset.type,
        },
        select: { assetId: true },
      });
      if (!winner) throw error;
      const record = await this.prisma.knowledgeAsset.update({
        where: {
          sourceSystemId_tenantId_assetId: {
            sourceSystemId: safeScope.sourceSystemId,
            tenantId: safeScope.tenantId,
            assetId: winner.assetId,
          },
        },
        data: mutable,
      });
      return mapAsset(record);
    }
  }

  async listForVersion(scope: TenantScope, versionId: string): Promise<KnowledgeAssetRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeAsset.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        versionId,
        deletedAt: null,
      },
    });
    return records.map(mapAsset);
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    // asset 表无 spaceId 字段，按 documentId IN (space 下所有文档) 过滤。
    const docs = await client.knowledgeDocument.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
      select: { documentId: true },
    });
    if (docs.length === 0) return 0;
    const result = await client.knowledgeAsset.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        documentId: { in: docs.map((d: { documentId: string }) => d.documentId) },
      },
    });
    return result.count;
  }
}

export class PrismaKnowledgeChunkStore implements KnowledgeChunkStore {
  constructor(private readonly prisma: PrismaLike) {}

  async insertMany(scope: TenantScope, chunks: ChunkBulkInsert[], now = new Date()): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    if (chunks.length === 0) return [];
    const data = chunks.map((chunk) => ({
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      chunkId: chunk.chunkId,
      spaceId: chunk.spaceId,
      documentId: chunk.documentId,
      versionId: chunk.versionId,
      versionNumber: chunk.versionNumber,
      chunkIndex: chunk.chunkIndex,
      status: chunk.status,
      text: chunk.text,
      textHash: chunk.textHash,
      tokenCount: chunk.tokenCount ?? null,
      nodeIds: chunk.nodeIds,
      headingPath: chunk.headingPath,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      bboxRefs: chunk.bboxRefs,
      aclHash: chunk.aclHash,
      aclVersion: chunk.aclVersion,
      sectionId: chunk.sectionId,
      embeddingModel: chunk.embeddingModel,
      embeddingVersion: chunk.embeddingVersion,
      vectorPointId: chunk.vectorPointId,
      fulltextDocId: chunk.fulltextDocId,
      metadata: chunk.metadata ?? null,
      createdAt: chunk.createdAt ?? now,
      deletedAt: null,
    }));
    await this.prisma.knowledgeChunk.createMany({ data });
    const records = await this.prisma.knowledgeChunk.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        chunkId: { in: chunks.map((c) => c.chunkId) },
      },
    });
    return records.map(mapChunk);
  }

  async listForVersion(scope: TenantScope, versionId: string): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeChunk.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        versionId,
        deletedAt: null,
      },
      orderBy: { chunkIndex: "asc" },
    });
    return records.map(mapChunk);
  }

  async promoteShadow(scope: TenantScope, versionId: string, _now = new Date()): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeChunk.updateMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        versionId,
        status: "shadow",
      },
      data: { status: "active" },
    });
    return updated.count;
  }

  async markDeletedForVersion(scope: TenantScope, versionId: string, now = new Date()): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const updated = await this.prisma.knowledgeChunk.updateMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        versionId,
        deletedAt: null,
      },
      data: { status: "deleted", deletedAt: now },
    });
    return updated.count;
  }

  async getMany(scope: TenantScope, chunkIds: string[]): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    if (chunkIds.length === 0) return [];
    const records = await this.prisma.knowledgeChunk.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        chunkId: { in: chunkIds },
      },
    });
    return records.map(mapChunk);
  }

  async listByIndexRange(
    scope: TenantScope,
    versionId: string,
    lo: number,
    hi: number,
  ): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeChunk.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        versionId,
        status: "active",
        deletedAt: null,
        chunkIndex: { gte: lo, lte: hi },
      },
      orderBy: { chunkIndex: "asc" },
    });
    return records.map(mapChunk);
  }

  async listForSection(scope: TenantScope, sectionId: string): Promise<KnowledgeChunkRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeChunk.findMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        sectionId,
        status: "active",
        deletedAt: null,
      },
      orderBy: { chunkIndex: "asc" },
    });
    return records.map(mapChunk);
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    const result = await client.knowledgeChunk.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
      },
    });
    return result.count;
  }
}

export class PrismaKnowledgeAnchorStore implements KnowledgeAnchorStore {
  constructor(private readonly prisma: PrismaLike) {}

  async upsert(record: KnowledgeAnchorRecord): Promise<KnowledgeAnchorRecord> {
    const safeScope = requireTenantScope(record);
    const data = {
      sourceSystemId: safeScope.sourceSystemId,
      tenantId: safeScope.tenantId,
      anchorId: record.anchorId,
      documentId: record.documentId,
      versionId: record.versionId,
      spaceId: record.spaceId,
      aclHash: record.aclHash,
      aclVersion: record.aclVersion,
      chunkId: record.chunkId,
      nodeId: record.nodeIds[0] ?? null,
      nodeIds: record.nodeIds,
      pageNo: record.page,
      bbox: record.bbox ?? null,
      charStart: record.charSpan?.start ?? null,
      charEnd: record.charSpan?.end ?? null,
      charSpan: record.charSpan ?? null,
      headingPath: record.headingPath,
      createdAt: record.createdAt,
    };
    const stored = await this.prisma.knowledgeCitationAnchor.upsert({
      where: {
        sourceSystemId_tenantId_anchorId: {
          sourceSystemId: safeScope.sourceSystemId,
          tenantId: safeScope.tenantId,
          anchorId: record.anchorId,
        },
      },
      create: data,
      update: data,
    });
    return mapAnchor(stored);
  }

  async get(scope: TenantScope, anchorId: string): Promise<KnowledgeAnchorRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeCitationAnchor.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, anchorId },
    });
    return record ? mapAnchor(record) : null;
  }

  async getByChunk(scope: TenantScope, chunkId: string): Promise<KnowledgeAnchorRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeCitationAnchor.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, chunkId },
      orderBy: { createdAt: "asc" },
    });
    return record ? mapAnchor(record) : null;
  }

  async hardDeleteBySpace(scope: TenantScope, spaceId: string, tx?: unknown): Promise<number> {
    const safeScope = requireTenantScope(scope);
    const client = (tx as PrismaLike | undefined) ?? this.prisma;
    // anchor.spaceId 在 schema 中是 nullable。优先按 spaceId 直接匹配；为了兼容
    // 历史空值行（spaceId IS NULL）再按 documentId IN (space 文档) 兜底。
    const direct = await client.knowledgeCitationAnchor.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        spaceId,
      },
    });
    const docs = await client.knowledgeDocument.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, spaceId },
      select: { documentId: true },
    });
    if (docs.length === 0) return direct.count;
    const fallback = await client.knowledgeCitationAnchor.deleteMany({
      where: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        documentId: { in: docs.map((d: { documentId: string }) => d.documentId) },
      },
    });
    return direct.count + fallback.count;
  }
}

export class PrismaKnowledgeEvalDatasetStore implements KnowledgeEvalDatasetStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(record: EvalDatasetRecord): Promise<EvalDatasetRecord> {
    const safeScope = requireTenantScope(record);
    const manifest = {
      annotator: record.annotator,
      samples: record.samples,
      metadata: record.metadata ?? null,
    };
    const stored = await this.prisma.knowledgeEvaluationDataset.create({
      data: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        datasetId: record.datasetId,
        name: record.name,
        version: record.version,
        manifest,
        createdBy: record.annotator,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      },
    });
    return mapDataset(stored);
  }

  async get(scope: TenantScope, datasetId: string): Promise<EvalDatasetRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeEvaluationDataset.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, datasetId },
    });
    return record ? mapDataset(record) : null;
  }

  async list(scope: TenantScope): Promise<EvalDatasetRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeEvaluationDataset.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId },
      orderBy: { createdAt: "desc" },
    });
    return records.map(mapDataset);
  }
}

export class PrismaKnowledgeEvalRunStore implements KnowledgeEvalRunStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(record: EvalRunRecord): Promise<EvalRunRecord> {
    const safeScope = requireTenantScope(record);
    const stored = await this.prisma.knowledgeEvaluationRun.create({
      data: {
        sourceSystemId: safeScope.sourceSystemId,
        tenantId: safeScope.tenantId,
        runId: record.runId,
        datasetId: record.datasetId,
        status: record.status,
        parserProfile: record.config.parserProfile ?? null,
        embeddingModel: record.config.embeddingModel ?? null,
        metrics: serializeRunMetrics(record),
        createdBy: "system",
        startedAt: record.startedAt ?? null,
        finishedAt: record.finishedAt ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    return mapRun(stored);
  }

  async get(scope: TenantScope, runId: string): Promise<EvalRunRecord | null> {
    const safeScope = requireTenantScope(scope);
    const record = await this.prisma.knowledgeEvaluationRun.findFirst({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, runId },
    });
    return record ? mapRun(record) : null;
  }

  async list(scope: TenantScope): Promise<EvalRunRecord[]> {
    const safeScope = requireTenantScope(scope);
    const records = await this.prisma.knowledgeEvaluationRun.findMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId },
      orderBy: { createdAt: "desc" },
    });
    return records.map(mapRun);
  }

  async update(scope: TenantScope, runId: string, patch: EvalRunPatch): Promise<EvalRunRecord | null> {
    const safeScope = requireTenantScope(scope);
    const existing = await this.get(safeScope, runId);
    if (!existing) return null;
    const next: EvalRunRecord = {
      ...existing,
      ...patch,
      failedSamples: patch.failedSamples ?? existing.failedSamples,
      metrics: patch.metrics !== undefined ? patch.metrics : existing.metrics,
    };
    await this.prisma.knowledgeEvaluationRun.updateMany({
      where: { sourceSystemId: safeScope.sourceSystemId, tenantId: safeScope.tenantId, runId },
      data: {
        status: next.status,
        startedAt: next.startedAt ?? null,
        finishedAt: next.finishedAt ?? null,
        metrics: serializeRunMetrics(next),
        updatedAt: patch.updatedAt ?? new Date(),
      },
    });
    return this.get(safeScope, runId);
  }
}

function mapAsset(record: any): KnowledgeAssetRecord {
  return {
    sourceSystemId: record.sourceSystemId,
    tenantId: record.tenantId,
    assetId: record.assetId,
    documentId: record.documentId ?? null,
    versionId: record.versionId ?? null,
    type: record.type,
    uri: record.uri,
    sha256: record.sha256,
    mimeType: record.mimeType ?? null,
    sizeBytes: record.sizeBytes == null ? null : Number(record.sizeBytes),
    pageNo: record.pageNo ?? null,
    bbox: record.bbox ?? null,
    metadata: record.metadata ?? null,
    createdAt: record.createdAt,
    deletedAt: record.deletedAt ?? null,
  };
}

function mapChunk(record: any): KnowledgeChunkRecord {
  return {
    sourceSystemId: record.sourceSystemId,
    tenantId: record.tenantId,
    chunkId: record.chunkId,
    spaceId: record.spaceId,
    documentId: record.documentId,
    versionId: record.versionId,
    versionNumber: record.versionNumber,
    chunkIndex: record.chunkIndex,
    status: record.status,
    text: record.text,
    textHash: record.textHash,
    tokenCount: record.tokenCount ?? 0,
    nodeIds: (record.nodeIds as string[] | null) ?? [],
    headingPath: (record.headingPath as string[] | null) ?? [],
    pageStart: record.pageStart ?? null,
    pageEnd: record.pageEnd ?? null,
    bboxRefs: (record.bboxRefs as KnowledgeChunkRecord["bboxRefs"] | null) ?? [],
    aclHash: record.aclHash,
    aclVersion: record.aclVersion,
    sectionId: record.sectionId ?? "",
    embeddingModel: record.embeddingModel ?? null,
    embeddingVersion: record.embeddingVersion ?? null,
    vectorPointId: record.vectorPointId ?? null,
    fulltextDocId: record.fulltextDocId ?? null,
    metadata: (record.metadata as Record<string, unknown> | null) ?? {},
    createdAt: record.createdAt,
    deletedAt: record.deletedAt ?? null,
  };
}

function mapAnchor(record: any): KnowledgeAnchorRecord {
  return {
    sourceSystemId: record.sourceSystemId,
    tenantId: record.tenantId,
    anchorId: record.anchorId,
    chunkId: record.chunkId,
    documentId: record.documentId,
    versionId: record.versionId,
    spaceId: record.spaceId ?? "",
    aclHash: record.aclHash ?? "",
    aclVersion: record.aclVersion ?? 0,
    page: record.pageNo ?? null,
    bbox: record.bbox ?? null,
    charSpan: record.charSpan ?? null,
    nodeIds: (record.nodeIds as string[] | null) ?? (record.nodeId ? [record.nodeId] : []),
    headingPath: (record.headingPath as string[] | null) ?? [],
    createdAt: record.createdAt,
  };
}

function mapDataset(record: any): EvalDatasetRecord {
  const manifest = (record.manifest ?? {}) as {
    annotator?: string;
    samples?: EvalSample[];
    metadata?: Record<string, unknown> | null;
  };
  return {
    sourceSystemId: record.sourceSystemId,
    tenantId: record.tenantId,
    datasetId: record.datasetId,
    name: record.name,
    version: record.version,
    annotator: manifest.annotator ?? record.createdBy ?? "",
    samples: Array.isArray(manifest.samples) ? manifest.samples : [],
    metadata: manifest.metadata ?? undefined,
    createdAt: record.createdAt,
  };
}

type RunMetricsBlob = {
  config: EvalRunRecord["config"];
  failedSamples: EvalSampleResult[];
  metrics: EvalRunMetrics | null;
};

function serializeRunMetrics(record: EvalRunRecord): RunMetricsBlob {
  return {
    config: record.config,
    failedSamples: record.failedSamples,
    metrics: record.metrics ?? null,
  };
}

function mapRun(record: any): EvalRunRecord {
  const blob = (record.metrics ?? {}) as Partial<RunMetricsBlob>;
  return {
    sourceSystemId: record.sourceSystemId,
    tenantId: record.tenantId,
    runId: record.runId,
    datasetId: record.datasetId,
    status: record.status,
    config: blob.config ?? {},
    metrics: blob.metrics ?? null,
    failedSamples: blob.failedSamples ?? [],
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
