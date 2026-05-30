import { describe, expect, it } from "vitest";
import { createIdempotencyKeyHash, createRequestHash } from "./idempotency.js";

describe("idempotency helpers", () => {
  it("includes source system and tenant in key hash", () => {
    const rawKey = "same-user-key";
    expect(createIdempotencyKeyHash({ sourceSystemId: "octopus-a", tenantId: "tenant-1" }, rawKey))
      .not.toBe(createIdempotencyKeyHash({ sourceSystemId: "octopus-b", tenantId: "tenant-1" }, rawKey));
    expect(createIdempotencyKeyHash({ sourceSystemId: "octopus-a", tenantId: "tenant-1" }, rawKey))
      .not.toBe(createIdempotencyKeyHash({ sourceSystemId: "octopus-a", tenantId: "tenant-2" }, rawKey));
  });

  it("normalizes request method for request hash", () => {
    expect(createRequestHash("post", "/v1/documents/ingest", { a: 1 }))
      .toBe(createRequestHash("POST", "/v1/documents/ingest", { a: 1 }));
  });

  it("canonicalizes object key order for request hash", () => {
    expect(createRequestHash("POST", "/v1/documents/ingest", { b: 2, a: { d: 4, c: 3 } }))
      .toBe(createRequestHash("POST", "/v1/documents/ingest", { a: { c: 3, d: 4 }, b: 2 }));
  });
});
