import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAclStore } from "../repositories/acl-store.js";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeDocumentStore } from "../repositories/document-store.js";
import { InMemoryKnowledgeIdempotencyStore } from "../repositories/idempotency-store.js";
import { InMemoryKnowledgeJobStore } from "../repositories/job-store.js";
import { KnowledgeDocumentService } from "./document-service.js";
import { KnowledgeAclService } from "./acl-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("KnowledgeAclService", () => {
  it("updates document ACL hash, version, principals, and audit event", async () => {
    const documents = new InMemoryKnowledgeDocumentStore();
    const jobs = new InMemoryKnowledgeJobStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const documentService = new KnowledgeDocumentService({
      documents,
      jobs,
      idempotency: new InMemoryKnowledgeIdempotencyStore(),
      audit,
      spaces: {
        get: async () => ({
          ...scope,
          spaceId: "space_1",
          type: "enterprise",
          name: "Ops",
          ownerType: "tenant",
          ownerId: "tenant-1",
          defaultAcl: { read: [{ type: "tenant", id: "tenant-1" }] },
          status: "active",
          createdBy: "user-1",
          createdAt: new Date("2026-05-18T00:00:00.000Z"),
          updatedAt: new Date("2026-05-18T00:00:00.000Z"),
        }),
        create: async (space) => space,
        list: async () => ({ items: [], nextCursor: null }),
      },
      acl: new InMemoryKnowledgeAclStore(),
    });
    const ingest = await documentService.ingest(scope, { spaceId: "space_1", sourceSha256: "a".repeat(64), createdBy: "user-1" });
    if (!ingest.ok) throw new Error("ingest failed");

    const acl = new InMemoryKnowledgeAclStore();
    const service = new KnowledgeAclService({ acl, documents, audit });
    const result = await service.updateDocumentAcl(scope, {
      documentId: ingest.data.document_id,
      acl: { read: [{ type: "user", id: "user-1" }], admin: [{ type: "user", id: "user-1" }] },
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await documents.get(scope, ingest.data.document_id)).toMatchObject({
      aclHash: result.data.acl_hash,
      aclVersion: 2,
    });
    expect(await acl.listDocumentPrincipals(scope, ingest.data.document_id, 2)).toHaveLength(2);
    expect(audit.snapshot().at(-1)).toMatchObject({ action: "acl.update" });
  });
});
