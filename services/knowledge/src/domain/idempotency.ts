import { sha256Hex } from "@octopus/knowledge-contracts";

export type IdempotencyScope = {
  sourceSystemId: string;
  tenantId: string;
};

export function createIdempotencyKeyHash(scope: IdempotencyScope, rawKey: string): string {
  const normalizedKey = rawKey.trim();
  if (!scope.sourceSystemId.trim()) {
    throw new Error("sourceSystemId is required for idempotency");
  }
  if (!scope.tenantId.trim()) {
    throw new Error("tenantId is required for idempotency");
  }
  if (!normalizedKey) {
    throw new Error("raw idempotency key is required");
  }
  return sha256Hex(`${scope.sourceSystemId}|${scope.tenantId}|${normalizedKey}`);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
}

export function createRequestHash(method: string, path: string, body: unknown): string {
  return sha256Hex(JSON.stringify({
    method: method.trim().toUpperCase(),
    path,
    body: canonicalizeJson(body ?? null),
  }));
}
