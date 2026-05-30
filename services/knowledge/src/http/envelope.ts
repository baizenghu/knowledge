import type { Response } from "express";
import { KNOWLEDGE_ERROR_STATUS, type KnowledgeErrorCode } from "@octopus/knowledge-contracts";

export function sendOk<T>(res: Response, data: T, status = 200, meta?: Record<string, unknown>): void {
  res.status(status).json({ ok: true, data, ...(meta ? { meta } : {}) });
}

export function sendError(
  res: Response,
  code: KnowledgeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  const status = KNOWLEDGE_ERROR_STATUS[code] ?? 500;
  res.status(status).json({
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}
