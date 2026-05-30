import { describe, expect, it, vi } from "vitest";
import { PrismaKnowledgeIdempotencyStore } from "./prisma-stores.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("PrismaKnowledgeIdempotencyStore", () => {
  it("treats unique-key races as idempotent replays instead of 500s", async () => {
    const existing = {
      ...scope,
      keyHash: "hash",
      rawKey: "idem-1",
      requestHash: "",
      method: "POST",
      path: "/v1/documents/ingest",
      responseJson: { document_id: "doc_1" },
      expiresAt: new Date("2026-05-19T00:00:00.000Z"),
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    };
    const prisma = {
      knowledgeIdempotencyKey: {
        create: vi.fn(async (args: any) => {
          existing.keyHash = args.data.keyHash;
          existing.requestHash = args.data.requestHash;
          throw { code: "P2002" };
        }),
        findFirst: vi.fn(async () => existing),
      },
    };
    const store = new PrismaKnowledgeIdempotencyStore(prisma as any);

    const result = await store.begin(scope, "idem-1", "POST", "/v1/documents/ingest", { a: 1 }, existing.expiresAt, existing.createdAt);

    expect(result.status).toBe("replayed");
    expect(prisma.knowledgeIdempotencyKey.findFirst).toHaveBeenCalledWith({
      where: {
        sourceSystemId: "octopus",
        tenantId: "tenant-1",
        keyHash: existing.keyHash,
        expiresAt: { gt: existing.createdAt },
      },
    });
  });
});
