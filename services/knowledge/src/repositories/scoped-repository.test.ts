import { describe, expect, it, vi } from "vitest";
import { TenantScopedRepository } from "./scoped-repository.js";

describe("TenantScopedRepository", () => {
  const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };

  it("injects tenant scope into findMany", async () => {
    const findMany = vi.fn(async () => []);
    const repo = new TenantScopedRepository<{ id: string }>({ findMany });
    await repo.findMany(scope, { where: { status: "active" }, orderBy: { createdAt: "desc" } });
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "active", sourceSystemId: "octopus", tenantId: "tenant-1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("injects tenant scope into create data", async () => {
    const create = vi.fn(async (args) => args.data);
    const repo = new TenantScopedRepository<Record<string, unknown>>({ create });
    await repo.create(scope, { documentId: "doc_1" });
    expect(create).toHaveBeenCalledWith({
      data: { documentId: "doc_1", sourceSystemId: "octopus", tenantId: "tenant-1" },
    });
  });

  it("rejects unscoped updates", async () => {
    const updateMany = vi.fn();
    const repo = new TenantScopedRepository<{ id: string }>({ updateMany });
    expect(() => repo.updateMany({ tenantId: "tenant-1" }, { documentId: "doc_1" }, { status: "deleted" }))
      .toThrow(/sourceSystemId/);
  });

  it("injects tenant scope into count, update, upsert, and delete", async () => {
    const count = vi.fn(async () => 1);
    const update = vi.fn(async (args) => args.data);
    const upsert = vi.fn(async (args) => args.create);
    const deleteRecord = vi.fn(async (args) => args.where);
    const repo = new TenantScopedRepository<Record<string, unknown>>({
      count,
      update,
      upsert,
      delete: deleteRecord,
    });

    await repo.count(scope, { where: { status: "active" } });
    await repo.update(scope, { documentId: "doc_1" }, { status: "deleted" });
    await repo.upsert(scope, { documentId: "doc_1" }, { documentId: "doc_1" }, { status: "active" });
    await repo.delete(scope, { documentId: "doc_1" });

    expect(count).toHaveBeenCalledWith({ where: { status: "active", sourceSystemId: "octopus", tenantId: "tenant-1" } });
    expect(update).toHaveBeenCalledWith({
      where: { documentId: "doc_1", sourceSystemId: "octopus", tenantId: "tenant-1" },
      data: { status: "deleted" },
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { documentId: "doc_1", sourceSystemId: "octopus", tenantId: "tenant-1" },
      create: { documentId: "doc_1", sourceSystemId: "octopus", tenantId: "tenant-1" },
      update: { status: "active" },
    });
    expect(deleteRecord).toHaveBeenCalledWith({
      where: { documentId: "doc_1", sourceSystemId: "octopus", tenantId: "tenant-1" },
    });
  });
});
