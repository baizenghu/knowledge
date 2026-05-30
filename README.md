# Octopus Knowledge

This repository contains the exported Octopus enterprise knowledge service.

## Contents

- `services/knowledge`: Knowledge service API, ingestion pipeline, parser adapters, vector/full-text retrieval, rerank, answer generation, observability, and workers.
- `packages/knowledge-contracts`: Shared auth, context, id, status, and error contracts used by the service.
- `services/knowledge/prisma`: Standalone Prisma schema and migrations for persistent knowledge stores.

## Requirements

- Node.js 22 or newer
- pnpm 9 or newer
- Optional: MySQL when `KNOWLEDGE_DATABASE_URL` is configured

## Development

```bash
pnpm install
cp services/knowledge/.env.example services/knowledge/.env
pnpm dev
```

By default the service can run with in-memory stores. Set `KNOWLEDGE_DATABASE_URL` in `services/knowledge/.env` to enable Prisma-backed stores.

## Database

```bash
pnpm prisma:generate
pnpm prisma:migrate
```

## Tests

```bash
pnpm test
```

## Notes

This is a focused export from the Octopus monorepo. Platform integration files outside the knowledge service, such as gateway agent-binding migrations, are not included here.
