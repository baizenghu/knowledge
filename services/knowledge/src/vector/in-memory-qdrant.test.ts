import { describe, expect, it } from "vitest";
import { InMemoryQdrantAdapter } from "./in-memory-qdrant.js";
import type { QdrantPoint, QdrantPointPayload } from "./qdrant-adapter.js";

function basePayload(overrides: Partial<QdrantPointPayload> = {}): QdrantPointPayload {
  return {
    source_system_id: "sys-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    document_id: "doc-1",
    document_version_id: "ver-1",
    document_version_number: 1,
    acl_hash: "acl-1",
    acl_version: 1,
    status: "active",
    deleted_at: null,
    tags: [],
    document_type: "markdown",
    time: "2026-05-18T00:00:00.000Z",
    chunk_index: 0,
    heading_path: [],
    page_start: null,
    page_end: null,
    ...overrides,
  };
}

function pt(id: string, vector: number[], payload: Partial<QdrantPointPayload> = {}): QdrantPoint {
  return { id, vector, payload: basePayload(payload) };
}

describe("InMemoryQdrantAdapter", () => {
  it("upserts points and returns cosine-sorted top-K", async () => {
    const adapter = new InMemoryQdrantAdapter("test");
    await adapter.ensureCollection(3);
    const result = await adapter.upsertPoints([
      pt("a", [1, 0, 0]),
      pt("b", [0.9, 0.1, 0]),
      pt("c", [0, 1, 0]),
    ]);
    expect(result.status).toBe("ok");
    const hits = await adapter.searchByVector([1, 0, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].id).toBe("a");
    expect(hits[1].id).toBe("b");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("isolates tenants via must value filter", async () => {
    const adapter = new InMemoryQdrantAdapter("test");
    await adapter.ensureCollection(2);
    await adapter.upsertPoints([
      pt("a", [1, 0], { tenant_id: "tenant-1" }),
      pt("b", [0.99, 0.01], { tenant_id: "tenant-2" }),
      pt("c", [0.95, 0.05], { tenant_id: "tenant-1" }),
    ]);
    const hits = await adapter.searchByVector([1, 0], 5, {
      must: [{ key: "tenant_id", match: { value: "tenant-1" } }],
    });
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "c"]);
  });

  it("filters via match.any over scalar payload field", async () => {
    const adapter = new InMemoryQdrantAdapter("test");
    await adapter.ensureCollection(2);
    await adapter.upsertPoints([
      pt("a", [1, 0], { document_type: "pdf" }),
      pt("b", [1, 0], { document_type: "markdown" }),
      pt("c", [1, 0], { document_type: "html" }),
    ]);
    const hits = await adapter.searchByVector([1, 0], 5, {
      must: [{ key: "document_type", match: { any: ["pdf", "markdown"] } }],
    });
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });

  it("setPayloadByFilter patches matching points and returns the count", async () => {
    const adapter = new InMemoryQdrantAdapter("test");
    await adapter.ensureCollection(2);
    await adapter.upsertPoints([
      pt("a", [1, 0], { document_version_id: "ver-2", status: "shadow" }),
      pt("b", [1, 0], { document_version_id: "ver-2", status: "shadow" }),
      pt("c", [1, 0], { document_version_id: "ver-1", status: "active" }),
    ]);
    const updated = await adapter.setPayloadByFilter(
      { status: "active" },
      { must: [{ key: "document_version_id", match: { value: "ver-2" } }] },
    );
    expect(updated).toBe(2);
    const snapshot = adapter.snapshot();
    expect(snapshot.find((p) => p.id === "a")?.payload.status).toBe("active");
    expect(snapshot.find((p) => p.id === "b")?.payload.status).toBe("active");
    expect(snapshot.find((p) => p.id === "c")?.payload.status).toBe("active");
  });

  it("deletes by acl_hash filter and returns the removed count", async () => {
    const adapter = new InMemoryQdrantAdapter("test");
    await adapter.ensureCollection(2);
    await adapter.upsertPoints([
      pt("a", [1, 0], { acl_hash: "stale" }),
      pt("b", [1, 0], { acl_hash: "stale" }),
      pt("c", [1, 0], { acl_hash: "fresh" }),
    ]);
    const removed = await adapter.deleteByFilter({
      must: [{ key: "acl_hash", match: { value: "stale" } }],
    });
    expect(removed).toBe(2);
    expect(adapter.snapshot().map((p) => p.id)).toEqual(["c"]);
  });
});
