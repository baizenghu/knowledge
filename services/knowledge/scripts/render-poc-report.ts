#!/usr/bin/env tsx
/**
 * CLI entry to render the M6 POC acceptance report.
 *
 * Reads a JSON `PocReportInput` from stdin and writes markdown to stdout.
 *
 *   cat run.json | pnpm tsx services/knowledge/scripts/render-poc-report.ts > report.md
 *
 * Date-like fields (run.startedAt / run.finishedAt / generatedAt) accept
 * ISO-8601 strings and are revived into Date instances.
 */

import { renderPocReport, type PocReportInput } from "../src/observability/poc-report.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function reviveDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  return null;
}

function coerce(input: any): PocReportInput {
  if (!input || typeof input !== "object") {
    throw new Error("input must be a JSON object");
  }
  if (!input.run || typeof input.run !== "object") {
    throw new Error("input.run is required");
  }
  input.run.startedAt = reviveDate(input.run.startedAt);
  input.run.finishedAt = reviveDate(input.run.finishedAt);
  if (input.generatedAt !== undefined) {
    input.generatedAt = reviveDate(input.generatedAt) ?? undefined;
  }
  return input as PocReportInput;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error("stdin is empty; expected a JSON PocReportInput");
  }
  const parsed = JSON.parse(raw);
  const input = coerce(parsed);
  const md = renderPocReport(input);
  process.stdout.write(md);
}

main().catch((err) => {
  process.stderr.write(`render-poc-report failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
