import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const KNOWLEDGE_AUTH_HEADERS = {
  authorization: "authorization",
  timestamp: "x-octopus-timestamp",
  nonce: "x-octopus-nonce",
  signature: "x-octopus-signature",
} as const;

export type HeaderBag = Record<string, string | string[] | undefined>;

export type KnowledgeSignatureInput = {
  method: string;
  path: string;
  body: string | Buffer;
  headers: HeaderBag;
};

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(",").trim();
  }
  return value?.trim() ?? "";
}

export function normalizeHeaders(headers: HeaderBag): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = normalizeHeaderValue(value);
  }
  return normalized;
}

export function buildSignedHeaderBlock(headers: HeaderBag): string {
  const normalized = normalizeHeaders(headers);
  return Object.entries(normalized)
    .filter(([key]) => key.startsWith("x-octopus-") && key !== KNOWLEDGE_AUTH_HEADERS.signature)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
}

export function buildCanonicalRequest(input: KnowledgeSignatureInput): string {
  const method = input.method.trim().toUpperCase();
  const path = input.path.trim() || "/";
  const bodyHash = sha256Hex(input.body);
  const signedHeaders = buildSignedHeaderBlock(input.headers);
  return `${method}\n${path}\n${bodyHash}\n${signedHeaders}`;
}

export function signKnowledgeRequest(input: KnowledgeSignatureInput, secret: string): string {
  return createHmac("sha256", secret).update(buildCanonicalRequest(input)).digest("base64url");
}

export function verifyKnowledgeSignature(
  input: KnowledgeSignatureInput,
  secret: string,
  signature: string | undefined,
): boolean {
  if (!signature) {
    return false;
  }
  const expected = signKnowledgeRequest(input, secret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function parseBearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
