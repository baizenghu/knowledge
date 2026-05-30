import { InMemoryKnowledgeAclStore } from "./repositories/acl-store.js";
import { InMemoryKnowledgeAnchorStore } from "./repositories/anchor-store.js";
import { InMemoryKnowledgeAssetStore } from "./repositories/asset-store.js";
import { InMemoryKnowledgeAuditEventWriter } from "./repositories/audit-events.js";
import { InMemoryKnowledgeChunkStore } from "./repositories/chunk-store.js";
import { InMemoryKnowledgeDocumentStore } from "./repositories/document-store.js";
import { InMemoryKnowledgeDocumentVersionStore } from "./repositories/document-version-store.js";
import { InMemoryKnowledgeIdempotencyStore } from "./repositories/idempotency-store.js";
import { InMemoryKnowledgeJobStore } from "./repositories/job-store.js";
import { InMemoryKnowledgeObjectStore } from "./repositories/object-store.js";
import { MockParserAdapter } from "./parser/mock-parser.js";
import { MinerUHttpAdapter } from "./parser/mineru-adapter.js";
import { RoutingParserAdapter } from "./parser/routing-parser.js";
import type { ParserAdapter } from "./parser/parser-adapter.js";
import { MockEmbeddingAdapter } from "./embedding/mock-embedding.js";
import { BgeM3OllamaAdapter } from "./embedding/bge-m3-ollama.js";
import type { EmbeddingAdapter } from "./embedding/embedding-adapter.js";
import { InMemoryQdrantAdapter } from "./vector/in-memory-qdrant.js";
import { QdrantHttpAdapter } from "./vector/qdrant-http.js";
import type { QdrantAdapter } from "./vector/qdrant-adapter.js";
import { InMemoryBM25Adapter } from "./fulltext/in-memory-bm25.js";
import { ElasticsearchAdapter } from "./fulltext/elasticsearch-stub.js";
import type { FulltextAdapter } from "./fulltext/fulltext-adapter.js";
import { MockRerankerAdapter } from "./rerank/mock-rerank.js";
import { TEIRerankerAdapter } from "./rerank/tei-rerank.js";
import type { RerankAdapter } from "./rerank/rerank-adapter.js";
import { MockLLMAdapter } from "./llm/mock-llm.js";
import { OpenAICompatibleLLMAdapter } from "./llm/openai-compatible-llm.js";
import type { LLMAdapter } from "./llm/llm-adapter.js";
import {
  PrismaKnowledgeAclStore,
  PrismaKnowledgeAnchorStore,
  PrismaKnowledgeAssetStore,
  PrismaKnowledgeAuditEventWriter,
  PrismaKnowledgeChunkStore,
  PrismaKnowledgeDocumentStore,
  PrismaKnowledgeDocumentVersionStore,
  PrismaKnowledgeEvalDatasetStore,
  PrismaKnowledgeEvalRunStore,
  PrismaKnowledgeIdempotencyStore,
  PrismaKnowledgeJobStore,
  PrismaKnowledgeSpaceStore,
  PrismaKnowledgeUploadSessionStore,
} from "./repositories/prisma-stores.js";
import { InMemoryKnowledgeSpaceStore } from "./repositories/space-store.js";
import { InMemoryKnowledgeUploadSessionStore } from "./repositories/upload-session-store.js";
import { InMemoryKnowledgeEvalDatasetStore } from "./repositories/eval-dataset-store.js";
import { InMemoryKnowledgeEvalRunStore } from "./repositories/eval-run-store.js";
import { createKnowledgeApp } from "./http/app.js";
import { JobsHub } from "./services/JobsHub.js";
import type { KnowledgeServiceConfig } from "./config.js";
import { KnowledgeJobWorker } from "./workers/job-worker.js";
import { KnowledgeGCWorker } from "./workers/gc-worker.js";
import { createIngestProcessor } from "./workers/ingest-processor.js";

export type KnowledgeRuntimeOptions = {
  prisma?: unknown;
  parser?: ParserAdapter;
  parserProvider?: "mock" | "mineru";
  minerU?: { endpoint: string; authToken?: string; timeoutMs?: number };
  embedding?: EmbeddingAdapter;
  embeddingProvider?: "mock" | "bge-m3-ollama";
  ollama?: { endpoint: string; model?: string; timeoutMs?: number };
  vector?: QdrantAdapter;
  vectorProvider?: "in-memory" | "qdrant-http";
  qdrant?: { endpoint: string; collectionName?: string; apiKey?: string; timeoutMs?: number };
  reranker?: RerankAdapter;
  rerankProvider?: "mock" | "tei";
  tei?: { endpoint: string; model?: string; apiKey?: string; timeoutMs?: number };
  fulltext?: FulltextAdapter;
  fulltextProvider?: "in-memory" | "elasticsearch";
  elasticsearch?: { endpoint: string; index?: string; apiKey?: string };
  llm?: LLMAdapter;
  llmProvider?: "mock" | "openai-compatible";
  llmOptions?: { endpoint: string; apiKey: string; model: string; provider?: string; timeoutMs?: number };
  workerConcurrency?: number;
};

export function createKnowledgeRuntime(config: KnowledgeServiceConfig, options: KnowledgeRuntimeOptions = {}) {
  const usePrisma = Boolean(options.prisma);
  const prisma = options.prisma as any;
  const audit = usePrisma ? new PrismaKnowledgeAuditEventWriter(prisma) : new InMemoryKnowledgeAuditEventWriter();
  const acl = usePrisma ? new PrismaKnowledgeAclStore(prisma) : new InMemoryKnowledgeAclStore();
  const documents = usePrisma ? new PrismaKnowledgeDocumentStore(prisma) : new InMemoryKnowledgeDocumentStore();
  const versions = usePrisma ? new PrismaKnowledgeDocumentVersionStore(prisma) : new InMemoryKnowledgeDocumentVersionStore();
  // 唯一 JobsHub:store 在状态转换点 emit jobId ping,T9 会把它传进 createKnowledgeApp 供 SSE 端点订阅。
  const jobsHub = new JobsHub();
  const jobs = usePrisma ? new PrismaKnowledgeJobStore(prisma, jobsHub) : new InMemoryKnowledgeJobStore([], jobsHub);
  const idempotency = usePrisma ? new PrismaKnowledgeIdempotencyStore(prisma) : new InMemoryKnowledgeIdempotencyStore();
  // 对象存储仍走进程内（生产理应换成 S3/MinIO，不应入 MySQL）
  const objects = new InMemoryKnowledgeObjectStore();
  const assets = usePrisma ? new PrismaKnowledgeAssetStore(prisma) : new InMemoryKnowledgeAssetStore();
  const chunkStore = usePrisma ? new PrismaKnowledgeChunkStore(prisma) : new InMemoryKnowledgeChunkStore();
  const anchors = usePrisma ? new PrismaKnowledgeAnchorStore(prisma) : new InMemoryKnowledgeAnchorStore();
  const spaces = usePrisma ? new PrismaKnowledgeSpaceStore(prisma) : new InMemoryKnowledgeSpaceStore();
  const uploads = usePrisma ? new PrismaKnowledgeUploadSessionStore(prisma) : new InMemoryKnowledgeUploadSessionStore();
  const evalDatasets = usePrisma ? new PrismaKnowledgeEvalDatasetStore(prisma) : new InMemoryKnowledgeEvalDatasetStore();
  const evalRuns = usePrisma ? new PrismaKnowledgeEvalRunStore(prisma) : new InMemoryKnowledgeEvalRunStore();
  const parser = resolveParser(options);
  const embedding = resolveEmbedding(options);
  const vector = resolveVector(options);
  const fulltext = resolveFulltext(options);
  const reranker = resolveReranker(options);
  const llm = resolveLLM(options);
  const gcWorker = new KnowledgeGCWorker({
    // scope intentionally omitted — KnowledgeGCWorker.runOnce 在缺省 scope 时走跨租户扫描路径
    // （listDeletedAcrossTenants），每个 space 按自身 source_system_id/tenant_id 构造 per-item
    // scope 后再做 cleanup retry / purge。单租户 GC 仍可显式传 scope 在调用端构造 worker。
    onError: (err) => {
      // 与 job-worker.ts 默认 console.error 一致；后续接 pino logger 时统一替换。
      console.error("[knowledge-gc]", err);
    },
    spaces,
    chunks: chunkStore,
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
    prisma: usePrisma ? (prisma as { $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> }) : null,
    retentionDays: config.gcRetentionDays,
    batchSize: config.gcBatchSize,
    maxAttempts: config.gcMaxAttempts,
  });
  const app = createKnowledgeApp(config, {
    acl,
    audit,
    documents,
    versions,
    jobs,
    idempotency,
    objects,
    spaces,
    uploads,
    chunks: chunkStore,
    vector,
    fulltext,
    embedding,
    reranker,
    llm,
    anchors,
    evalDatasets,
    evalRuns,
    prisma: usePrisma ? prisma : null,
    gcWorker,
    assets,
    // 唯一 JobsHub:与 store（:88）emit 的同一个实例，供 SSE 端点订阅。
    jobsHub,
  });
  const ingestProcessor = createIngestProcessor({
    documents,
    versions,
    objects,
    assets,
    chunks: chunkStore,
    embedding,
    vector,
    fulltext,
    parser,
  });
  const worker = new KnowledgeJobWorker({
    workerId: `knowledge-worker-${process.pid}`,
    store: jobs,
    processors: {
      ingest: ingestProcessor,
    },
    concurrency: options.workerConcurrency
      ?? (process.env["KNOWLEDGE_WORKER_CONCURRENCY"]
        ? Number(process.env["KNOWLEDGE_WORKER_CONCURRENCY"])
        : undefined),
  });
  if (config.gcEnabled) {
    gcWorker.start(config.gcIntervalMs);
  }
  return {
    app,
    worker,
    gcWorker,
    jobsHub,
    parser,
    embedding,
    vector,
    fulltext,
    reranker,
    llm,
    stores: {
      acl,
      anchors,
      assets,
      audit,
      chunks: chunkStore,
      documents,
      versions,
      jobs,
      idempotency,
      objects,
      spaces,
      uploads,
      evalDatasets,
      evalRuns,
    },
  };
}

function resolveEmbedding(options: KnowledgeRuntimeOptions): EmbeddingAdapter {
  if (options.embedding) return options.embedding;
  const provider = options.embeddingProvider
    ?? (process.env["EMBEDDING_PROVIDER"] as "mock" | "bge-m3-ollama" | undefined)
    ?? "mock";
  if (provider === "bge-m3-ollama") {
    const endpoint = options.ollama?.endpoint ?? process.env["OLLAMA_ENDPOINT"];
    if (!endpoint) {
      throw new Error("EMBEDDING_PROVIDER=bge-m3-ollama requires OLLAMA_ENDPOINT");
    }
    return new BgeM3OllamaAdapter({
      endpoint,
      model: options.ollama?.model ?? process.env["OLLAMA_EMBED_MODEL"],
      timeoutMs: options.ollama?.timeoutMs ?? Number(process.env["OLLAMA_TIMEOUT_MS"] ?? 60_000),
    });
  }
  return new MockEmbeddingAdapter();
}

function resolveVector(options: KnowledgeRuntimeOptions): QdrantAdapter {
  if (options.vector) return options.vector;
  const provider = options.vectorProvider
    ?? (process.env["VECTOR_PROVIDER"] as "in-memory" | "qdrant-http" | undefined)
    ?? "in-memory";
  if (provider === "qdrant-http") {
    const endpoint = options.qdrant?.endpoint ?? process.env["QDRANT_ENDPOINT"];
    if (!endpoint) {
      throw new Error("VECTOR_PROVIDER=qdrant-http requires QDRANT_ENDPOINT");
    }
    return new QdrantHttpAdapter({
      endpoint,
      collectionName: options.qdrant?.collectionName ?? process.env["QDRANT_COLLECTION"] ?? "knowledge_chunks",
      apiKey: options.qdrant?.apiKey ?? process.env["QDRANT_API_KEY"],
      timeoutMs: options.qdrant?.timeoutMs ?? Number(process.env["QDRANT_TIMEOUT_MS"] ?? 60_000),
    });
  }
  return new InMemoryQdrantAdapter("knowledge_chunks");
}

function resolveFulltext(options: KnowledgeRuntimeOptions): FulltextAdapter {
  if (options.fulltext) return options.fulltext;
  const provider = options.fulltextProvider
    ?? (process.env["FULLTEXT_PROVIDER"] as "in-memory" | "elasticsearch" | undefined)
    ?? "in-memory";
  if (provider === "elasticsearch") {
    const endpoint = options.elasticsearch?.endpoint ?? process.env["ELASTICSEARCH_ENDPOINT"];
    if (!endpoint) {
      throw new Error("FULLTEXT_PROVIDER=elasticsearch requires ELASTICSEARCH_ENDPOINT");
    }
    return new ElasticsearchAdapter({
      endpoint,
      index: options.elasticsearch?.index ?? process.env["ELASTICSEARCH_INDEX"] ?? "knowledge_chunks",
      apiKey: options.elasticsearch?.apiKey ?? process.env["ELASTICSEARCH_API_KEY"],
    });
  }
  return new InMemoryBM25Adapter();
}

function resolveReranker(options: KnowledgeRuntimeOptions): RerankAdapter {
  if (options.reranker) return options.reranker;
  const provider = options.rerankProvider
    ?? (process.env["RERANK_PROVIDER"] as "mock" | "tei" | undefined)
    ?? "mock";
  if (provider === "tei") {
    const endpoint = options.tei?.endpoint ?? process.env["TEI_RERANK_ENDPOINT"];
    if (!endpoint) {
      throw new Error("RERANK_PROVIDER=tei requires TEI_RERANK_ENDPOINT");
    }
    return new TEIRerankerAdapter({
      endpoint,
      model: options.tei?.model ?? process.env["TEI_RERANK_MODEL"],
      apiKey: options.tei?.apiKey ?? process.env["TEI_RERANK_API_KEY"],
      timeoutMs: options.tei?.timeoutMs
        ?? (process.env["TEI_RERANK_TIMEOUT_MS"] ? Number(process.env["TEI_RERANK_TIMEOUT_MS"]) : undefined),
    });
  }
  return new MockRerankerAdapter();
}

function resolveLLM(options: KnowledgeRuntimeOptions): LLMAdapter {
  if (options.llm) return options.llm;
  const provider = options.llmProvider
    ?? (process.env["LLM_PROVIDER"] as "mock" | "openai-compatible" | undefined)
    ?? "mock";
  if (provider === "openai-compatible") {
    const endpoint = options.llmOptions?.endpoint ?? process.env["LLM_ENDPOINT"];
    const apiKey = options.llmOptions?.apiKey ?? process.env["LLM_API_KEY"];
    const model = options.llmOptions?.model ?? process.env["LLM_MODEL"];
    if (!endpoint) {
      throw new Error("LLM_PROVIDER=openai-compatible requires LLM_ENDPOINT");
    }
    if (!apiKey) {
      throw new Error("LLM_PROVIDER=openai-compatible requires LLM_API_KEY");
    }
    if (!model) {
      throw new Error("LLM_PROVIDER=openai-compatible requires LLM_MODEL");
    }
    return new OpenAICompatibleLLMAdapter({
      endpoint,
      apiKey,
      model,
      provider: options.llmOptions?.provider ?? process.env["LLM_VENDOR"] ?? "minimax",
      timeoutMs: options.llmOptions?.timeoutMs ?? Number(process.env["LLM_TIMEOUT_MS"] ?? 60_000),
    });
  }
  return new MockLLMAdapter();
}

function resolveParser(options: KnowledgeRuntimeOptions): ParserAdapter {
  if (options.parser) return options.parser;
  const provider = options.parserProvider
    ?? (process.env["PARSER_PROVIDER"] as "mock" | "mineru" | undefined)
    ?? "mock";
  if (provider === "mineru") {
    const endpoint = options.minerU?.endpoint ?? process.env["MINERU_HTTP_ENDPOINT"];
    if (!endpoint) {
      throw new Error("PARSER_PROVIDER=mineru requires MINERU_HTTP_ENDPOINT");
    }
    const minerU = new MinerUHttpAdapter({
      endpoint,
      authToken: options.minerU?.authToken ?? process.env["MINERU_AUTH_TOKEN"],
      timeoutMs: options.minerU?.timeoutMs ?? Number(process.env["MINERU_TIMEOUT_MS"] ?? 120_000),
    });
    // 文本类文档（.md/.txt/json/xml…）交给文本解析器，避免被 MinerU 当版面文档拒掉（400）。
    return new RoutingParserAdapter(minerU, new MockParserAdapter());
  }
  return new MockParserAdapter();
}
