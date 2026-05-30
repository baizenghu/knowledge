import type { NextFunction, Request, Response } from "express";
import {
  KNOWLEDGE_AUTH_HEADERS,
  parseBearerToken,
  verifyKnowledgeSignature,
} from "@octopus/knowledge-contracts";
import type { KnowledgeServiceConfig } from "../config.js";
import { sendError } from "./envelope.js";
import type { InMemoryNonceStore } from "./nonce-store.js";

export type RawBodyRequest = Request & { rawBody?: Buffer };

export function createAuthMiddleware(config: KnowledgeServiceConfig, nonceStore: InMemoryNonceStore) {
  return (req: RawBodyRequest, res: Response, next: NextFunction): void => {
    const auth = req.headers[KNOWLEDGE_AUTH_HEADERS.authorization];
    const token = parseBearerToken(Array.isArray(auth) ? auth[0] : auth);
    if (token !== config.serviceToken) {
      sendError(res, "UNAUTHORIZED", "invalid knowledge service token");
      return;
    }

    const timestamp = String(req.headers[KNOWLEDGE_AUTH_HEADERS.timestamp] || "");
    const nonce = String(req.headers[KNOWLEDGE_AUTH_HEADERS.nonce] || "");
    const signature = String(req.headers[KNOWLEDGE_AUTH_HEADERS.signature] || "");
    if (!timestamp || !nonce || !signature) {
      sendError(res, "UNAUTHORIZED", "missing knowledge request signature headers");
      return;
    }

    const requestTime = Date.parse(timestamp);
    if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > config.clockSkewMs) {
      sendError(res, "UNAUTHORIZED", "knowledge request timestamp expired");
      return;
    }

    const tenant = String(req.headers["x-octopus-tenant"] || "");
    const user = String(req.headers["x-octopus-user"] || "");
    if (!tenant || !user) {
      sendError(res, "UNAUTHORIZED", "missing tenant or user context");
      return;
    }

    const nonceKey = `${tenant}:${user}:${nonce}`;
    if (!nonceStore.claim(nonceKey)) {
      sendError(res, "UNAUTHORIZED", "knowledge request nonce replayed");
      return;
    }

    const ok = verifyKnowledgeSignature(
      {
        method: req.method,
        // Signature uses originalUrl; reverse proxies must preserve the same external path seen by the client.
        path: req.originalUrl || req.url,
        body: req.rawBody ?? Buffer.alloc(0),
        headers: req.headers,
      },
      config.serviceToken,
      signature,
    );
    if (!ok) {
      sendError(res, "UNAUTHORIZED", "invalid knowledge request signature");
      return;
    }

    next();
  };
}
