# Knowledge Service

English | [中文](README.zh-CN.md)

Standalone enterprise knowledge-base service for document ingestion, ACL-aware search, hybrid retrieval, rerank, answer generation, citation resolution, evaluation, and operational metrics.

This repository can be deployed independently. It does not need to run inside the Octopus monorepo.

## Features

- Document spaces, uploads, versioning, ingestion jobs, and reindex jobs
- MinerU-based document parsing for PDFs and layout-heavy documents
- Parser adapter layer with mock and MinerU HTTP implementations
- Embedding adapter layer with mock and BGE-M3 via Ollama implementations
- Vector retrieval with in-memory and Qdrant HTTP adapters
- Full-text retrieval with in-memory BM25 and Elasticsearch adapter boundary
- Rerank adapter layer with mock and TEI-compatible reranker implementations
- OpenAI-compatible LLM answer generation
- Tenant/source scoped ACL filtering and citation anchors
- Prisma/MySQL persistence, with in-memory stores for local development
- Prometheus metrics and SSE job progress events

## Repository Layout

- `services/knowledge`: HTTP API, runtime wiring, ingestion workers, retrieval, answer generation, repositories, and tests.
- `packages/knowledge-contracts`: Shared request signing, auth headers, context, id, status, and error contracts.
- `services/knowledge/prisma`: Standalone Prisma schema and migrations.

## Requirements

- Node.js 22 or newer
- pnpm 9 or newer
- Optional: MySQL 8+ for persistent stores
- Optional: Qdrant, Ollama, TEI, MinerU, and OpenAI-compatible LLM endpoints for production adapters

## Quick Start

```bash
pnpm install
cp services/knowledge/.env.example services/knowledge/.env
pnpm dev
```

The service listens on `KNOWLEDGE_SERVICE_PORT`, defaulting to `8080`.

Without `KNOWLEDGE_DATABASE_URL`, the service uses in-memory stores. This is useful for local development and API smoke tests, but data is lost when the process exits.

## Production Setup

Set at least:

```bash
KNOWLEDGE_SERVICE_PORT=8080
KNOWLEDGE_SERVICE_TOKEN=replace-with-a-strong-token
KNOWLEDGE_SOURCE_SYSTEM_ID=knowledge
KNOWLEDGE_DATABASE_URL=mysql://user:password@host:3306/knowledge
PARSER_PROVIDER=mineru
MINERU_HTTP_ENDPOINT=http://mineru:8000
MINERU_AUTH_TOKEN=replace-if-your-mineru-service-requires-auth
```

Then run:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:migrate
pnpm build
pnpm start
```

## Docker

```bash
docker build -t knowledge-service .
docker run --rm -p 8080:8080 --env-file services/knowledge/.env knowledge-service
```

Run migrations before starting the container when using MySQL:

```bash
pnpm prisma:migrate
```

## MinerU Document Parsing

Set `PARSER_PROVIDER=mineru` to use MinerU for document parsing. In this mode, PDFs and layout-heavy documents are routed to MinerU through `MinerUHttpAdapter`, while plain text-like files are handled by the lightweight text parser fallback.

```bash
PARSER_PROVIDER=mineru
MINERU_HTTP_ENDPOINT=http://mineru:8000
MINERU_AUTH_TOKEN=optional-token
MINERU_TIMEOUT_MS=120000
```

## Adapter Environment Variables

- `EMBEDDING_PROVIDER=mock | bge-m3-ollama`
- `OLLAMA_ENDPOINT`, `OLLAMA_EMBED_MODEL`, `OLLAMA_TIMEOUT_MS`
- `VECTOR_PROVIDER=in-memory | qdrant-http`
- `QDRANT_ENDPOINT`, `QDRANT_COLLECTION`, `QDRANT_API_KEY`
- `FULLTEXT_PROVIDER=in-memory | elasticsearch`
- `ELASTICSEARCH_ENDPOINT`, `ELASTICSEARCH_INDEX`, `ELASTICSEARCH_API_KEY`
- `RERANK_PROVIDER=mock | tei`
- `TEI_RERANK_ENDPOINT`, `TEI_RERANK_MODEL`, `TEI_RERANK_API_KEY`
- `LLM_PROVIDER=mock | openai-compatible`
- `LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_MODEL`
- `PARSER_PROVIDER=mock | mineru`
- `MINERU_HTTP_ENDPOINT`, `MINERU_AUTH_TOKEN`, `MINERU_TIMEOUT_MS`

## Replacing The Document Parser

The parser is intentionally isolated behind `ParserAdapter`, so MinerU can be replaced without changing ingestion, chunking, embedding, search, or citation code.

### Option 1: Replace By Configuration

Use this when the new parser can expose a MinerU-compatible HTTP shape or can be wrapped by a small compatibility service.

1. Keep the knowledge service unchanged.
2. Run an adapter service that accepts the same request style as `MinerUHttpAdapter`.
3. Point the parser endpoint to that adapter:

```bash
PARSER_PROVIDER=mineru
MINERU_HTTP_ENDPOINT=http://your-parser-adapter:8000
MINERU_AUTH_TOKEN=optional-token
```

This is the lowest-risk path for deployment because the knowledge service still receives normalized parser output through the existing MinerU adapter boundary.

### Option 2: Add A Native Parser Adapter

Use this when the replacement parser has its own API or output format.

1. Create a new file under `services/knowledge/src/parser`, for example `docling-adapter.ts` or `unstructured-adapter.ts`.
2. Implement `ParserAdapter` from `parser-adapter.ts`.
3. Convert the parser response into `CanonicalDocument` from `canonical.ts`.
4. Call `validateCanonicalDocument(document)` before returning success.
5. Register the provider in `KnowledgeRuntimeOptions` and `resolveParser()` in `services/knowledge/src/runtime.ts`.
6. Add environment variables, for example:

```bash
PARSER_PROVIDER=docling
DOCLING_ENDPOINT=http://docling:8000
DOCLING_AUTH_TOKEN=optional-token
```

The adapter must preserve these fields for downstream citation and retrieval quality: `nodeId`, `type`, `text`, `headingPath`, `page`, `bbox` or `charSpan`, `readingOrder`, and `markdown`.

### Recommended Rollout

1. Keep MinerU as the default parser for PDF and layout-heavy documents.
2. Add the replacement parser under a new provider name.
3. Run both parsers against the same evaluation dataset.
4. Compare parse success rate, degraded rate, table extraction quality, heading structure, page/bbox citation accuracy, and downstream retrieval recall.
5. Switch `PARSER_PROVIDER` only after the replacement parser matches or exceeds MinerU on the target document set.

## Architecture & Design Notes

This section records *why* the service is shaped the way it is, not just what it
does. The deployment-facing sections above are enough to run it; this section is
for anyone extending or auditing the retrieval quality and security model.
本节记录"为什么这么设计",代码里的关键取舍集中写在这里,方便扩展和审计。

### Layered adapters, resolved at runtime

Every external dependency — parser, embedding, vector store, full-text index,
reranker, LLM — sits behind a narrow adapter interface and is chosen by an env
var in `runtime.ts` (`resolveParser`, `resolveEmbedding`, …). Each has a `mock`
implementation, so the whole service boots and answers API calls with **zero
external infrastructure**; production swaps one component at a time (MinerU,
Ollama, Qdrant, TEI, Elasticsearch, an OpenAI-compatible LLM) without touching
ingestion, chunking, retrieval, or citation code.

— 默认全 `mock`,本地无依赖即可起服务;生产逐个组件替换,核心链路代码不动。

### `CanonicalDocument` is the parser-independence linchpin

Every parser must normalize its output into one schema (`parser/canonical.ts`)
before anything downstream runs. Each node carries enough provenance —
`nodeId`, `headingPath`, `page`, `bbox` or `charSpan`, `readingOrder`,
`markdown` — for a citation to round-trip back to the exact spot in the original
file. `validateCanonicalDocument()` enforces the invariants (unique node ids,
reading order references real nodes, 64-hex source hash) so a buggy parser fails
loudly at ingest instead of silently degrading retrieval. Replacing MinerU means
writing one adapter that emits this shape — nothing else changes.

— Parser 可替换的真正支点不是 HTTP 兼容,而是这个带溯源信息的中间契约。

### Structure-aware chunking with CJK-correct token counting

The chunker walks the document in reading order: headings fold into the
`headingPath` of following chunks, tables and formulas become standalone chunks
that own their citation anchor, and prose is greedily packed to ~512 tokens with
a 64-token overlap.

Token counting is **not** `length / 4`. CJK characters cost roughly one token
each under bge-m3 (sentencepiece), Latin text ~4 chars/token. The old uniform
`length/4` under-counted Chinese ~4×, so a nominal 512-token chunk could reach
~2000 real tokens; combined with whole-table-first chunking, a single large
table became one oversized chunk that blew past the embedding context window —
the direct cause of an Ollama HTTP 500. Oversized tables are now split by rows
(header repeated per sub-chunk); genuinely unsplittable ones are flagged and the
embedding adapter truncates as a backstop.

— 中文 token 估算必须按码点区分 CJK/拉丁,否则大表格直接冲破 embedding 上下文。

### Hybrid retrieval: RRF fusion, then rerank

Recall runs two independent paths — Qdrant (semantic) and BM25 (lexical) — fused
with Reciprocal Rank Fusion (`score = Σ 1/(k + rank)`, `k = 60`). Semantic recall
catches paraphrase; lexical recall catches exact terms, IDs, and rare tokens
embeddings smear. RRF fuses by *rank*, so it needs no score normalization
between the two engines. Top-K (50) candidates are then reranked down to final-K
(10). If embedding fails the query still BM25-retrieves; if either path or the
reranker fails, the request degrades rather than errors, and the `degraded` flags
are returned in the trace.

— 双路召回各补盲区,RRF 按名次融合免去跨引擎分数归一;任一路降级不报错。

### Small-to-Big context expansion

Ranking stays on the **small** chunk (precise, and within the reranker's
512-token input cap), but the text handed to the LLM is widened *after* rerank.
`context.mode` chooses how much: `chunk` (no expansion), `window` (±N siblings by
`chunk_index`, the default), `section` (all chunks sharing a `section_id`), or
`document`. Expansion is budget-clipped (`maxContextTokens`, per-hit) centred on
the best-reranked chunk, and overlapping windows in the same document are merged
into a single fetch. Crucially, the **citation stays anchored to the matched
chunk** (`SearchHit.chunkId`) even though the LLM sees the expanded text — so
retrieval precision and citation stability are decoupled from context size.

— rerank 在小块上保精度,喂 LLM 时再扩窗口修边界截断,引用始终锚回命中的小块。

### ACL: computed at call time, ~30s convergence, defence in depth

Visibility is never baked into the index. On every search the service computes
the set of `acl_hash` values visible to the caller's principal (tenant / user /
department / role, with `effectiveFrom`/`effectiveTo` windows) and pushes that
set into both the vector and full-text filters — so even the **recall** stage
never sees a forbidden chunk. After rerank, each candidate is re-validated
against the live chunk and document record (status, `deleted_at`, visibility) to
defend against indexer/store skew. Because ACL is re-evaluated per call rather
than reindexed, a permission change converges within roughly the time it takes
the principal write to land (~30s) with no reindex. Citation resolution collapses
*every* failure mode — wrong scope, missing anchor, deleted document, no read
permission — to a single `NOT_FOUND`, so anchor ids can't be probed for
existence.

— 权限在调用时现算并下推到召回过滤,改权限约 30s 收敛、无需重建索引;引用失败一律
塌缩成 NOT_FOUND 防探测。

### Ingestion is a job state machine

`ingest-processor.ts` drives a document through `parsing → indexing →
searchable`, persisting the canonical JSON and markdown back into the object
store + asset table so chunking and citation can find them later. The source
SHA-256 is re-verified before parsing (reject if the bytes changed since the job
was accepted). Parser `degraded` results still become searchable but flagged;
`failed` results throw so the worker's retry/backoff handles them, and the
document lands in a terminal `parse_failed` state — without that, the frontend
spins forever on a stuck `parsing`. A `shadow` reindex builds a new version's
chunks alongside the live one for zero-downtime reprocessing.

— 失败必须落到 `parse_failed` 终态,否则前端永远转圈;shadow 重建支持零停机重索引。

### Request signing and tenant scope

Inter-service calls are HMAC-SHA256 signed over a canonical request
(`method + path + sha256(body) + sorted x-octopus-* headers`), compared with
`timingSafeEqual`, with a nonce + timestamp guarding against replay
(`knowledge-contracts/auth.ts`). Every repository call carries a `TenantScope`
(`sourceSystemId` + `tenantId`); no store method can be called without one.

### Persistence split (and one honest gap)

Relational data goes to MySQL via Prisma; vectors live in Qdrant; full-text in
Elasticsearch (or in-memory BM25). The **object store is still in-process**
(`InMemoryKnowledgeObjectStore`) — fine for dev, but it means raw uploads and
parse artifacts are lost on restart. Production must swap this for S3/MinIO; a
failed ingest whose source object was lost will otherwise report "source object
not found" forever.

— 对象存储目前是进程内内存版,生产必须换 S3/MinIO,否则重启即丢原始上传。

## Tests

```bash
pnpm test
```
