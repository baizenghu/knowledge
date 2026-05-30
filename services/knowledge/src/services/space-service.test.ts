import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeAuditEventWriter } from "../repositories/audit-events.js";
import { InMemoryKnowledgeSpaceStore } from "../repositories/space-store.js";
import { KnowledgeSpaceService } from "./space-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

describe("KnowledgeSpaceService", () => {
  it("creates and lists tenant-scoped spaces", async () => {
    const spaces = new InMemoryKnowledgeSpaceStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const service = new KnowledgeSpaceService({ spaces, audit });

    const created = await service.createSpace(scope, {
      type: "department",
      name: "Ops",
      ownerType: "department",
      ownerId: "dept-ops",
      createdBy: "user-1",
    });
    const listed = await service.listSpaces(scope, { type: "department" });

    expect(created.ok).toBe(true);
    expect(listed.ok && listed.data.items).toHaveLength(1);
    expect(audit.snapshot()[0]).toMatchObject({ action: "space.create" });
  });

  it("filters by three-tier visibility when context is provided", async () => {
    const spaces = new InMemoryKnowledgeSpaceStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const service = new KnowledgeSpaceService({ spaces, audit });

    await service.createSpace(scope, { type: "enterprise", name: "Corp", ownerType: "tenant", createdBy: "admin" });
    await service.createSpace(scope, { type: "department", name: "Dev", ownerType: "department", ownerId: "dept-dev", createdBy: "alice" });
    await service.createSpace(scope, { type: "department", name: "Sales", ownerType: "department", ownerId: "dept-sales", createdBy: "bob" });
    await service.createSpace(scope, { type: "personal", name: "Alice 笔记", ownerType: "user", ownerId: "alice", createdBy: "alice" });
    await service.createSpace(scope, { type: "personal", name: "Bob 笔记", ownerType: "user", ownerId: "bob", createdBy: "bob" });

    const aliceView = await service.listSpaces(scope, {}, { userId: "alice", departments: ["dept-dev"], roles: [] });
    expect(aliceView.ok && aliceView.data.items.map((it: any) => it.name).sort()).toEqual(["Alice 笔记", "Corp", "Dev"]);

    const bobView = await service.listSpaces(scope, {}, { userId: "bob", departments: ["dept-sales"], roles: [] });
    expect(bobView.ok && bobView.data.items.map((it: any) => it.name).sort()).toEqual(["Bob 笔记", "Corp", "Sales"]);

    const editorView = await service.listSpaces(scope, {}, { userId: "ops", departments: [], roles: ["knowledge_editor"] });
    expect(editorView.ok && editorView.data.items).toHaveLength(5);
  });

  it("returns all spaces when no context provided (backward compat)", async () => {
    const spaces = new InMemoryKnowledgeSpaceStore();
    const audit = new InMemoryKnowledgeAuditEventWriter();
    const service = new KnowledgeSpaceService({ spaces, audit });
    await service.createSpace(scope, { type: "personal", name: "P", ownerType: "user", ownerId: "x", createdBy: "x" });
    const view = await service.listSpaces(scope, {});
    expect(view.ok && view.data.items).toHaveLength(1);
  });

  it("rejects spaces without names", async () => {
    const service = new KnowledgeSpaceService({
      spaces: new InMemoryKnowledgeSpaceStore(),
      audit: new InMemoryKnowledgeAuditEventWriter(),
    });

    expect(await service.createSpace(scope, { createdBy: "user-1" })).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });
});
