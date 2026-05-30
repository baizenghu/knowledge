import { randomUUID } from "node:crypto";

const ID_PREFIXES = new Set([
  "acl",
  "space",
  "doc",
  "ver",
  "asset",
  "chunk",
  "anchor",
  "cite",
  "job",
  "upload",
  "eval",
  "run",
  "evalrun",
  "req",
  "node",
]);

export function createOpaqueId(prefix: string): string {
  if (!ID_PREFIXES.has(prefix)) {
    throw new Error(`unsupported knowledge id prefix: ${prefix}`);
  }
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function isOpaqueKnowledgeId(value: string): boolean {
  return /^[a-z]+_[0-9a-f]{32}$/.test(value);
}
