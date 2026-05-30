import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeIdempotencyStore } from "./idempotency-store.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("InMemoryKnowledgeIdempotencyStore", () => {
  it("replays same request and rejects conflicts", async () => {
    const store = new InMemoryKnowledgeIdempotencyStore();
    const expiresAt = new Date("2026-05-19T00:00:00.000Z");
    const now = new Date("2026-05-18T00:00:00.000Z");

    expect((await store.begin(scope, "key-1", "POST", "/v1/documents/ingest", { a: 1 }, expiresAt, now)).status)
      .toBe("started");
    await store.complete(scope, "key-1", { ok: true }, "document", "doc_1", now);
    expect((await store.begin(scope, "key-1", "POST", "/v1/documents/ingest", { a: 1 }, expiresAt, now)).status)
      .toBe("replayed");
    expect((await store.begin(scope, "key-1", "POST", "/v1/documents/ingest", { a: 2 }, expiresAt, now)).status)
      .toBe("conflict");
  });
});
