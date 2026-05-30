export const KNOWLEDGE_ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  CONTENT_HASH_MISMATCH: 422,
  PARSER_INPUT_UNSUPPORTED: 422,
  RATE_LIMITED: 429,
  PARSER_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
} as const;

export type KnowledgeErrorCode = keyof typeof KNOWLEDGE_ERROR_STATUS;

export type KnowledgeError = {
  code: KnowledgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type KnowledgeResponse<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error: KnowledgeError; meta?: Record<string, unknown> };
