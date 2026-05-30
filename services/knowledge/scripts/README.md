# Knowledge POC report

Generate the M6 POC acceptance markdown report from an evaluation run record.

## Usage

```bash
# Inline JSON
echo '{"run":{...},"parseQuality":{...}}' | pnpm tsx services/knowledge/scripts/render-poc-report.ts > report.md

# From a saved run dump
pnpm tsx services/knowledge/scripts/render-poc-report.ts < run-2026-05-18.json
```

Required input fields: `run.runId / run.datasetId / run.config / run.metrics`. Optional: `parseQuality / permission / resourceCost`. See `../src/observability/poc-report.ts` for the full schema.

Date-like fields (`run.startedAt`, `run.finishedAt`, `generatedAt`) accept ISO-8601 strings and are revived into `Date` instances.

The script exits with code `1` on parse / validation errors and writes the diagnostic to stderr.
