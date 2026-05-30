import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeEvalDatasetStore, type EvalDatasetRecord } from "./eval-dataset-store.js";

const baseRecord = (overrides: Partial<EvalDatasetRecord> = {}): EvalDatasetRecord => ({
  sourceSystemId: "octopus",
  tenantId: "tenant-1",
  datasetId: "eval_d1",
  name: "qa-v1",
  version: "1.0",
  annotator: "alice",
  samples: [
    { sampleId: "s1", query: "q?", expectedDocumentIds: ["doc_1"] },
  ],
  createdAt: new Date("2026-05-18T00:00:00Z"),
  ...overrides,
});

describe("InMemoryKnowledgeEvalDatasetStore", () => {
  it("creates and gets a dataset within scope", async () => {
    const store = new InMemoryKnowledgeEvalDatasetStore();
    await store.create(baseRecord());
    const got = await store.get({ sourceSystemId: "octopus", tenantId: "tenant-1" }, "eval_d1");
    expect(got?.name).toBe("qa-v1");
    expect(got?.samples).toHaveLength(1);
  });

  it("isolates datasets across tenants", async () => {
    const store = new InMemoryKnowledgeEvalDatasetStore();
    await store.create(baseRecord());
    const crossTenant = await store.get({ sourceSystemId: "octopus", tenantId: "tenant-2" }, "eval_d1");
    expect(crossTenant).toBeNull();
    const crossSource = await store.get({ sourceSystemId: "other", tenantId: "tenant-1" }, "eval_d1");
    expect(crossSource).toBeNull();
    const listForOther = await store.list({ sourceSystemId: "octopus", tenantId: "tenant-2" });
    expect(listForOther).toEqual([]);
  });
});
