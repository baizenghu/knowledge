import { assertTenantScopedWhere, requireTenantScope, withTenantScope, type TenantScope } from "./tenant-scope.js";

type QueryArgs = Record<string, unknown> & { where?: Record<string, unknown> };

export type TenantScopedDelegate<TRecord> = {
  findFirst?: (args: QueryArgs) => Promise<TRecord | null>;
  findMany?: (args: QueryArgs) => Promise<TRecord[]>;
  count?: (args: QueryArgs) => Promise<number>;
  create?: (args: QueryArgs) => Promise<TRecord>;
  update?: (args: QueryArgs) => Promise<TRecord>;
  updateMany?: (args: QueryArgs) => Promise<{ count: number }>;
  upsert?: (args: QueryArgs) => Promise<TRecord>;
  delete?: (args: QueryArgs) => Promise<TRecord>;
};

export class TenantScopedRepository<TRecord> {
  constructor(private readonly delegate: TenantScopedDelegate<TRecord>) {}

  findFirst(scope: Partial<TenantScope>, args: QueryArgs = {}): Promise<TRecord | null> {
    if (!this.delegate.findFirst) {
      throw new Error("findFirst is not supported by this repository delegate");
    }
    const where = withTenantScope(scope, args.where ?? {});
    assertTenantScopedWhere(where);
    return this.delegate.findFirst({ ...args, where });
  }

  findMany(scope: Partial<TenantScope>, args: QueryArgs = {}): Promise<TRecord[]> {
    if (!this.delegate.findMany) {
      throw new Error("findMany is not supported by this repository delegate");
    }
    const where = withTenantScope(scope, args.where ?? {});
    assertTenantScopedWhere(where);
    return this.delegate.findMany({ ...args, where });
  }

  create(scope: Partial<TenantScope>, data: Record<string, unknown>): Promise<TRecord> {
    if (!this.delegate.create) {
      throw new Error("create is not supported by this repository delegate");
    }
    const safeScope = requireTenantScope(scope);
    return this.delegate.create({ data: { ...data, ...safeScope } });
  }

  count(scope: Partial<TenantScope>, args: QueryArgs = {}): Promise<number> {
    if (!this.delegate.count) {
      throw new Error("count is not supported by this repository delegate");
    }
    const where = withTenantScope(scope, args.where ?? {});
    assertTenantScopedWhere(where);
    return this.delegate.count({ ...args, where });
  }

  update(
    scope: Partial<TenantScope>,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<TRecord> {
    if (!this.delegate.update) {
      throw new Error("update is not supported by this repository delegate");
    }
    const scopedWhere = withTenantScope(scope, where);
    assertTenantScopedWhere(scopedWhere);
    return this.delegate.update({ where: scopedWhere, data });
  }

  updateMany(
    scope: Partial<TenantScope>,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<{ count: number }> {
    if (!this.delegate.updateMany) {
      throw new Error("updateMany is not supported by this repository delegate");
    }
    const scopedWhere = withTenantScope(scope, where);
    assertTenantScopedWhere(scopedWhere);
    return this.delegate.updateMany({ where: scopedWhere, data });
  }

  upsert(
    scope: Partial<TenantScope>,
    where: Record<string, unknown>,
    create: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<TRecord> {
    if (!this.delegate.upsert) {
      throw new Error("upsert is not supported by this repository delegate");
    }
    const safeScope = requireTenantScope(scope);
    const scopedWhere = withTenantScope(safeScope, where);
    assertTenantScopedWhere(scopedWhere);
    return this.delegate.upsert({
      where: scopedWhere,
      create: { ...create, ...safeScope },
      update,
    });
  }

  delete(scope: Partial<TenantScope>, where: Record<string, unknown>): Promise<TRecord> {
    if (!this.delegate.delete) {
      throw new Error("delete is not supported by this repository delegate");
    }
    const scopedWhere = withTenantScope(scope, where);
    assertTenantScopedWhere(scopedWhere);
    return this.delegate.delete({ where: scopedWhere });
  }
}
