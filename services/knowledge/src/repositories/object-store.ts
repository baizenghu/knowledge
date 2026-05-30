import { createHash } from "node:crypto";
import { requireTenantScope, type TenantScope } from "./tenant-scope.js";

export type StoredObject = {
  uri: string;
  body: Buffer;
  sha256: string;
  sizeBytes: number;
  mimeType?: string | null;
  /**
   * 对象所属空间 id。Phase B GC worker 用它来定位"这个空间名下还有哪些对象"。
   *
   * 历史背景:object_uri 的 schema 是 `mem://.../{sourceSystemId}/{tenantId}/raw/{uploadId}/{filename}`
   * 不包含 spaceId,无法靠 prefix 反推。最小改动是 put 时由 caller(upload-service)显式带入,
   * InMemory 维护一份 spaceId → Set<key> 倒排索引,GC 才能批量删。
   *
   * 为兼容老 caller(没传 spaceId 的路径),字段允许 null;那些对象 GC 无法定位,等同于"无主"
   * 永久保留——这是已知的妥协,会在 listBySpace 注释里点明。
   */
  spaceId?: string | null;
  updatedAt: Date;
};

export type ObjectPutMetadata = {
  mimeType?: string | null;
  now?: Date;
  /** 对象所属空间;Phase B GC 用。caller 应尽量传入。 */
  spaceId?: string | null;
};

export interface KnowledgeObjectStore {
  put(scope: TenantScope, uri: string, body: Buffer, metadata?: ObjectPutMetadata): Promise<StoredObject>;
  get(scope: TenantScope, uri: string): Promise<StoredObject | null>;
  sha256(scope: TenantScope, uri: string): Promise<string | null>;
  /**
   * 列出指定 space 下所有对象 uri(GC 调试/审计用)。
   *
   * 注意:**只能返回 put 时显式带了 spaceId 的对象**;没带 spaceId 的历史对象在这里不可见,
   * 也不会被 deleteBySpaceId 清掉。这是已知缺陷,迁移完成后再考虑改造 uri schema 把 spaceId
   * 编进路径里(届时可去掉倒排索引,直接 prefix match)。
   */
  listBySpace(scope: TenantScope, spaceId: string): Promise<string[]>;
  /**
   * 批量删某空间下所有对象,返回真正删掉的对象数。
   * 不抛错;后端资源端故障应由实现内部 throw,让 GC worker 进入 cleanup pending 状态。
   */
  deleteBySpaceId(scope: TenantScope, spaceId: string): Promise<number>;
}

export class InMemoryKnowledgeObjectStore implements KnowledgeObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  /** spaceKey (sourceSystemId:tenantId:spaceId) → Set<objectKey>;put 时同步维护,delete 时同步剔除。 */
  private readonly spaceIndex = new Map<string, Set<string>>();

  async put(scope: TenantScope, uri: string, body: Buffer, metadata: ObjectPutMetadata = {}): Promise<StoredObject> {
    const key = scopedObjectKey(scope, uri);
    const object: StoredObject = {
      uri,
      body: Buffer.from(body),
      sha256: sha256Hex(body),
      sizeBytes: body.byteLength,
      mimeType: metadata.mimeType ?? null,
      spaceId: metadata.spaceId ?? null,
      updatedAt: metadata.now ?? new Date(),
    };
    // 若同一 key 之前关联到别的 space,先从旧索引剔除,避免脏数据。
    const existing = this.objects.get(key);
    if (existing?.spaceId) {
      this.spaceIndex.get(spaceKey(scope, existing.spaceId))?.delete(key);
    }
    this.objects.set(key, object);
    if (object.spaceId) {
      const sk = spaceKey(scope, object.spaceId);
      let set = this.spaceIndex.get(sk);
      if (!set) {
        set = new Set();
        this.spaceIndex.set(sk, set);
      }
      set.add(key);
    }
    return { ...object, body: Buffer.from(object.body) };
  }

  async get(scope: TenantScope, uri: string): Promise<StoredObject | null> {
    const object = this.objects.get(scopedObjectKey(scope, uri));
    return object ? { ...object, body: Buffer.from(object.body) } : null;
  }

  async sha256(scope: TenantScope, uri: string): Promise<string | null> {
    return this.objects.get(scopedObjectKey(scope, uri))?.sha256 ?? null;
  }

  async listBySpace(scope: TenantScope, spaceId: string): Promise<string[]> {
    const sk = spaceKey(scope, spaceId);
    const keys = this.spaceIndex.get(sk);
    if (!keys) return [];
    const uris: string[] = [];
    for (const key of keys) {
      const obj = this.objects.get(key);
      if (obj) uris.push(obj.uri);
    }
    return uris;
  }

  async deleteBySpaceId(scope: TenantScope, spaceId: string): Promise<number> {
    const sk = spaceKey(scope, spaceId);
    const keys = this.spaceIndex.get(sk);
    if (!keys) return 0;
    let deleted = 0;
    for (const key of keys) {
      if (this.objects.delete(key)) deleted += 1;
    }
    this.spaceIndex.delete(sk);
    return deleted;
  }

  snapshot(): StoredObject[] {
    return [...this.objects.values()].map((object) => ({ ...object, body: Buffer.from(object.body) }));
  }
}

function spaceKey(scope: TenantScope, spaceId: string): string {
  const safe = requireTenantScope(scope);
  return `${safe.sourceSystemId}:${safe.tenantId}:${spaceId}`;
}

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function scopedObjectKey(scope: TenantScope, uri: string): string {
  const safeScope = requireTenantScope(scope);
  assertObjectUriInScope(safeScope, uri);
  return `${safeScope.sourceSystemId}:${safeScope.tenantId}:${uri}`;
}

export function objectUriPrefixForScope(scope: TenantScope, root = "mem://octopus-knowledge"): string {
  const safeScope = requireTenantScope(scope);
  return `${root}/${safeScope.sourceSystemId}/${safeScope.tenantId}/`;
}

export function assertObjectUriInScope(scope: TenantScope, uri: string): void {
  const safeScope = requireTenantScope(scope);
  const marker = `/${safeScope.sourceSystemId}/${safeScope.tenantId}/`;
  if (!uri.includes(marker)) {
    throw new Error("object uri is outside tenant scope");
  }
}
