import { createHash } from "node:crypto";
import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbeddingAdapter,
  EmbeddingMetadata,
} from "./embedding-adapter.js";

const DIMENSIONS = 64;

/**
 * Deterministic mock embedder. Given identical input text, this adapter
 * always produces an identical L2-normalized vector. It is intended for
 * unit tests and local development paths that need an embedding signal
 * without contacting a model server.
 */
export class MockEmbeddingAdapter implements EmbeddingAdapter {
  readonly metadata: EmbeddingMetadata = {
    model: "mock-embed",
    version: "1.0.0",
    dimensions: DIMENSIONS,
  };

  async embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult> {
    if (input.signal?.aborted) {
      return { status: "failed", reason: "aborted", retryable: false };
    }
    const vectors = input.texts.map((text) => deterministicVector(text, DIMENSIONS));
    return { status: "ok", vectors, metadata: this.metadata };
  }
}

function deterministicVector(text: string, dimensions: number): number[] {
  // sha256 yields 32 bytes => 8 uint32 chunks. We need `dimensions` floats in
  // [-1, 1]. Each base hash gives us 8 floats; pull additional hashes
  // sha256(text + ":${i}") as needed to cover the remaining dimensions.
  const floats: number[] = [];
  let salt = 0;
  while (floats.length < dimensions) {
    const seed = salt === 0 ? text : `${text}:${salt}`;
    const digest = createHash("sha256").update(seed).digest();
    for (let offset = 0; offset + 4 <= digest.length && floats.length < dimensions; offset += 4) {
      const u32 = digest.readUInt32BE(offset);
      // Map [0, 0xFFFFFFFF] -> [-1, 1].
      const normalized = (u32 / 0xffffffff) * 2 - 1;
      floats.push(normalized);
    }
    salt += 1;
  }
  // L2 normalize so downstream cosine similarity is well-behaved.
  let sumSq = 0;
  for (const f of floats) sumSq += f * f;
  const norm = Math.sqrt(sumSq) || 1;
  return floats.map((f) => f / norm);
}
