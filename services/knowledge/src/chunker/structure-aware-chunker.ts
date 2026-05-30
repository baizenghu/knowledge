/**
 * Structure-aware chunker (M4).
 *
 * Walks a CanonicalDocument in reading order and emits ChunkRecords that
 * align with the knowledge_chunks Prisma model. Headings are folded into
 * downstream chunks as headingPath context; tables and formulas are kept
 * as standalone chunks (they own their citation anchor); other prose
 * nodes are greedily packed up to maxTokens with a token-overlap window.
 */

import { createOpaqueId } from "@octopus/knowledge-contracts";
import type {
  CanonicalBBox,
  CanonicalDocument,
  CanonicalNode,
  CanonicalTable,
} from "../parser/canonical.js";
import { sha256Hex } from "../repositories/object-store.js";

export type ChunkProfile = {
  name: string;
  maxTokens: number;
  overlapTokens: number;
  tableWholeTableFirst: boolean;
};

export const DEFAULT_CHUNK_PROFILE: ChunkProfile = {
  name: "default-v1",
  maxTokens: 512,
  overlapTokens: 64,
  tableWholeTableFirst: true,
};

export type ChunkInput = {
  canonical: CanonicalDocument;
  documentId: string;
  versionId: string;
  versionNumber: number;
  spaceId: string;
  aclHash: string;
  aclVersion: number;
  sourceSystemId: string;
  tenantId: string;
  profile?: ChunkProfile;
};

export type ChunkBBoxRef = {
  nodeId: string;
  page: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
};

export type ChunkRecord = {
  sourceSystemId: string;
  tenantId: string;
  chunkId: string;
  spaceId: string;
  documentId: string;
  versionId: string;
  versionNumber: number;
  chunkIndex: number;
  status: "active" | "shadow";
  text: string;
  textHash: string;
  tokenCount: number;
  nodeIds: string[];
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  bboxRefs: ChunkBBoxRef[];
  aclHash: string;
  aclVersion: number;
  sectionId: string;
  metadata: Record<string, unknown>;
};

/**
 * Section id = stable hash of (versionId, heading_path). Must include
 * versionId so a new version with the same heading_path but different content
 * doesn't collide with the old one. Use "›" as the path separator (rare in
 * heading text) so we don't need percent-encoding.
 */
export function computeSectionId(versionId: string, headingPath: readonly string[]): string {
  const joined = headingPath.join("›");
  return sha256Hex(`${versionId}|${joined}`).slice(0, 32);
}

// CJK 码点区间：表意文字 / 假名 / 谚文 / CJK 标点 / 全角形式 / 扩展区。
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK 符号与标点
  [0x3040, 0x30ff], // 平假名 + 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xff00, 0xffef], // 全角/半角形式
  [0x20000, 0x2ebef], // CJK 扩展 B–F
];

function isCjkCodePoint(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * 估算 token 数。bge-m3 (XLM-RoBERTa / sentencepiece) 下 CJK 字符约 1 字 1 token，
 * 拉丁文本约 4 char/token。旧实现一律 length/4，对中文低估约 4 倍 —— 会让一个名义
 * 512 token 的 chunk 实际逼近 2000 token，叠加大表格整块不拆就冲破 embedding 上下文。
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0)!)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 把目标 token 数换算成该文本的安全字符预算：按文本自身的「字符/token 比例」估
 * （纯中文≈1，纯拉丁≈4）。切分时用它保证 head 真的落在 token 预算内，而不是写死 *4。
 */
function charBudgetForTokens(sampleText: string, tokens: number): number {
  if (tokens <= 0) return 0;
  const est = estimateTokenCount(sampleText);
  const ratio = est > 0 ? sampleText.length / est : 4;
  return Math.max(1, Math.floor(tokens * ratio));
}

type ChunkScaffold = {
  text: string;
  nodeIds: string[];
  headingPath: string[] | null;
  pages: number[];
  bboxRefs: ChunkBBoxRef[];
  metadata: Record<string, unknown>;
};

function emptyScaffold(): ChunkScaffold {
  return {
    text: "",
    nodeIds: [],
    headingPath: null,
    pages: [],
    bboxRefs: [],
    metadata: {},
  };
}

function collectBBoxForNode(node: CanonicalNode): ChunkBBoxRef | null {
  if (!node.bbox) return null;
  const bbox: CanonicalBBox = node.bbox;
  return {
    nodeId: node.nodeId,
    page: bbox.page,
    bbox: { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 },
  };
}

function trackPage(scaffold: ChunkScaffold, node: CanonicalNode): void {
  if (typeof node.page === "number" && Number.isFinite(node.page)) {
    scaffold.pages.push(node.page);
  } else if (node.bbox) {
    scaffold.pages.push(node.bbox.page);
  }
  const bboxRef = collectBBoxForNode(node);
  if (bboxRef) scaffold.bboxRefs.push(bboxRef);
}

function renderTableMarkdown(table: CanonicalTable): string {
  const rows = table.rows ?? [];
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const padRow = (row: string[]): string => {
    const padded = [...row];
    while (padded.length < width) padded.push("");
    return `| ${padded.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
  };
  const lines: string[] = [];
  lines.push(padRow(rows[0]));
  lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  for (let i = 1; i < rows.length; i += 1) {
    lines.push(padRow(rows[i]));
  }
  return lines.join("\n");
}

function takeOverlapSuffix(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const charBudget = charBudgetForTokens(text, overlapTokens);
  if (text.length <= charBudget) return text;
  return text.slice(text.length - charBudget);
}

function finalizeChunk(
  scaffold: ChunkScaffold,
  ctx: ChunkInput,
  chunkIndex: number,
  extraMetadata: Record<string, unknown> = {},
): ChunkRecord {
  const text = scaffold.text;
  const pages = scaffold.pages.filter((page) => typeof page === "number" && Number.isFinite(page));
  const pageStart = pages.length > 0 ? Math.min(...pages) : null;
  const pageEnd = pages.length > 0 ? Math.max(...pages) : null;
  const headingPath = scaffold.headingPath ? [...scaffold.headingPath] : [];
  return {
    sourceSystemId: ctx.sourceSystemId,
    tenantId: ctx.tenantId,
    chunkId: createOpaqueId("chunk"),
    spaceId: ctx.spaceId,
    documentId: ctx.documentId,
    versionId: ctx.versionId,
    versionNumber: ctx.versionNumber,
    chunkIndex,
    status: "active",
    text,
    textHash: sha256Hex(text),
    tokenCount: estimateTokenCount(text),
    nodeIds: [...scaffold.nodeIds],
    headingPath,
    pageStart,
    pageEnd,
    bboxRefs: scaffold.bboxRefs,
    aclHash: ctx.aclHash,
    aclVersion: ctx.aclVersion,
    sectionId: computeSectionId(ctx.versionId, headingPath),
    metadata: { ...scaffold.metadata, ...extraMetadata },
  };
}

export function chunkDocument(input: ChunkInput): ChunkRecord[] {
  const profile = input.profile ?? DEFAULT_CHUNK_PROFILE;
  const { canonical } = input;
  const nodeMap = new Map<string, CanonicalNode>();
  for (const node of canonical.nodes) nodeMap.set(node.nodeId, node);
  const tableMap = new Map<string, CanonicalTable>();
  for (const table of canonical.tables) tableMap.set(table.tableId, table);

  const ordered: CanonicalNode[] = [];
  const order = canonical.readingOrder.length > 0
    ? canonical.readingOrder
    : canonical.nodes.map((n) => n.nodeId);
  for (const id of order) {
    const node = nodeMap.get(id);
    if (node) ordered.push(node);
  }

  const records: ChunkRecord[] = [];
  let chunkIndex = 0;
  let prose = emptyScaffold();

  const flushProse = (carryOverlap = true): void => {
    if (prose.text.length === 0) return;
    const overlapText = carryOverlap ? takeOverlapSuffix(prose.text, profile.overlapTokens) : "";
    records.push(finalizeChunk(prose, input, chunkIndex, { kind: "prose" }));
    chunkIndex += 1;
    const next = emptyScaffold();
    if (overlapText.length > 0) {
      next.text = overlapText;
      next.metadata = { carry_overlap: true };
    }
    prose = next;
  };

  const appendProseNode = (node: CanonicalNode): void => {
    const piece = node.text ?? "";
    if (piece.length === 0) return;
    const candidate = prose.text.length === 0 ? piece : `${prose.text}\n\n${piece}`;
    const candidateTokens = estimateTokenCount(candidate);
    if (prose.text.length > 0 && candidateTokens > profile.maxTokens) {
      flushProse(true);
    }
    if (prose.headingPath === null) prose.headingPath = [...node.headingPath];
    prose.text = prose.text.length === 0
      ? (prose.text + piece)
      : `${prose.text}\n\n${piece}`;
    prose.nodeIds.push(node.nodeId);
    trackPage(prose, node);

    // If this single node by itself overflows, split by characters.
    while (estimateTokenCount(prose.text) > profile.maxTokens && prose.nodeIds.length === 1) {
      const charBudget = Math.max(charBudgetForTokens(prose.text, profile.maxTokens), 1);
      const head = prose.text.slice(0, charBudget);
      const remaining = prose.text.slice(charBudget);
      const overlap = takeOverlapSuffix(head, profile.overlapTokens);
      const headScaffold: ChunkScaffold = {
        ...prose,
        text: head,
        nodeIds: [...prose.nodeIds],
        bboxRefs: [...prose.bboxRefs],
        pages: [...prose.pages],
        headingPath: prose.headingPath ? [...prose.headingPath] : null,
        metadata: { ...prose.metadata },
      };
      records.push(finalizeChunk(headScaffold, input, chunkIndex, { kind: "prose", split: true }));
      chunkIndex += 1;
      prose = emptyScaffold();
      prose.headingPath = headScaffold.headingPath;
      prose.nodeIds = [node.nodeId];
      prose.pages = [...headScaffold.pages];
      prose.bboxRefs = [...headScaffold.bboxRefs];
      prose.text = overlap.length > 0 ? `${overlap}${remaining}` : remaining;
      prose.metadata = overlap.length > 0 ? { carry_overlap: true } : {};
    }
  };

  for (const node of ordered) {
    if (node.type === "heading") {
      // Heading itself does not produce a chunk; flush prose so subsequent
      // text inherits the new heading path on the next node.
      flushProse(false);
      continue;
    }
    if (node.type === "table") {
      flushProse(false);
      const table = node.tableId ? tableMap.get(node.tableId) : undefined;
      const caption = table?.caption ?? null;
      const tableMarkdown = table ? renderTableMarkdown(table) : (node.text ?? "");
      const headerPrefix = caption ? `[Table: ${caption}]\n` : "";
      const fullText = `${headerPrefix}${tableMarkdown}`;
      const tokens = estimateTokenCount(fullText);

      // 整块保留仅当：能放进 maxTokens，或无法按行拆分（无 table / 只有表头一行）。
      // tableWholeTableFirst 不再让超大表格无界整块 —— 否则一张大表 = 一个冲破
      // embedding 上下文的巨型 chunk（本次 Ollama 500 的直接原因）。
      const canRowSplit = !!table && (table.rows?.length ?? 0) > 1;
      if (tokens <= profile.maxTokens || !canRowSplit) {
        const scaffold = emptyScaffold();
        scaffold.text = fullText;
        scaffold.nodeIds = [node.nodeId];
        scaffold.headingPath = [...node.headingPath];
        trackPage(scaffold, node);
        const meta: Record<string, unknown> = {
          kind: "table",
          tableId: node.tableId ?? null,
        };
        if (caption) meta.caption = caption;
        // 拆不动的超大表（单行/巨型单元格）仍整块 emit 并打标；embedding adapter 会兜底截断。
        if (tokens > profile.maxTokens) {
          meta.oversize_table = true;
        }
        records.push(finalizeChunk(scaffold, input, chunkIndex, meta));
        chunkIndex += 1;
      } else {
        // 按行拆分：表头随每个子块重复，子块按 maxTokens 收口。
        const rows = table.rows ?? [];
        if (rows.length === 0) continue;
        const headerRow = rows[0];
        const contextPrefix = caption ? `[Table: ${caption}]\n` : "";
        let buffer: string[][] = [];
        const flushRows = (): void => {
          if (buffer.length === 0) return;
          const md = renderTableMarkdown({ ...table, rows: [headerRow, ...buffer] });
          const text = `${contextPrefix}${md}`;
          const scaffold = emptyScaffold();
          scaffold.text = text;
          scaffold.nodeIds = [node.nodeId];
          scaffold.headingPath = [...node.headingPath];
          trackPage(scaffold, node);
          records.push(
            finalizeChunk(scaffold, input, chunkIndex, {
              kind: "table",
              tableId: node.tableId ?? null,
              split: true,
              caption: caption ?? undefined,
            }),
          );
          chunkIndex += 1;
          buffer = [];
        };
        for (let i = 1; i < rows.length; i += 1) {
          const tentative = [headerRow, ...buffer, rows[i]];
          const tentativeText = `${contextPrefix}${renderTableMarkdown({ ...table, rows: tentative })}`;
          if (buffer.length > 0 && estimateTokenCount(tentativeText) > profile.maxTokens) {
            flushRows();
          }
          buffer.push(rows[i]);
        }
        flushRows();
      }
      continue;
    }
    if (node.type === "formula") {
      flushProse(false);
      const scaffold = emptyScaffold();
      scaffold.text = node.text ?? "";
      scaffold.nodeIds = [node.nodeId];
      scaffold.headingPath = [...node.headingPath];
      trackPage(scaffold, node);
      records.push(
        finalizeChunk(scaffold, input, chunkIndex, {
          kind: "formula",
          formulaId: node.formulaId ?? null,
        }),
      );
      chunkIndex += 1;
      continue;
    }
    if (node.type === "image") {
      flushProse(false);
      const scaffold = emptyScaffold();
      scaffold.text = node.text ?? "";
      scaffold.nodeIds = [node.nodeId];
      scaffold.headingPath = [...node.headingPath];
      trackPage(scaffold, node);
      records.push(
        finalizeChunk(scaffold, input, chunkIndex, {
          kind: "image",
          imageAssetId: node.imageAssetId ?? null,
        }),
      );
      chunkIndex += 1;
      continue;
    }
    // paragraph / list_item / quote / code / caption — pack greedily.
    appendProseNode(node);
  }

  flushProse(false);
  return records;
}
