# Knowledge Service

Standalone enterprise knowledge-base service for document ingestion, ACL-aware search, hybrid retrieval, rerank, answer generation, citation resolution, evaluation, and operational metrics.

This repository can be deployed independently. It does not need to run inside the Octopus monorepo.

## Features

- Document spaces, uploads, versioning, ingestion jobs, and reindex jobs
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
- `MINERU_ENDPOINT`, `MINERU_AUTH_TOKEN`

## Tests

```bash
pnpm test
```
