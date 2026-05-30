import type { CanonicalDocument } from "./canonical.js";

export type ParseInput = {
  body: Buffer;
  filename: string | null;
  mimeType: string | null;
  sourceSha256: string;
  documentId: string;
  versionId: string;
};

export type ParseSuccess = {
  status: "ok";
  document: CanonicalDocument;
};

export type ParseDegraded = {
  status: "degraded";
  document: CanonicalDocument;
  reason: string;
};

export type ParseFailure = {
  status: "failed";
  reason: string;
  retryable: boolean;
};

export type ParseResult = ParseSuccess | ParseDegraded | ParseFailure;

export interface ParserAdapter {
  readonly provider: string;
  readonly version: string;
  parse(input: ParseInput, signal?: AbortSignal): Promise<ParseResult>;
}

export class ParserTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`parser exceeded ${timeoutMs}ms`);
    this.name = "ParserTimeoutError";
  }
}
