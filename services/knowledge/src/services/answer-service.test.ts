import { describe, expect, it } from "vitest";
import type { LLMAdapter, LLMRequest, LLMResponse } from "../llm/llm-adapter.js";
import { KnowledgeAnswerService } from "./answer-service.js";
import type { KnowledgeSearchService, SearchHit } from "./search-service.js";

const scope = { sourceSystemId: "octopus", tenantId: "tenant-1" };
const ctx = { tenantId: "tenant-1", userId: "user-1", departments: ["dept-ops"], roles: ["reader"] };

function makeHit(idx: number, anchorId: string): SearchHit {
  return {
    chunkId: `chunk_${idx}`,
    documentId: `doc_${idx}`,
    versionId: "ver_1",
    versionNumber: 1,
    spaceId: "space_1",
    text: `passage ${idx} explaining the topic in detail`.repeat(2),
    headingPath: ["Intro"],
    pageStart: idx,
    pageEnd: idx,
    score: 0.9 - idx * 0.1,
    scores: { rrf: 0.5 },
    anchorId,
  };
}

function fakeSearch(hits: SearchHit[]): KnowledgeSearchService {
  return {
    async search() {
      return { ok: true, data: { hits } };
    },
  } as unknown as KnowledgeSearchService;
}

function fakeLLM(text: string): LLMAdapter {
  return {
    metadata: { provider: "fake", model: "fake-1" },
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      return { status: "ok", text, finishReason: "stop", metadata: { provider: "fake", model: "fake-1" } };
    },
  };
}

describe("KnowledgeAnswerService", () => {
  it("composes an answer and extracts cited anchors from [N] markers", async () => {
    const hits = [makeHit(1, "anchor_alpha"), makeHit(2, "anchor_beta")];
    const search = fakeSearch(hits);
    const llm = fakeLLM("Based on context [1] and partly [2], here is the answer.");
    const service = new KnowledgeAnswerService({ search, llm });
    const result = await service.answer(scope, { query: "what is the topic?" }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.answer).toContain("[1]");
    const anchorIds = result.data.citations.map((c) => c.anchorId);
    expect(anchorIds).toEqual(["anchor_alpha", "anchor_beta"]);
    expect(result.data.citations[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it("returns the no-hits fallback when search yields nothing", async () => {
    const search = fakeSearch([]);
    const llm = fakeLLM("should not be called");
    const service = new KnowledgeAnswerService({ search, llm });
    const result = await service.answer(scope, { query: "anything" }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.citations).toEqual([]);
    expect(result.data.answer.toLowerCase()).toContain("don't have enough information");
    expect(result.data.trace?.degraded?.no_hits).toBe(true);
  });
});
