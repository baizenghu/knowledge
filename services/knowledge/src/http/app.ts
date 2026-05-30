import express, { type Express } from "express";
import client from "prom-client";
import { loadKnowledgeServiceConfig, type KnowledgeServiceConfig } from "../config.js";
import { sendError, sendOk } from "./envelope.js";
import { createAuthMiddleware } from "./auth.js";
import { InMemoryNonceStore } from "./nonce-store.js";
import { InMemoryKnowledgeAuditEventWriter, type KnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeAclStore, type KnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAnchorStore, type KnowledgeAnchorStore } from "../repositories/anchor-store.js";
import { InMemoryKnowledgeChunkStore, type KnowledgeChunkStore } from "../repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore, type KnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeDocumentVersionStore, type KnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import { InMemoryKnowledgeIdempotencyStore, type KnowledgeIdempotencyStore } from "../repositories/idempotency-store.js";
import { InMemoryKnowledgeJobStore, isTerminalJobStatus, type KnowledgeJobStore } from "../repositories/job-store.js";
import { InMemoryKnowledgeObjectStore, type KnowledgeObjectStore } from "../repositories/object-store.js";
import { InMemoryKnowledgeSpaceStore, type KnowledgeSpaceStore } from "../repositories/space-store.js";
import { InMemoryKnowledgeUploadSessionStore, type KnowledgeUploadSessionStore } from "../repositories/upload-session-store.js";
import { KnowledgeAclService } from "../services/acl-service.js";
import { KnowledgeAclVisibilityService } from "../services/acl-visibility.js";
import { KnowledgeAnswerService } from "../services/answer-service.js";
import { KnowledgeCitationResolver } from "../services/citation-resolver.js";
import { KnowledgeEvaluationService } from "../services/evaluation-service.js";
import { InMemoryKnowledgeEvalDatasetStore, type KnowledgeEvalDatasetStore, type EvalSample } from "../repositories/eval-dataset-store.js";
import { InMemoryKnowledgeEvalRunStore, type KnowledgeEvalRunStore } from "../repositories/eval-run-store.js";
import { KnowledgeDocumentService } from "../services/document-service.js";
import { KnowledgeReindexService } from "../services/reindex-service.js";
import { KnowledgeSearchService, type SearchContext, type SearchQuery } from "../services/search-service.js";
import { KnowledgeSpaceService } from "../services/space-service.js";
import { SpaceDeletionService, type SpaceDeletionPrismaLike } from "../services/space-deletion-service.js";
import { KnowledgeUploadService } from "../services/upload-service.js";
import { KnowledgeGCWorker } from "../workers/gc-worker.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { createSseStream } from "./sse-stream.js";
import { JobsHub } from "../services/JobsHub.js";
import { InMemoryKnowledgeAssetStore, type KnowledgeAssetStore } from "../repositories/asset-store.js";
import type { EmbeddingAdapter } from "../embedding/embedding-adapter.js";
import { MockEmbeddingAdapter } from "../embedding/mock-embedding.js";
import type { FulltextAdapter } from "../fulltext/fulltext-adapter.js";
import { InMemoryBM25Adapter } from "../fulltext/in-memory-bm25.js";
import type { LLMAdapter } from "../llm/llm-adapter.js";
import { MockLLMAdapter } from "../llm/mock-llm.js";
import type { RerankAdapter } from "../rerank/rerank-adapter.js";
import { MockRerankerAdapter } from "../rerank/mock-rerank.js";
import type { QdrantAdapter } from "../vector/qdrant-adapter.js";
import { InMemoryQdrantAdapter } from "../vector/in-memory-qdrant.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import { knowledgeRegistry } from "../observability/metrics.js";

client.collectDefaultMetrics({ prefix: "knowledge_" });

export type KnowledgeAppDeps = {
  documents?: KnowledgeDocumentStore;
  versions?: KnowledgeDocumentVersionStore;
  jobs?: KnowledgeJobStore;
  idempotency?: KnowledgeIdempotencyStore;
  audit?: KnowledgeAuditEventWriter;
  spaces?: KnowledgeSpaceStore;
  uploads?: KnowledgeUploadSessionStore;
  acl?: KnowledgeAclStore;
  objects?: KnowledgeObjectStore;
  chunks?: KnowledgeChunkStore;
  vector?: QdrantAdapter;
  fulltext?: FulltextAdapter;
  embedding?: EmbeddingAdapter;
  reranker?: RerankAdapter;
  llm?: LLMAdapter;
  anchors?: KnowledgeAnchorStore;
  evalDatasets?: KnowledgeEvalDatasetStore;
  evalRuns?: KnowledgeEvalRunStore;
  /** Prisma 客户端门面：传入时 SpaceDeletionService 走 $transaction，缺省走内存顺序模式。 */
  prisma?: SpaceDeletionPrismaLike | null;
  /** Phase C admin endpoints reuse the GC worker for purge / retry. Falls back to a freshly-built in-memory worker when absent. */
  gcWorker?: KnowledgeGCWorker;
  /** Asset store needed when the app builds its own GC worker fallback. */
  assets?: KnowledgeAssetStore;
  /**
   * 唯一 JobsHub 实例，由 runtime 注入（store emit ping 与 SSE 端点订阅必须共用同一个）。
   * 缺省 new 一个仅为单测裸跑 createKnowledgeApp 时不报错；生产路径绝不能走默认值。
   */
  jobsHub?: JobsHub;
};

function scopeFromRequest(req: express.Request): TenantScope {
  return {
    sourceSystemId: String(req.headers["x-octopus-source-system"] || "octopus"),
    tenantId: String(req.headers["x-octopus-tenant"] || ""),
  };
}

function userFromRequest(req: express.Request): string {
  return String(req.headers["x-octopus-user"] || "");
}

function parseCsv(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter((part) => part.length > 0);
}

function contextFromRequest(req: express.Request): SearchContext {
  return {
    tenantId: String(req.headers["x-octopus-tenant"] || ""),
    userId: String(req.headers["x-octopus-user"] || ""),
    departments: parseCsv(req.headers["x-octopus-departments"]),
    roles: parseCsv(req.headers["x-octopus-roles"]),
  };
}

/**
 * Parse the wire-form `{ mode, window_size, max_context_tokens }` (snake_case
 * per project HTTP convention) into the camelCase ContextOptions consumed by
 * SearchService. Anything missing or invalid is dropped — defaults are
 * filled in by SearchService.
 */
function parseContextOptions(raw: unknown): SearchQuery["context"] {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { mode?: "chunk" | "window" | "section" | "document"; windowSize?: number; maxContextTokens?: number } = {};
  if (typeof obj.mode === "string" && ["chunk", "window", "section", "document"].includes(obj.mode)) {
    out.mode = obj.mode as "chunk" | "window" | "section" | "document";
  }
  if (typeof obj.window_size === "number" && obj.window_size >= 0 && obj.window_size <= 10) {
    out.windowSize = obj.window_size;
  }
  if (typeof obj.max_context_tokens === "number" && obj.max_context_tokens > 0 && obj.max_context_tokens <= 100_000) {
    out.maxContextTokens = obj.max_context_tokens;
  }
  // mode is required for a valid ContextOptions; if absent return undefined so
  // SearchService applies DEFAULT_CONTEXT in full.
  if (!out.mode) return undefined;
  return out as SearchQuery["context"];
}

export function createKnowledgeApp(
  config: KnowledgeServiceConfig = loadKnowledgeServiceConfig(),
  deps: KnowledgeAppDeps = {},
): Express {
  const app = express();
  const nonceStore = new InMemoryNonceStore(config.nonceTtlMs);
  const audit = deps.audit ?? new InMemoryKnowledgeAuditEventWriter();
  const documents = deps.documents ?? new InMemoryKnowledgeDocumentStore();
  const jobs = deps.jobs ?? new InMemoryKnowledgeJobStore();
  // 默认值仅为单测裸跑兜底；生产由 runtime 注入与 store 共享的唯一实例。
  const jobsHub = deps.jobsHub ?? new JobsHub();
  const spaces = deps.spaces ?? new InMemoryKnowledgeSpaceStore();
  const uploads = deps.uploads ?? new InMemoryKnowledgeUploadSessionStore();
  const acl = deps.acl ?? new InMemoryKnowledgeAclStore();
  const objects = deps.objects ?? new InMemoryKnowledgeObjectStore();
  const versions = deps.versions ?? new InMemoryKnowledgeDocumentVersionStore();
  const chunks = deps.chunks ?? new InMemoryKnowledgeChunkStore();
  const vector = deps.vector ?? new InMemoryQdrantAdapter("knowledge_chunks");
  const fulltext = deps.fulltext ?? new InMemoryBM25Adapter();
  const embedding = deps.embedding ?? new MockEmbeddingAdapter();
  const reranker = deps.reranker ?? new MockRerankerAdapter();
  const llm = deps.llm ?? new MockLLMAdapter();
  const anchors = deps.anchors ?? new InMemoryKnowledgeAnchorStore();
  const documentService = new KnowledgeDocumentService({
    documents,
    versions,
    jobs,
    idempotency: deps.idempotency ?? new InMemoryKnowledgeIdempotencyStore(),
    audit,
    spaces,
    acl,
    uploads,
    objects,
  });
  const spaceService = new KnowledgeSpaceService({ spaces, audit });
  const spaceDeletionService = new SpaceDeletionService({
    spaces,
    documents,
    jobs,
    audit,
    vector,
    fulltext,
    objectStore: objects,
    prisma: deps.prisma ?? null,
  });
  const uploadService = new KnowledgeUploadService({
    spaces,
    uploads,
    objects,
    audit,
  });
  const aclService = new KnowledgeAclService({
    acl,
    documents,
    audit,
  });
  const reindexService = new KnowledgeReindexService({
    documents,
    versions,
    jobs,
    chunks,
    audit,
    vector,
    spaces,
  });
  const aclVisibility = new KnowledgeAclVisibilityService({ acl, documents });
  const searchService = new KnowledgeSearchService({
    documents,
    chunks,
    vector,
    fulltext,
    embedding,
    reranker,
    acl,
    anchors,
    spaces,
  });
  const answerService = new KnowledgeAnswerService({ search: searchService, llm });
  const citationResolver = new KnowledgeCitationResolver({
    anchors,
    chunks,
    documents,
    aclVisibility,
  });
  const evalDatasets = deps.evalDatasets ?? new InMemoryKnowledgeEvalDatasetStore();
  const evalRuns = deps.evalRuns ?? new InMemoryKnowledgeEvalRunStore();
  const evaluationService = new KnowledgeEvaluationService({
    datasets: evalDatasets,
    runs: evalRuns,
    search: searchService,
    answer: answerService,
    embedding,
    reranker,
    audit,
  });

  app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));

  app.use("/v1/assets/uploads/:upload_id/content", express.raw({
    type: "*/*",
    limit: "100mb",
    verify: (req, _res, buffer) => {
      (req as { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));

  app.get("/v1/health", (_req, res) => {
    sendOk(res, { status: "ok", service: "knowledge-service" });
  });

  app.get("/v1/ready", (_req, res) => {
    // M1: include DB, object storage, Qdrant, parser, embedding, and rerank dependency probes.
    sendOk(res, { status: "ready" });
  });

  app.get("/v1/metrics", async (_req, res) => {
    const merged = client.Registry.merge([client.register, knowledgeRegistry]);
    res.setHeader("content-type", merged.contentType);
    res.end(await merged.metrics());
  });

  const requireAuth = createAuthMiddleware(config, nonceStore);

  // GC worker: prefer the one passed in by the runtime (single shared instance).
  // Otherwise build an in-memory fallback so the admin routes still work in unit tests.
  const assets = deps.assets ?? new InMemoryKnowledgeAssetStore();
  const gcWorker =
    deps.gcWorker ??
    new KnowledgeGCWorker({
      spaces,
      chunks,
      versions,
      anchors,
      assets,
      acl,
      uploads,
      documents,
      jobs,
      audit,
      vector,
      fulltext,
      objectStore: objects,
      prisma: (deps.prisma as { $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> } | null) ?? null,
    });

  app.post("/v1/spaces", requireAuth, async (req, res) => {
    const result = await spaceService.createSpace(scopeFromRequest(req), {
      type: typeof req.body?.type === "string" ? req.body.type : undefined,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      description: typeof req.body?.description === "string" ? req.body.description : undefined,
      ownerType: typeof req.body?.owner_type === "string" ? req.body.owner_type : undefined,
      ownerId: typeof req.body?.owner_id === "string" ? req.body.owner_id : undefined,
      defaultAcl: req.body?.default_acl,
      createdBy: userFromRequest(req),
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 201);
  });

  app.get("/v1/spaces", requireAuth, async (req, res) => {
    const ctx = contextFromRequest(req);
    const result = await spaceService.listSpaces(
      scopeFromRequest(req),
      {
        type: typeof req.query.type === "string" ? req.query.type : undefined,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      },
      { userId: ctx.userId, departments: ctx.departments, roles: ctx.roles },
    );
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data);
  });

  app.delete("/v1/spaces/:space_id", requireAuth, async (req, res) => {
    const scope = scopeFromRequest(req);
    const ctx = contextFromRequest(req);
    const spaceId = req.params.space_id;
    const result = await spaceDeletionService.softDelete(scope, spaceId, {
      userId: ctx.userId,
      roles: ctx.roles,
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data);
  });

  app.get("/v1/spaces/:space_id/documents", requireAuth, async (req, res) => {
    const result = await documentService.listDocumentsBySpace(scopeFromRequest(req), req.params.space_id, {
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      includeDeleted: req.query.include_deleted === "true",
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data);
  });

  app.post("/v1/assets/upload-url", requireAuth, async (req, res) => {
    const result = await uploadService.createUploadUrl(scopeFromRequest(req), {
      spaceId: String(req.body?.space_id || ""),
      filename: typeof req.body?.filename === "string" ? req.body.filename : undefined,
      mimeType: typeof req.body?.mime_type === "string" ? req.body.mime_type : undefined,
      sizeBytes: req.body?.size_bytes === undefined ? undefined : Number(req.body.size_bytes),
      sha256: typeof req.body?.sha256 === "string" ? req.body.sha256 : undefined,
      issuedBy: userFromRequest(req),
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 201);
  });

  app.put("/v1/assets/uploads/:upload_id/content", requireAuth, async (req, res) => {
    const result = await uploadService.putUploadedContent(scopeFromRequest(req), {
      uploadId: req.params.upload_id,
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.from([]),
      userId: userFromRequest(req),
      mimeType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 200);
  });

  app.post("/v1/documents/ingest", requireAuth, async (req, res) => {
    const result = await documentService.ingest(scopeFromRequest(req), {
      spaceId: String(req.body?.space_id || "space_default"),
      title: typeof req.body?.title === "string" ? req.body.title : undefined,
      documentType: typeof req.body?.document_type === "string" ? req.body.document_type : undefined,
      sourceType: typeof req.body?.source?.type === "string" ? req.body.source.type : undefined,
      sourceUri: typeof req.body?.source?.uri === "string" ? req.body.source.uri : undefined,
      uploadId: typeof req.body?.source?.upload_id === "string" ? req.body.source.upload_id : undefined,
      filename: typeof req.body?.source?.filename === "string" ? req.body.source.filename : undefined,
      sourceSha256: typeof req.body?.source?.sha256 === "string" ? req.body.source.sha256 : undefined,
      createdBy: userFromRequest(req),
      idempotencyKey: String(req.headers["idempotency-key"] || "") || undefined,
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, result.replayed ? 200 : 202, result.replayed ? { replayed: true } : undefined);
  });

  app.get("/v1/jobs/:job_id", requireAuth, async (req, res) => {
    const job = await jobs.get(scopeFromRequest(req), req.params.job_id);
    if (!job) {
      sendError(res, "NOT_FOUND", "job not found");
      return;
    }
    sendOk(res, {
      job_id: job.jobId,
      type: job.type,
      status: job.status,
      progress: job.progress ?? null,
      attempt: job.attempt,
      max_retries: job.maxRetries,
      document_id: job.documentId ?? null,
      document_version_id: typeof job.payload === "object" && job.payload && "version_id" in job.payload ? (job.payload as { version_id?: unknown }).version_id ?? null : null,
      degraded_reason: job.degradedReason ?? null,
      error_code: job.errorCode ?? null,
      error_message: job.errorMessage ?? null,
      started_at: job.startedAt?.toISOString() ?? null,
      finished_at: job.finishedAt?.toISOString() ?? null,
    });
  });

  app.get("/v1/jobs/:job_id/events", requireAuth, async (req, res) => {
    const scope = scopeFromRequest(req);
    const jobId = req.params.job_id;
    // 首帧读 DB,顺带做 not-found / 租户隔离（jobs.get 带 scope）。
    const first = await jobs.get(scope, jobId);
    if (!first) {
      sendError(res, "NOT_FOUND", "job not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const stream = createSseStream(res, { heartbeatIntervalMs: 30_000 });

    const toPayload = (j: NonNullable<Awaited<ReturnType<typeof jobs.get>>>) => ({
      type: "status" as const,
      jobId,
      status: j.status,
      attempt: j.attempt,
      errorCode: j.errorCode ?? null,
      errorMessage: j.errorMessage ?? null,
      degradedReason: j.degradedReason ?? null,
      documentId: j.documentId ?? null,
    });

    let inFlight = false;
    // ping/兜底 → 一律 re-read DB 推真实态（DB 是事实源，不信 ping payload）。
    const pushFresh = async () => {
      if (inFlight || stream.isClosed()) return;
      inFlight = true;
      try {
        const j = await jobs.get(scope, jobId);
        if (!j) return;
        stream.writeData(toPayload(j));
        if (isTerminalJobStatus(j.status)) stream.close({ type: "done" });
      } finally {
        inFlight = false;
      }
    };

    // 首帧（已持有 first，省一次读）。
    stream.writeData(toPayload(first));
    if (isTerminalJobStatus(first.status)) {
      stream.close({ type: "done" });
      return;
    }

    const off = jobsHub.on(jobId, () => {
      void pushFresh();
    });
    const fallback = setInterval(() => {
      void pushFresh();
    }, 10_000);
    fallback.unref?.();
    stream.registerCleanup(() => {
      off();
      clearInterval(fallback);
    });
  });

  app.put("/v1/documents/:document_id/acl", requireAuth, async (req, res) => {
    const result = await aclService.updateDocumentAcl(scopeFromRequest(req), {
      documentId: req.params.document_id,
      acl: req.body?.acl,
      effectiveFrom: typeof req.body?.effective_from === "string" ? new Date(req.body.effective_from) : null,
      effectiveTo: typeof req.body?.effective_to === "string" ? new Date(req.body.effective_to) : null,
      userId: userFromRequest(req),
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 202);
  });

  app.delete("/v1/documents/:document_id", requireAuth, async (req, res) => {
    const result = await documentService.deleteDocument(scopeFromRequest(req), req.params.document_id, userFromRequest(req));
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 202);
  });

  app.post("/v1/documents/:document_id/reindex", requireAuth, async (req, res) => {
    const result = await reindexService.startReindex(scopeFromRequest(req), req.params.document_id, userFromRequest(req));
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 202);
  });

  app.post("/v1/documents/:document_id/reindex/:job_id/promote", requireAuth, async (req, res) => {
    const scope = scopeFromRequest(req);
    const job = await jobs.get(scope, req.params.job_id);
    if (!job || job.documentId !== req.params.document_id) {
      sendError(res, "NOT_FOUND", "reindex job not found");
      return;
    }
    const payload = (job.payload ?? {}) as { version_id?: string };
    if (!payload.version_id) {
      sendError(res, "NOT_FOUND", "reindex job not found");
      return;
    }
    const result = await reindexService.promote(scope, req.params.document_id, payload.version_id, userFromRequest(req));
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 202);
  });

  app.post("/v1/documents/:document_id/reindex/:job_id/rollback", requireAuth, async (req, res) => {
    const scope = scopeFromRequest(req);
    const job = await jobs.get(scope, req.params.job_id);
    if (!job || job.documentId !== req.params.document_id) {
      sendError(res, "NOT_FOUND", "reindex job not found");
      return;
    }
    const payload = (job.payload ?? {}) as { version_id?: string };
    if (!payload.version_id) {
      sendError(res, "NOT_FOUND", "reindex job not found");
      return;
    }
    const result = await reindexService.rollback(scope, req.params.document_id, payload.version_id, userFromRequest(req));
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 202);
  });

  app.post("/v1/search", requireAuth, async (req, res) => {
    const result = await searchService.search(
      scopeFromRequest(req),
      {
        query: typeof req.body?.query === "string" ? req.body.query : "",
        spaceIds: Array.isArray(req.body?.space_ids) ? req.body.space_ids.filter((s: unknown) => typeof s === "string") : undefined,
        topK: typeof req.body?.top_k === "number" ? req.body.top_k : undefined,
        finalK: typeof req.body?.final_k === "number" ? req.body.final_k : undefined,
        strictSpaceCheck: Boolean(req.body?.strict_space_check),
        documentTypes: Array.isArray(req.body?.document_types) ? req.body.document_types.filter((s: unknown) => typeof s === "string") : undefined,
        filters: req.body?.filters,
        context: parseContextOptions(req.body?.context),
      },
      contextFromRequest(req),
    );
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, {
      items: result.data.hits.map((hit) => ({
        chunk_id: hit.chunkId,
        document_id: hit.documentId,
        version_id: hit.versionId,
        version_number: hit.versionNumber,
        space_id: hit.spaceId,
        text: hit.text,
        context_text: hit.contextText,
        context_chunk_ids: hit.contextChunkIds,
        matched_chunk_id: hit.chunkId,
        heading_path: hit.headingPath,
        page_start: hit.pageStart,
        page_end: hit.pageEnd,
        score: hit.score,
        scores: hit.scores,
        anchor_id: hit.anchorId,
      })),
      trace: result.data.trace,
    });
  });

  app.post("/v1/answer", requireAuth, async (req, res) => {
    const result = await answerService.answer(
      scopeFromRequest(req),
      {
        query: typeof req.body?.query === "string" ? req.body.query : "",
        spaceIds: Array.isArray(req.body?.space_ids) ? req.body.space_ids.filter((s: unknown) => typeof s === "string") : undefined,
        topK: typeof req.body?.top_k === "number" ? req.body.top_k : undefined,
        finalK: typeof req.body?.final_k === "number" ? req.body.final_k : undefined,
        strictSpaceCheck: Boolean(req.body?.strict_space_check),
        documentTypes: Array.isArray(req.body?.document_types) ? req.body.document_types.filter((s: unknown) => typeof s === "string") : undefined,
        maxTokens: typeof req.body?.max_tokens === "number" ? req.body.max_tokens : undefined,
        temperature: typeof req.body?.temperature === "number" ? req.body.temperature : undefined,
        context: parseContextOptions(req.body?.context),
      },
      contextFromRequest(req),
    );
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, {
      answer: result.data.answer,
      citations: result.data.citations.map((c) => ({
        anchor_id: c.anchorId,
        chunk_id: c.chunkId,
        document_id: c.documentId,
        page: c.page,
        heading_path: c.headingPath,
        snippet: c.snippet,
      })),
      trace: result.data.trace,
    });
  });

  app.get("/v1/citations/:anchor_id", requireAuth, async (req, res) => {
    const result = await citationResolver.resolve(
      scopeFromRequest(req),
      req.params.anchor_id,
      contextFromRequest(req),
    );
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data);
  });

  app.post("/v1/evaluations/datasets", requireAuth, async (req, res) => {
    const samplesInput = Array.isArray(req.body?.samples) ? req.body.samples : [];
    const samples: EvalSample[] = samplesInput
      .filter((s: unknown): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s: Record<string, unknown>) => ({
        sampleId: typeof s["sample_id"] === "string" ? (s["sample_id"] as string) : "",
        query: typeof s["query"] === "string" ? (s["query"] as string) : "",
        expectedDocumentIds: Array.isArray(s["expected_document_ids"])
          ? (s["expected_document_ids"] as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
        expectedAnchorIds: Array.isArray(s["expected_anchor_ids"])
          ? (s["expected_anchor_ids"] as unknown[]).filter((v): v is string => typeof v === "string")
          : undefined,
        expectedAnswer: typeof s["expected_answer"] === "string" ? (s["expected_answer"] as string) : null,
        expectedSpaceIds: Array.isArray(s["expected_space_ids"])
          ? (s["expected_space_ids"] as unknown[]).filter((v): v is string => typeof v === "string")
          : null,
        contextOverride:
          typeof s["context_override"] === "object" && s["context_override"] !== null
            ? {
                userId: String((s["context_override"] as Record<string, unknown>)["user_id"] ?? ""),
                departments: Array.isArray((s["context_override"] as Record<string, unknown>)["departments"])
                  ? ((s["context_override"] as Record<string, unknown>)["departments"] as unknown[]).filter(
                      (v): v is string => typeof v === "string",
                    )
                  : undefined,
                roles: Array.isArray((s["context_override"] as Record<string, unknown>)["roles"])
                  ? ((s["context_override"] as Record<string, unknown>)["roles"] as unknown[]).filter(
                      (v): v is string => typeof v === "string",
                    )
                  : undefined,
              }
            : undefined,
        tags: Array.isArray(s["tags"])
          ? (s["tags"] as unknown[]).filter((v): v is string => typeof v === "string")
          : undefined,
      }));
    const result = await evaluationService.createDataset(scopeFromRequest(req), {
      name: typeof req.body?.name === "string" ? req.body.name : "",
      version: typeof req.body?.version === "string" ? req.body.version : "",
      annotator: typeof req.body?.annotator === "string" ? req.body.annotator : "",
      samples,
      metadata: typeof req.body?.metadata === "object" && req.body?.metadata !== null
        ? (req.body.metadata as Record<string, unknown>)
        : undefined,
      userId: userFromRequest(req),
    });
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    sendOk(res, result.data, 201);
  });

  app.post("/v1/evaluations/runs", requireAuth, async (req, res) => {
    const datasetId = typeof req.body?.dataset_id === "string" ? req.body.dataset_id : "";
    const cfg = (req.body?.config ?? {}) as Record<string, unknown>;
    const scope = scopeFromRequest(req);
    const result = await evaluationService.createRun(
      scope,
      datasetId,
      {
        topK: typeof cfg["top_k"] === "number" ? (cfg["top_k"] as number) : undefined,
        finalK: typeof cfg["final_k"] === "number" ? (cfg["final_k"] as number) : undefined,
        runAnswer: typeof cfg["run_answer"] === "boolean" ? (cfg["run_answer"] as boolean) : undefined,
        parserProfile: typeof cfg["parser_profile"] === "string" ? (cfg["parser_profile"] as string) : undefined,
        embeddingModel: typeof cfg["embedding_model"] === "string" ? (cfg["embedding_model"] as string) : undefined,
        rerankerModel: typeof cfg["reranker_model"] === "string" ? (cfg["reranker_model"] as string) : undefined,
      },
      userFromRequest(req),
    );
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    const runId = result.data.run_id;
    setImmediate(() => {
      void evaluationService.runSync(scope, runId);
    });
    sendOk(res, result.data, 202);
  });

  app.get("/v1/evaluations/runs/:run_id", requireAuth, async (req, res) => {
    const result = await evaluationService.getRun(scopeFromRequest(req), req.params.run_id);
    if (!result.ok) {
      sendError(res, result.code, result.message);
      return;
    }
    const run = result.data;
    sendOk(res, {
      run_id: run.runId,
      dataset_id: run.datasetId,
      status: run.status,
      config: run.config,
      metrics: run.metrics ?? null,
      failed_samples_count: run.failedSamples.length,
      started_at: run.startedAt?.toISOString() ?? null,
      finished_at: run.finishedAt?.toISOString() ?? null,
      created_at: run.createdAt.toISOString(),
      updated_at: run.updatedAt.toISOString(),
    });
  });

  registerAdminRoutes(app, { spaces, documents, audit, gcWorker, requireAuth });

  return app;
}
