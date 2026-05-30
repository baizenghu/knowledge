import { createIdempotencyKeyHash, createRequestHash, type IdempotencyScope } from "../domain/idempotency.js";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";

export type IdempotencyRecord<T = unknown> = TenantScope & {
  keyHash: string;
  rawKey: string;
  requestHash: string;
  method: string;
  path: string;
  responseJson?: T;
  resourceType?: string | null;
  resourceId?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type IdempotencyReservation<T = unknown> =
  | { status: "started"; record: IdempotencyRecord<T> }
  | { status: "replayed"; record: IdempotencyRecord<T> }
  | { status: "conflict"; record: IdempotencyRecord<T> };

export interface KnowledgeIdempotencyStore {
  begin<T>(scope: IdempotencyScope, rawKey: string, method: string, path: string, body: unknown, expiresAt: Date, now?: Date): Promise<IdempotencyReservation<T>>;
  complete<T>(scope: IdempotencyScope, rawKey: string, responseJson: T, resourceType?: string, resourceId?: string, now?: Date): Promise<IdempotencyRecord<T>>;
}

export class InMemoryKnowledgeIdempotencyStore implements KnowledgeIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async begin<T>(
    scope: IdempotencyScope,
    rawKey: string,
    method: string,
    path: string,
    body: unknown,
    expiresAt: Date,
    now = new Date(),
  ): Promise<IdempotencyReservation<T>> {
    const safeScope = requireTenantScope(scope);
    const keyHash = createIdempotencyKeyHash(safeScope, rawKey);
    const requestHash = createRequestHash(method, path, body);
    const existing = this.records.get(keyHash);
    if (existing && existing.expiresAt.getTime() > now.getTime()) {
      if (existing.requestHash !== requestHash) {
        return { status: "conflict", record: existing as IdempotencyRecord<T> };
      }
      return { status: "replayed", record: existing as IdempotencyRecord<T> };
    }

    const record: IdempotencyRecord = {
      ...safeScope,
      keyHash,
      rawKey: rawKey.trim(),
      requestHash,
      method: method.trim().toUpperCase(),
      path,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(keyHash, record);
    return { status: "started", record: record as IdempotencyRecord<T> };
  }

  async complete<T>(
    scope: IdempotencyScope,
    rawKey: string,
    responseJson: T,
    resourceType?: string,
    resourceId?: string,
    now = new Date(),
  ): Promise<IdempotencyRecord<T>> {
    const safeScope = requireTenantScope(scope);
    const keyHash = createIdempotencyKeyHash(safeScope, rawKey);
    const record = this.records.get(keyHash);
    if (!record) {
      throw new Error("idempotency record not found");
    }
    record.responseJson = responseJson;
    record.resourceType = resourceType;
    record.resourceId = resourceId;
    record.updatedAt = now;
    return { ...record } as IdempotencyRecord<T>;
  }

  snapshot(): IdempotencyRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}
