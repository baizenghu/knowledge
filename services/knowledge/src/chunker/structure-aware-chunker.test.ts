import { describe, expect, it } from "vitest";
import { createOpaqueId } from "@octopus/knowledge-contracts";
import { MockParserAdapter } from "../parser/mock-parser.js";
import type {
  CanonicalDocument,
  CanonicalNode,
  CanonicalTable,
} from "../parser/canonical.js";
import { sha256Hex } from "../repositories/object-store.js";
import {
  DEFAULT_CHUNK_PROFILE,
  chunkDocument,
  computeSectionId,
  estimateTokenCount,
} from "./structure-aware-chunker.js";

const BASE_CTX = {
  documentId: "doc_test0000000000000000000000001",
  versionId: "ver_test0000000000000000000000001",
  versionNumber: 1,
  spaceId: "space_test000000000000000000000001",
  aclHash: "a".repeat(64),
  aclVersion: 1,
  sourceSystemId: "octopus",
  tenantId: "tenant-a",
};

describe("chunkDocument (structure-aware)", () => {
  it("chunks a markdown document with headings and paragraphs", async () => {
    const parser = new MockParserAdapter();
    const md = [
      "# Title",
      "",
      "Intro paragraph about the document.",
      "",
      "## Section A",
      "",
      "Some content under section A which is short.",
      "",
      "## Section B",
      "",
      "Another paragraph under section B.",
      "",
    ].join("\n");
    const result = await parser.parse({
      filename: "doc.md",
      mimeType: "text/markdown",
      body: Buffer.from(md, "utf8"),
      sourceSha256: sha256Hex(md),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("parser failed");
    const chunks = chunkDocument({ ...BASE_CTX, canonical: result.document });
    expect(chunks.length).toBeGreaterThan(0);
    // chunkIndex contiguous
    for (let i = 0; i < chunks.length; i += 1) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
    // distinct textHash
    const hashes = new Set(chunks.map((c) => c.textHash));
    expect(hashes.size).toBe(chunks.length);
    // headingPath captured for content after the heading
    const sectionAChunk = chunks.find((c) => c.text.includes("section A"));
    expect(sectionAChunk?.headingPath).toEqual(["Title", "Section A"]);
    const sectionBChunk = chunks.find((c) => c.text.includes("section B"));
    expect(sectionBChunk?.headingPath).toEqual(["Title", "Section B"]);
    // tenant scope preserved
    for (const c of chunks) {
      expect(c.sourceSystemId).toBe(BASE_CTX.sourceSystemId);
      expect(c.tenantId).toBe(BASE_CTX.tenantId);
      expect(c.aclHash).toBe(BASE_CTX.aclHash);
      expect(c.sectionId).toBeTruthy();
    }
    // 同 heading_path 的 chunk 必须落在同一个 sectionId
    if (sectionAChunk) {
      expect(sectionAChunk.sectionId).toBe(computeSectionId(BASE_CTX.versionId, sectionAChunk.headingPath));
    }
    if (sectionBChunk) {
      expect(sectionBChunk.sectionId).not.toBe(sectionAChunk?.sectionId);
    }
  });

  it("computeSectionId 不同 versionId 同 heading_path 不会撞车", () => {
    const a = computeSectionId("ver_1", ["Title", "Section A"]);
    const b = computeSectionId("ver_2", ["Title", "Section A"]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("computeSectionId 同 versionId 不同 heading_path 不会撞车", () => {
    const a = computeSectionId("ver_1", ["Title", "Section A"]);
    const b = computeSectionId("ver_1", ["Title", "Section B"]);
    expect(a).not.toBe(b);
  });

  it("splits long paragraphs with character-level overlap between adjacent chunks", () => {
    const profile = {
      name: "small",
      maxTokens: 50,
      overlapTokens: 10,
      tableWholeTableFirst: true,
    };
    const longText = Array.from({ length: 60 }, (_, i) => `sentence-${i}-padding-words-here-aaaaaa`).join(" ");
    const node: CanonicalNode = {
      nodeId: createOpaqueId("node"),
      type: "paragraph",
      text: longText,
      headingPath: ["Root"],
      page: 1,
    };
    const canonical: CanonicalDocument = {
      schemaVersion: "v1",
      sourceFilename: "long.txt",
      sourceMimeType: "text/plain",
      sourceSha256: sha256Hex(longText),
      parser: { provider: "mock", version: "1.0.0" },
      pageCount: 1,
      nodes: [node],
      tables: [],
      formulas: [],
      images: [],
      readingOrder: [node.nodeId],
      markdown: longText,
    };
    const chunks = chunkDocument({ ...BASE_CTX, canonical, profile });
    expect(chunks.length).toBeGreaterThan(1);
    // Verify overlap: every chunk after the first begins with the trailing
    // overlap of the previous chunk. 字符预算按文本自身的字符/token 比例换算
    // （charBudgetForTokens），纯拉丁文本下 ≈ overlapTokens*4，但会随 ceil 取整微调。
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1].text;
      const ratio = prev.length / Math.max(1, Math.ceil(prev.length / 4));
      const overlapChars = Math.max(1, Math.floor(profile.overlapTokens * ratio));
      const expectedOverlap = prev.slice(prev.length - overlapChars);
      expect(chunks[i].text.startsWith(expectedOverlap)).toBe(true);
      expect(chunks[i].metadata.carry_overlap).toBe(true);
    }
    // every chunk should respect maxTokens (allowing the overlap that may
    // push it slightly; the splitter trims to maxTokens*4 chars on the head)
    expect(chunks[0].tokenCount).toBeLessThanOrEqual(profile.maxTokens);
  });

  it("emits a table chunk that preserves the whole table and tags metadata.kind=table", () => {
    const table: CanonicalTable = {
      tableId: "table-1",
      rows: [
        ["Name", "Value"],
        ["alpha", "1"],
        ["beta", "2"],
      ],
      page: 3,
      caption: "Sample numbers",
    };
    const introId = createOpaqueId("node");
    const tableNodeId = createOpaqueId("node");
    const trailingId = createOpaqueId("node");
    const canonical: CanonicalDocument = {
      schemaVersion: "v1",
      sourceFilename: "tab.md",
      sourceMimeType: "text/markdown",
      sourceSha256: sha256Hex("table"),
      parser: { provider: "mock", version: "1.0.0" },
      pageCount: 3,
      nodes: [
        {
          nodeId: introId,
          type: "paragraph",
          text: "Before the table.",
          headingPath: ["Doc"],
          page: 2,
        },
        {
          nodeId: tableNodeId,
          type: "table",
          text: "",
          headingPath: ["Doc"],
          page: 3,
          tableId: "table-1",
        },
        {
          nodeId: trailingId,
          type: "paragraph",
          text: "After the table.",
          headingPath: ["Doc"],
          page: 4,
        },
      ],
      tables: [table],
      formulas: [],
      images: [],
      readingOrder: [introId, tableNodeId, trailingId],
      markdown: "",
    };
    const chunks = chunkDocument({ ...BASE_CTX, canonical });
    const tableChunks = chunks.filter((c) => c.metadata.kind === "table");
    expect(tableChunks).toHaveLength(1);
    const tableChunk = tableChunks[0];
    expect(tableChunk.nodeIds).toEqual([tableNodeId]);
    expect(tableChunk.text).toContain("[Table: Sample numbers]");
    expect(tableChunk.text).toContain("| Name | Value |");
    expect(tableChunk.text).toContain("| alpha | 1 |");
    expect(tableChunk.text).toContain("| beta | 2 |");
    expect(tableChunk.pageStart).toBe(3);
    expect(tableChunk.pageEnd).toBe(3);
    expect(tableChunk.metadata.tableId).toBe("table-1");
    // surrounding paragraphs should land in separate prose chunks
    const proseChunks = chunks.filter((c) => c.metadata.kind === "prose");
    expect(proseChunks.length).toBeGreaterThanOrEqual(2);
  });

  it("estimateTokenCount 中文按 ~1 字 1 token（不再 length/4 低估）", () => {
    const zh = "应付账款京州高新技术产业开发区城管园林局"; // 20 个汉字
    // 旧实现 = ceil(20/4)=5，会让中文 chunk token 严重低估；新实现应 ≈ 字数。
    expect(estimateTokenCount(zh)).toBe(zh.length);
    expect(estimateTokenCount("abcdefgh")).toBe(2); // 纯拉丁仍按 ~4 char/token
    expect(estimateTokenCount("中文abcd")).toBe(2 + 1); // 2 汉字 + 4 拉丁/4
  });

  it("超大中文表格按行拆分，每块落在 maxTokens 内，不再整块冲破上下文", () => {
    const profile = { name: "small", maxTokens: 50, overlapTokens: 10, tableWholeTableFirst: true };
    // 40 行中文 → 整表 token 远超 maxTokens=50，必须按行拆分。
    const rows: string[][] = [["项目", "金额说明"]];
    for (let i = 0; i < 40; i += 1) {
      rows.push([`应付账款明细项目第${i}号`, `京州高新技术产业开发区城管园林局金额${i}`]);
    }
    const table: CanonicalTable = { tableId: "t-big", rows, page: 1, caption: "应付账款" };
    const tableNodeId = createOpaqueId("node");
    const canonical: CanonicalDocument = {
      schemaVersion: "v1",
      sourceFilename: "big.md",
      sourceMimeType: "text/markdown",
      sourceSha256: sha256Hex("big-table"),
      parser: { provider: "mock", version: "1.0.0" },
      pageCount: 1,
      nodes: [{ nodeId: tableNodeId, type: "table", text: "", headingPath: ["Doc"], page: 1, tableId: "t-big" }],
      tables: [table],
      formulas: [],
      images: [],
      readingOrder: [tableNodeId],
      markdown: "",
    };
    const tableChunks = chunkDocument({ ...BASE_CTX, canonical, profile }).filter((c) => c.metadata.kind === "table");
    expect(tableChunks.length).toBeGreaterThan(1); // 拆成了多块
    for (const c of tableChunks) {
      expect(c.metadata.split).toBe(true);
      expect(c.metadata.oversize_table).toBeUndefined(); // 没有无界整块
      expect(c.tokenCount).toBeLessThanOrEqual(profile.maxTokens);
    }
  });

  it("emits a standalone formula chunk", () => {
    const para1 = createOpaqueId("node");
    const formulaNode = createOpaqueId("node");
    const para2 = createOpaqueId("node");
    const canonical: CanonicalDocument = {
      schemaVersion: "v1",
      sourceFilename: "math.md",
      sourceMimeType: "text/markdown",
      sourceSha256: sha256Hex("math"),
      parser: { provider: "mock", version: "1.0.0" },
      pageCount: 1,
      nodes: [
        { nodeId: para1, type: "paragraph", text: "Lead-in.", headingPath: [], page: 1 },
        {
          nodeId: formulaNode,
          type: "formula",
          text: "E = mc^2",
          headingPath: [],
          page: 1,
          formulaId: "f1",
        },
        { nodeId: para2, type: "paragraph", text: "Tail-out.", headingPath: [], page: 1 },
      ],
      tables: [],
      formulas: [{ formulaId: "f1", latex: "E = mc^2", page: 1 }],
      images: [],
      readingOrder: [para1, formulaNode, para2],
      markdown: "",
    };
    const chunks = chunkDocument({ ...BASE_CTX, canonical });
    const formulaChunks = chunks.filter((c) => c.metadata.kind === "formula");
    expect(formulaChunks).toHaveLength(1);
    expect(formulaChunks[0].nodeIds).toEqual([formulaNode]);
    expect(formulaChunks[0].text).toBe("E = mc^2");
    expect(formulaChunks[0].metadata.formulaId).toBe("f1");
    // chunkIndex contiguous
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it("estimateTokenCount approximates length/4", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("a".repeat(17))).toBe(5);
    expect(DEFAULT_CHUNK_PROFILE.maxTokens).toBe(512);
  });
});
