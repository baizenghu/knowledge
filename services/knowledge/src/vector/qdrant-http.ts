import type {
  QdrantAdapter,
  QdrantFilter,
  QdrantPoint,
  QdrantPointPayload,
  QdrantSearchHit,
  QdrantUpsertResult,
} from "./qdrant-adapter.js";

type QdrantSetPayloadRaw = {
  result?: { operation_id?: number; status?: string };
};

export type QdrantHttpAdapterOptions = {
  endpoint: string;
  collectionName: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type QdrantSearchRaw = {
  result?: Array<{
    id?: string | number;
    score?: number;
    payload?: QdrantPointPayload;
  }>;
};

type QdrantCountRaw = {
  result?: { count?: number };
};

/**
 * REST adapter for a real Qdrant server. The HTTP shape follows the
 * documented Qdrant v1 REST API:
 *   - GET    /collections/{name}                  — probe existence
 *   - PUT    /collections/{name}                  — create with vectors config
 *   - PUT    /collections/{name}/points           — upsert
 *   - POST   /collections/{name}/points/search    — vector search
 *   - POST   /collections/{name}/points/count     — count matching filter
 *   - POST   /collections/{name}/points/delete    — delete by filter
 *
 * The error envelope mirrors {@link MinerUHttpAdapter}: 4xx/5xx surface as
 * structured failures and abort/network errors are flagged retryable.
 */
export class QdrantHttpAdapter implements QdrantAdapter {
  readonly collectionName: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QdrantHttpAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.collectionName = options.collectionName;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    const existing = await this.request("GET", `/collections/${this.collectionName}`);
    if (existing.ok) {
      return;
    }
    if (existing.status !== 404) {
      throw new Error(`qdrant_get_collection_failed:${existing.status}`);
    }
    const created = await this.request("PUT", `/collections/${this.collectionName}`, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });
    if (!created.ok) {
      throw new Error(`qdrant_create_collection_failed:${created.status}`);
    }
  }

  async upsertPoints(points: QdrantPoint[]): Promise<QdrantUpsertResult> {
    try {
      // Qdrant only accepts UUID (with hyphens) or unsigned int as point id.
      // Our chunk_id is "chunk_<32hex>" where the 32 hex chars come from
      // randomUUID(). Convert to canonical UUID form on the wire.
      const wirePoints = points.map((p) => ({ ...p, id: toQdrantWireId(p.id) }));
      const response = await this.request(
        "PUT",
        `/collections/${this.collectionName}/points`,
        { points: wirePoints },
      );
      if (response.ok) {
        return { status: "ok", written: points.length };
      }
      return {
        status: "failed",
        reason: `qdrant_http_${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
      };
    } catch (error) {
      return errorToUpsertResult(error);
    }
  }

  async searchByVector(
    vector: number[],
    limit: number,
    filter?: QdrantFilter,
  ): Promise<QdrantSearchHit[]> {
    const response = await this.request(
      "POST",
      `/collections/${this.collectionName}/points/search`,
      {
        vector,
        limit,
        filter,
        with_payload: true,
      },
    );
    if (!response.ok) {
      throw new Error(`qdrant_search_failed:${response.status}`);
    }
    const raw = (await response.json()) as QdrantSearchRaw;
    const result = Array.isArray(raw.result) ? raw.result : [];
    return result
      .filter((hit) => hit && hit.payload && (typeof hit.id === "string" || typeof hit.id === "number"))
      .map((hit) => ({
        id: fromQdrantWireId(String(hit.id)),
        score: typeof hit.score === "number" ? hit.score : 0,
        payload: hit.payload as QdrantPointPayload,
      }));
  }

  /**
   * Qdrant's `points/delete` response only echoes an operation id — it does
   * not return how many points were removed. To honour the {@link QdrantAdapter}
   * contract (returning a count) we issue a `points/count` call beforehand and
   * return that pre-delete count. This is best-effort: under concurrent writes
   * the reported number is an upper bound on what was actually removed.
   */
  /**
   * Issue Qdrant's `POST /collections/{name}/points/payload` (set_payload)
   * with a filter — patches the given keys on every matching point without
   * re-upserting vectors. Returns the number of points that matched the filter
   * (pre-count, same caveat as {@link deleteByFilter}).
   */
  async setPayloadByFilter(
    payload: Partial<QdrantPointPayload>,
    filter: QdrantFilter,
  ): Promise<number> {
    const countResponse = await this.request(
      "POST",
      `/collections/${this.collectionName}/points/count`,
      { filter, exact: true },
    );
    let count = 0;
    if (countResponse.ok) {
      const raw = (await countResponse.json()) as QdrantCountRaw;
      count = typeof raw.result?.count === "number" ? raw.result.count : 0;
    }
    const setResponse = await this.request(
      "POST",
      `/collections/${this.collectionName}/points/payload`,
      { payload, filter },
    );
    if (!setResponse.ok) {
      throw new Error(`qdrant_set_payload_failed:${setResponse.status}`);
    }
    // Touch the typed response so the unused-import lint stays happy and so
    // future error paths can surface operation_id when we need it.
    await setResponse.json().catch(() => ({} as QdrantSetPayloadRaw));
    return count;
  }

  async deleteByFilter(filter: QdrantFilter): Promise<number> {
    const countResponse = await this.request(
      "POST",
      `/collections/${this.collectionName}/points/count`,
      { filter, exact: true },
    );
    let count = 0;
    if (countResponse.ok) {
      const raw = (await countResponse.json()) as QdrantCountRaw;
      count = typeof raw.result?.count === "number" ? raw.result.count : 0;
    }
    const deleteResponse = await this.request(
      "POST",
      `/collections/${this.collectionName}/points/delete`,
      { filter },
    );
    if (!deleteResponse.ok) {
      throw new Error(`qdrant_delete_failed:${deleteResponse.status}`);
    }
    return count;
  }

  private async request(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }
    try {
      return await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Convert an opaque internal id like "chunk_<32hex>" to Qdrant's expected
 * canonical UUID form (with hyphens). The 32-char hex segment from our
 * createOpaqueId() already comes from randomUUID(), so we just re-introduce
 * the hyphens. Anything that already looks like a UUID is returned as-is.
 */
function toQdrantWireId(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id;
  }
  const underscore = id.indexOf("_");
  const hex = underscore >= 0 ? id.slice(underscore + 1) : id;
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return id; // best effort; Qdrant will reject if non-UUID/non-int
}

/**
 * Inverse of {@link toQdrantWireId}. Search results come back with bare UUIDs;
 * the rest of the service uses "chunk_<32hex>". We assume the chunk prefix
 * since that's the only entity we currently upsert to Qdrant.
 */
function fromQdrantWireId(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return `chunk_${id.replaceAll("-", "")}`;
  }
  return id;
}

function errorToUpsertResult(error: unknown): QdrantUpsertResult {
  const message = error instanceof Error ? error.message : String(error);
  const aborted =
    (error instanceof DOMException && error.name === "AbortError") ||
    /abort/i.test(message);
  if (aborted) {
    return { status: "failed", reason: "qdrant_timeout", retryable: true };
  }
  return {
    status: "failed",
    reason: `qdrant_error:${message.slice(0, 200)}`,
    retryable: /ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(message),
  };
}
