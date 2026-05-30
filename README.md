# Knowledge Service

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

## Tests

```bash
pnpm test
```
