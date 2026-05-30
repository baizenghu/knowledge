import type {
  QdrantAdapter,
  QdrantFilter,
  QdrantPoint,
  QdrantPointPayload,
  QdrantSearchHit,
  QdrantUpsertResult,
} from "./qdrant-adapter.js";

/**
 * In-memory implementation of {@link QdrantAdapter} for unit tests. Supports
 * the subset of Qdrant filters we actually use: `must`/`must_not`/`should`
 * conditions of either `{ key, match: { value } }` or
 * `{ key, match: { any: [...] } }` shape.
 */
export class InMemoryQdrantAdapter implements QdrantAdapter {
  readonly collectionName: string;
  private vectorSize: number | null = null;
  private readonly points: Map<string, QdrantPoint> = new Map();

  constructor(collectionName: string) {
    this.collectionName = collectionName;
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    if (this.vectorSize === null) {
      this.vectorSize = vectorSize;
      return;
    }
    if (this.vectorSize !== vectorSize) {
      throw new Error(
        `qdrant_collection_vector_size_mismatch: existing=${this.vectorSize} requested=${vectorSize}`,
      );
    }
  }

  async upsertPoints(points: QdrantPoint[]): Promise<QdrantUpsertResult> {
    if (this.vectorSize === null) {
      return { status: "failed", reason: "collection_not_initialized", retryable: false };
    }
    for (const point of points) {
      if (point.vector.length !== this.vectorSize) {
        return {
          status: "failed",
          reason: `vector_size_mismatch:${point.vector.length}!=${this.vectorSize}`,
          retryable: false,
        };
      }
    }
    for (const point of points) {
      this.points.set(point.id, point);
    }
    return { status: "ok", written: points.length };
  }

  async searchByVector(
    vector: number[],
    limit: number,
    filter?: QdrantFilter,
  ): Promise<QdrantSearchHit[]> {
    const hits: QdrantSearchHit[] = [];
    for (const point of this.points.values()) {
      if (filter && !matchesFilter(point.payload, filter)) {
        continue;
      }
      const score = cosineSimilarity(vector, point.vector);
      hits.push({ id: point.id, score, payload: point.payload });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async setPayloadByFilter(
    payload: Partial<QdrantPointPayload>,
    filter: QdrantFilter,
  ): Promise<number> {
    let updated = 0;
    for (const [id, point] of this.points) {
      if (!matchesFilter(point.payload, filter)) continue;
      this.points.set(id, {
        ...point,
        payload: { ...point.payload, ...payload },
      });
      updated += 1;
    }
    return updated;
  }

  async deleteByFilter(filter: QdrantFilter): Promise<number> {
    const toDelete: string[] = [];
    for (const [id, point] of this.points) {
      if (matchesFilter(point.payload, filter)) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.points.delete(id);
    }
    return toDelete.length;
  }

  /** Test helper — returns a snapshot of stored points. */
  snapshot(): QdrantPoint[] {
    return Array.from(this.points.values()).map((point) => ({
      id: point.id,
      vector: [...point.vector],
      payload: { ...point.payload },
    }));
  }
}

function matchesFilter(payload: QdrantPointPayload, filter: QdrantFilter): boolean {
  if (filter.must && !filter.must.every((cond) => matchesCondition(payload, cond))) {
    return false;
  }
  if (filter.must_not && filter.must_not.some((cond) => matchesCondition(payload, cond))) {
    return false;
  }
  if (filter.should && filter.should.length > 0) {
    if (!filter.should.some((cond) => matchesCondition(payload, cond))) {
      return false;
    }
  }
  return true;
}

function matchesCondition(
  payload: QdrantPointPayload,
  condition: Record<string, unknown>,
): boolean {
  const key = condition["key"];
  const match = condition["match"];
  if (typeof key !== "string" || match === null || typeof match !== "object") {
    return false;
  }
  const value = (payload as unknown as Record<string, unknown>)[key];
  const matchObj = match as Record<string, unknown>;
  if ("value" in matchObj) {
    return scalarEquals(value, matchObj["value"]);
  }
  if ("any" in matchObj && Array.isArray(matchObj["any"])) {
    return (matchObj["any"] as unknown[]).some((candidate) => scalarEquals(value, candidate));
  }
  return false;
}

function scalarEquals(value: unknown, candidate: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item === candidate);
  }
  return value === candidate;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
