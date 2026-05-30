import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAuditEventWriter } from "./audit-events.js";

describe("InMemoryKnowledgeAuditEventWriter", () => {
  it("requires tenant scope and records events", async () => {
    const writer = new InMemoryKnowledgeAuditEventWriter();
    await writer.write({
      sourceSystemId: "octopus",
      tenantId: "tenant-1",
      action: "ingest",
      resourceType: "document",
      resourceId: "doc_1",
    });

    expect(writer.snapshot()).toHaveLength(1);
    await expect(writer.write({
      sourceSystemId: "",
      tenantId: "tenant-1",
      action: "ingest",
    })).rejects.toThrow(/sourceSystemId/);
  });

  it("supports batch writes and truncates oversized details", async () => {
    const writer = new InMemoryKnowledgeAuditEventWriter({ maxDetailsBytes: 32 });
    await writer.writeMany([
      {
        sourceSystemId: "octopus",
        tenantId: "tenant-1",
        action: "ingest",
        details: { large: "x".repeat(100) },
      },
    ]);

    expect(writer.snapshot()[0]?.details).toEqual({
      truncated: true,
      original_bytes: 112,
    });
  });
});
