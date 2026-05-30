import { createOpaqueId } from "@octopus/knowledge-contracts";
import type { KnowledgeAssetStore } from "../repositories/asset-store.js";
import type { KnowledgeChunkStore, KnowledgeChunkRecord } from "../repositories/chunk-store.js";
import type { KnowledgeDocumentStore, KnowledgeDocumentRecord } from "../repositories/document-store.js";
import type { KnowledgeDocumentVersionStore } from "../repositories/document-version-store.js";
import type { KnowledgeObjectStore } from "../repositories/object-store.js";
import { sha256Hex } from "../repositories/object-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { CanonicalDocument } from "../parser/canonical.js";
import type { ParserAdapter } from "../parser/parser-adapter.js";
import { chunkDocument, DEFAULT_CHUNK_PROFILE, type ChunkProfile, type ChunkRecord } from "../chunker/structure-aware-chunker.js";
import type { EmbeddingAdapter } from "../embedding/embedding-adapter.js";
import type { QdrantAdapter, QdrantPoint } from "../vector/qdrant-adapter.js";
import type { FulltextAdapter, FulltextDocument } from "../fulltext/fulltext-adapter.js";
import type { JobProcessor, JobProcessorResult } from "./job-worker.js";
import {
  embeddingDuration,
  indexUpsertDuration,
  parseDegradedCounter,
  parseDuration,
  parseFailureCounter,
  sanitizeLabel,
} from "../observability/metrics.js";

export type IngestProcessorOptions = {
  documents: KnowledgeDocumentStore;
  versions?: KnowledgeDocumentVersionStore;
  objects: KnowledgeObjectStore;
  assets: KnowledgeAssetStore;
  chunks?: KnowledgeChunkStore;
  embedding?: EmbeddingAdapter;
  vector?: QdrantAdapter;
  fulltext?: FulltextAdapter;
  parser: ParserAdapter;
  chunkProfile?: ChunkProfile;
  now?: () => Date;
  /** Soft cap: parser inputs above this are rejected without invoking the parser. */
  maxBodyBytes?: number;
};

type IngestPayload = {
  version_id?: string;
  space_id?: string;
  object_uri?: string;
  upload_id?: string;
  source_sha256?: string;
  source_filename?: string | null;
  source_type?: string | null;
  reindex_mode?: "shadow";
};

/**
 * Real ingest processor — replaces ingest-mock-processor. Drives a job through
 * parsing → indexing → searchable using a ParserAdapter (mock or MinerU), and
 * writes parse artifacts back into the object store + asset table so that
 * citation and chunking can find them later.
 *
 * Degraded path: parser may return `degraded` (e.g. unknown binary) — document
 * still becomes searchable but is flagged so retrieval can surface a warning.
 * Failure path: parser throws or returns `failed` — job throws so the worker's
 * retry/backoff state machine handles it.
 */
export function createIngestProcessor(options: IngestProcessorOptions): JobProcessor {
  const maxBodyBytes = options.maxBodyBytes ?? 100 * 1024 * 1024;
  const now = () => options.now?.() ?? new Date();

  return async (job, signal) => {
    if (!job.documentId) {
      throw new Error("ingest job missing document_id");
    }
    const payload = (job.payload ?? {}) as IngestPayload;
    const scope: TenantScope = { sourceSystemId: job.sourceSystemId, tenantId: job.tenantId };
    const versionId = payload.version_id ?? null;
    const objectUri = payload.object_uri ?? null;
    const expectedSha256 = payload.source_sha256 ?? null;

    if (!objectUri || !expectedSha256) {
      throw new Error("ingest job payload missing object_uri/source_sha256");
    }

    const isShadowRun = (payload.reindex_mode === "shadow");
    const documentId = job.documentId;
    try {
      return await runIngest({ documentId, signal, payload, scope, versionId, objectUri, expectedSha256, isShadowRun, options, maxBodyBytes, now });
    } catch (err) {
      // job-worker 会把 job 标 failed/dead_lettered,但 document.status 之前一直停在
      // parsing/indexing —— 前端永远转圈。这里把 document/version 落到 parse_failed,
      // 重试时 runIngest 第一步会把 status 改回 parsing,所以中间态被覆盖,不影响正常流程。
      if (!isShadowRun) {
        try {
          await options.documents.updateStatus(scope, documentId, "parse_failed", "hidden", now());
        } catch (_e) { /* best-effort */ }
      }
      if (versionId) {
        try {
          await options.versions?.updateStatus(scope, versionId, "parse_failed", now());
        } catch (_e) { /* best-effort */ }
      }
      throw err;
    }
  };
}

async function runIngest(args: {
  documentId: string;
  signal: AbortSignal;
  payload: IngestPayload;
  scope: TenantScope;
  versionId: string | null;
  objectUri: string;
  expectedSha256: string;
  isShadowRun: boolean;
  options: IngestProcessorOptions;
  maxBodyBytes: number;
  now: () => Date;
}): Promise<JobProcessorResult | void> {
  const { documentId, signal, payload, scope, versionId, objectUri, expectedSha256, isShadowRun, options, maxBodyBytes, now } = args;
  {
    assertNotAborted(signal);
    if (!isShadowRun) {
      await options.documents.updateStatus(scope, documentId, "parsing", "hidden", now());
    }
    if (versionId) {
      await options.versions?.updateStatus(scope, versionId, "parsing", now());
    }

    const stored = await options.objects.get(scope, objectUri);
    if (!stored) {
      throw new Error("source object not found in object store");
    }
    if (stored.sizeBytes > maxBodyBytes) {
      return { status: "degraded", reason: `source_too_large:${stored.sizeBytes}` };
    }
    const verifiedSha256 = sha256Hex(stored.body);
    if (verifiedSha256 !== expectedSha256) {
      throw new Error("source object sha256 changed since ingest was accepted");
    }

    assertNotAborted(signal);
    const parserProvider = sanitizeLabel(options.parser.provider);
    const tenantLabel = sanitizeLabel(scope.tenantId);
    const parseStartedAt = Date.now();
    let parseResult: Awaited<ReturnType<typeof options.parser.parse>>;
    try {
      parseResult = await options.parser.parse({
        body: stored.body,
        filename: payload.source_filename ?? null,
        mimeType: stored.mimeType ?? null,
        sourceSha256: verifiedSha256,
        documentId: documentId,
        versionId: versionId ?? "",
      }, signal);
    } catch (err) {
      parseDuration.observe({ tenant_id: tenantLabel, parser_provider: parserProvider, status: "failed" }, (Date.now() - parseStartedAt) / 1000);
      parseFailureCounter.inc({ tenant_id: tenantLabel, parser_provider: parserProvider, reason: "exception" });
      throw err;
    }
    const parseElapsed = (Date.now() - parseStartedAt) / 1000;
    parseDuration.observe(
      { tenant_id: tenantLabel, parser_provider: parserProvider, status: parseResult.status },
      parseElapsed,
    );
    if (parseResult.status === "degraded") {
      parseDegradedCounter.inc({ tenant_id: tenantLabel, parser_provider: parserProvider, reason: sanitizeLabel(parseResult.reason) });
    }

    if (parseResult.status === "failed") {
      parseFailureCounter.inc({ tenant_id: tenantLabel, parser_provider: parserProvider, reason: sanitizeLabel(parseResult.reason) });
      const error = new Error(`parser_failed:${parseResult.reason}`);
      (error as { retryable?: boolean }).retryable = parseResult.retryable;
      throw error;
    }

    const document = parseResult.document;
    assertNotAborted(signal);
    const persisted = await persistArtifacts({
      scope,
      documentId: documentId,
      versionId,
      objectUri,
      document,
      objects: options.objects,
      assets: options.assets,
      now: now(),
    });

    assertNotAborted(signal);
    if (!isShadowRun) {
      await options.documents.updateStatus(scope, documentId, "indexing", "hidden", now());
    }
    if (versionId) {
      await options.versions?.updateStatus(scope, versionId, "indexing", now());
    }

    const indexingDegraded = await runIndexingStage({
      scope,
      documentId,
      document,
      versionId,
      payload,
      options,
      signal,
      now,
    });

    assertNotAborted(signal);
    if (parseResult.status === "degraded" || indexingDegraded) {
      const reason = parseResult.status === "degraded" ? parseResult.reason : indexingDegraded!;
      if (!isShadowRun) {
        await options.documents.updateStatus(scope, documentId, "degraded", "visible", now());
      }
      if (versionId) {
        await options.versions?.updateStatus(scope, versionId, "degraded", now());
      }
      return { status: "degraded", reason };
    }

    if (isShadowRun) {
      // Shadow reindex: keep the document on its currently searchable version. The
      // new version sits in "indexing" status with shadow chunks until promoted.
      if (versionId) {
        await options.versions?.updateStatus(scope, versionId, "indexing", now());
      }
    } else {
      await options.documents.updateStatus(scope, documentId, "searchable", "visible", now());
      if (versionId) {
        await options.versions?.updateStatus(scope, versionId, "searchable", now());
      }
    }
    void persisted;
    return { status: "succeeded" };
  };
}

async function runIndexingStage(args: {
  scope: TenantScope;
  documentId: string;
  document: CanonicalDocument;
  versionId: string | null;
  payload: IngestPayload;
  options: IngestProcessorOptions;
  signal: AbortSignal;
  now: () => Date;
}): Promise<string | null> {
  const { scope, documentId, document, versionId, payload, options, signal, now } = args;
  const isShadow = payload.reindex_mode === "shadow";
  if (!options.chunks || !options.embedding || !options.vector) {
    // Indexing components not configured — leave indexing as a no-op so the
    // document still transitions to searchable. M4 wiring required for real
    // retrieval; M3 demo callers without vectors can still progress.
    return null;
  }
  if (!versionId) {
    return "missing_version_id";
  }
  const stored = await options.documents.get(scope, documentId);
  if (!stored) {
    return "document_not_found";
  }
  const profile = options.chunkProfile ?? DEFAULT_CHUNK_PROFILE;
  const versionNumber = isShadow
    ? (stored.currentVersionNumber ?? 0) + 1
    : (stored.currentVersionNumber ?? 1);
  const rawChunks = chunkDocument({
    canonical: document,
    documentId: documentId,
    versionId,
    versionNumber,
    spaceId: stored.spaceId,
    aclHash: stored.aclHash,
    aclVersion: stored.aclVersion,
    sourceSystemId: scope.sourceSystemId,
    tenantId: scope.tenantId,
    profile,
  });
  const chunks = isShadow
    ? rawChunks.map((chunk) => ({ ...chunk, status: "shadow" as const }))
    : rawChunks;
  if (chunks.length === 0) {
    return "empty_chunks";
  }

  assertNotAborted(signal);
  const tenantLabel = sanitizeLabel(scope.tenantId);
  const embeddingModelLabel = sanitizeLabel(options.embedding.metadata.model);
  const embedStartedAt = Date.now();
  const embedResult = await options.embedding.embedBatch({
    texts: chunks.map((chunk) => chunk.text),
    signal,
  });
  embeddingDuration.observe(
    { tenant_id: tenantLabel, embedding_model: embeddingModelLabel, status: embedResult.status === "ok" ? "ok" : "failed" },
    (Date.now() - embedStartedAt) / 1000,
  );
  if (embedResult.status !== "ok") {
    const error = new Error(`embedding_failed:${embedResult.reason}`);
    (error as { retryable?: boolean }).retryable = embedResult.retryable;
    throw error;
  }
  if (embedResult.vectors.length !== chunks.length) {
    throw new Error("embedding returned mismatched vector count");
  }

  assertNotAborted(signal);
  await options.vector.ensureCollection(embedResult.metadata.dimensions);

  const indexedAt = now();
  const enriched: KnowledgeChunkRecord[] = chunks.map((chunk) => buildChunkRecord(chunk, stored, embedResult.metadata, indexedAt));

  await options.chunks.insertMany(scope, enriched, indexedAt);

  const vectorStartedAt = Date.now();
  const upsert = await options.vector.upsertPoints(enriched.map((chunk, index) =>
    buildQdrantPoint(chunk, embedResult.vectors[index], stored, indexedAt),
  ));
  indexUpsertDuration.observe(
    { tenant_id: tenantLabel, target: "vector", status: upsert.status === "ok" ? "ok" : "failed" },
    (Date.now() - vectorStartedAt) / 1000,
  );
  if (upsert.status !== "ok") {
    await options.chunks.markDeletedForVersion(scope, versionId, indexedAt);
    const error = new Error(`vector_upsert_failed:${upsert.reason}`);
    (error as { retryable?: boolean }).retryable = upsert.retryable;
    throw error;
  }

  if (options.fulltext) {
    const fulltextDocs: FulltextDocument[] = enriched.map((chunk) => buildFulltextDocument(chunk, stored));
    const ftStartedAt = Date.now();
    const ftResult = await options.fulltext.upsertDocuments(fulltextDocs);
    indexUpsertDuration.observe(
      { tenant_id: tenantLabel, target: "fulltext", status: ftResult.status === "ok" ? "ok" : "failed" },
      (Date.now() - ftStartedAt) / 1000,
    );
    if (ftResult.status !== "ok") {
      await options.chunks.markDeletedForVersion(scope, versionId, indexedAt);
      const error = new Error(`fulltext_upsert_failed:${ftResult.reason}`);
      (error as { retryable?: boolean }).retryable = ftResult.retryable;
      throw error;
    }
  }
  return null;
}

function buildFulltextDocument(
  chunk: KnowledgeChunkRecord,
  document: KnowledgeDocumentRecord,
): FulltextDocument {
  return {
    id: chunk.chunkId,
    text: chunk.text,
    payload: {
      source_system_id: chunk.sourceSystemId,
      tenant_id: chunk.tenantId,
      space_id: chunk.spaceId,
      document_id: chunk.documentId,
      document_version_id: chunk.versionId,
      document_version_number: chunk.versionNumber,
      acl_hash: chunk.aclHash,
      acl_version: chunk.aclVersion,
      status: chunk.status === "shadow" ? "shadow" : "active",
      document_type: document.documentType ?? null,
      chunk_id: chunk.chunkId,
      chunk_index: chunk.chunkIndex,
      heading_path: chunk.headingPath,
      page_start: chunk.pageStart,
      page_end: chunk.pageEnd,
    },
  };
}

function buildChunkRecord(
  chunk: ChunkRecord,
  _document: KnowledgeDocumentRecord,
  metadata: EmbeddingAdapter["metadata"],
  now: Date,
): KnowledgeChunkRecord {
  return {
    ...chunk,
    embeddingModel: metadata.model,
    embeddingVersion: metadata.version,
    vectorPointId: chunk.chunkId,
    fulltextDocId: chunk.chunkId,
    createdAt: now,
    deletedAt: null,
  };
}

function buildQdrantPoint(
  chunk: KnowledgeChunkRecord,
  vector: number[],
  document: KnowledgeDocumentRecord,
  indexedAt: Date,
): QdrantPoint {
  return {
    id: chunk.chunkId,
    vector,
    payload: {
      source_system_id: chunk.sourceSystemId,
      tenant_id: chunk.tenantId,
      space_id: chunk.spaceId,
      document_id: chunk.documentId,
      document_version_id: chunk.versionId,
      document_version_number: chunk.versionNumber,
      acl_hash: chunk.aclHash,
      acl_version: chunk.aclVersion,
      status: chunk.status === "shadow" ? "shadow" : "active",
      deleted_at: null,
      tags: [],
      document_type: document.documentType ?? null,
      time: indexedAt.toISOString(),
      chunk_index: chunk.chunkIndex,
      heading_path: chunk.headingPath,
      page_start: chunk.pageStart,
      page_end: chunk.pageEnd,
    },
  };
}

async function persistArtifacts(input: {
  scope: TenantScope;
  documentId: string;
  versionId: string | null;
  objectUri: string;
  document: CanonicalDocument;
  objects: KnowledgeObjectStore;
  assets: KnowledgeAssetStore;
  now: Date;
}): Promise<{ markdownUri: string; canonicalUri: string }> {
  const { scope, documentId, versionId, objectUri, document, objects, assets, now } = input;
  const baseUri = objectUri.replace(/\/raw\//, "/parsed/");
  const markdownUri = `${baseUri}.md`;
  const canonicalUri = `${baseUri}.canonical.json`;
  const markdownBuffer = Buffer.from(document.markdown, "utf8");
  const canonicalBuffer = Buffer.from(JSON.stringify(document), "utf8");

  await objects.put(scope, markdownUri, markdownBuffer, { mimeType: "text/markdown", now });
  await objects.put(scope, canonicalUri, canonicalBuffer, { mimeType: "application/json", now });

  await assets.upsert({
    ...scope,
    assetId: createOpaqueId("asset"),
    documentId,
    versionId,
    type: "markdown",
    uri: markdownUri,
    sha256: sha256Hex(markdownBuffer),
    mimeType: "text/markdown",
    sizeBytes: markdownBuffer.byteLength,
    createdAt: now,
  });
  await assets.upsert({
    ...scope,
    assetId: createOpaqueId("asset"),
    documentId,
    versionId,
    type: "canonical_json",
    uri: canonicalUri,
    sha256: sha256Hex(canonicalBuffer),
    mimeType: "application/json",
    sizeBytes: canonicalBuffer.byteLength,
    metadata: {
      parser_provider: document.parser.provider,
      parser_version: document.parser.version,
      node_count: document.nodes.length,
      page_count: document.pageCount,
    },
    createdAt: now,
  });

  return { markdownUri, canonicalUri };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("ingest processor aborted");
  }
}
