import { createOpaqueId } from "@octopus/knowledge-contracts";
import type {
  CanonicalBBox,
  CanonicalDocument,
  CanonicalNode,
  CanonicalNodeType,
} from "./canonical.js";
import { validateCanonicalDocument } from "./canonical.js";
import type { ParseInput, ParseResult, ParserAdapter } from "./parser-adapter.js";

export type MinerUHttpAdapterOptions = {
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  authToken?: string;
  backend?: "pipeline" | "vlm-auto-engine" | "hybrid-auto-engine";
  lang?: string;
};

/**
 * Single content list item produced by mineru's `/file_parse` endpoint.
 * The list arrives in reading order so we keep its index as the implicit order.
 */
type MinerUContentItem = {
  type?: "text" | "image" | "table" | "equation" | "code";
  text?: string;
  text_level?: number; // 1..6 when it is a heading; absent for body text
  bbox?: [number, number, number, number];
  page_idx?: number;
  img_path?: string;
  table_body?: string;
  table_caption?: string[];
  table_footnote?: string[];
  latex?: string;
  sub_type?: string;
  code_body?: string;
  code_caption?: string[];
  code_footnote?: string[];
};

type MinerUFileResult = {
  md_content?: string;
  content_list?: string | MinerUContentItem[];
  middle_json?: string | { pdf_info?: Array<Record<string, unknown>>; _version_name?: string };
};

type MinerUResponse = {
  task_id?: string;
  status?: "completed" | "failed" | "processing" | "queued";
  backend?: string;
  error?: string | null;
  version?: string;
  file_names?: string[];
  results?: Record<string, MinerUFileResult>;
};

/**
 * Adapter for the MinerU FastAPI service (`mineru-api`). Calls
 * POST /file_parse with the raw file as multipart/form-data and normalizes
 * the `content_list` array into our Canonical JSON contract.
 *
 * MinerU's `text_level` field signals headings (1..6). Anything without
 * a level is treated as paragraph text. We track an implicit heading stack
 * so each paragraph gets a `headingPath` rooted at the document title.
 */
export class MinerUHttpAdapter implements ParserAdapter {
  readonly provider = "mineru";
  readonly version: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly authToken: string | undefined;
  private readonly backend: string;
  private readonly lang: string;

  constructor(options: MinerUHttpAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.authToken = options.authToken;
    this.backend = options.backend ?? "pipeline";
    this.lang = options.lang ?? "ch";
    this.version = "fastapi-3.x";
  }

  async parse(input: ParseInput, externalSignal?: AbortSignal): Promise<ParseResult> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      const blob = new Blob([input.body], { type: input.mimeType ?? "application/octet-stream" });
      form.append("files", blob, input.filename ?? "upload.bin");
      form.append("backend", this.backend);
      form.append("lang_list", this.lang);
      form.append("return_md", "true");
      form.append("return_content_list", "true");
      form.append("formula_enable", "true");
      form.append("table_enable", "true");

      const headers: Record<string, string> = {};
      if (this.authToken) headers["authorization"] = `Bearer ${this.authToken}`;

      const response = await this.fetchImpl(`${this.endpoint}/file_parse`, {
        method: "POST",
        body: form,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: "failed",
          reason: `mineru_http_${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      const raw = (await response.json()) as MinerUResponse;
      if (raw.status === "failed") {
        return {
          status: "failed",
          reason: `mineru_task_failed:${(raw.error || "unknown").slice(0, 200)}`,
          retryable: false,
        };
      }
      if (raw.status !== "completed") {
        return {
          status: "failed",
          reason: `mineru_unexpected_status:${raw.status}`,
          retryable: true,
        };
      }
      const document = normalizeMinerUResponse(raw, input);
      validateCanonicalDocument(document);
      return { status: "ok", document };
    } catch (error) {
      if (externalSignal?.aborted) {
        return { status: "failed", reason: "aborted", retryable: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted;
      return {
        status: "failed",
        reason: aborted ? "mineru_timeout" : `mineru_error:${message.slice(0, 200)}`,
        retryable: aborted || /ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(message),
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function normalizeMinerUResponse(raw: MinerUResponse, input: ParseInput): CanonicalDocument {
  const fileResult = pickFirstFileResult(raw);
  const markdown = fileResult?.md_content ?? "";
  const items = parseContentList(fileResult?.content_list);
  const pageCount = computePageCount(items, fileResult?.middle_json);

  const nodes: CanonicalNode[] = [];
  const headingStack: string[] = [];
  for (const item of items) {
    const text = deriveItemText(item);
    if (!text) continue;
    const bbox = toBBox(item.page_idx, item.bbox);
    if (item.type === "text" && typeof item.text_level === "number" && item.text_level > 0) {
      const level = Math.max(1, Math.min(6, item.text_level));
      headingStack.length = level - 1;
      headingStack[level - 1] = text;
      nodes.push({
        nodeId: createOpaqueId("node"),
        type: "heading",
        text,
        headingPath: [...headingStack],
        page: (item.page_idx ?? 0) + 1,
        bbox,
        level,
      });
      continue;
    }
    const nodeType: CanonicalNodeType =
      item.type === "table" ? "table"
      : item.type === "equation" ? "formula"
      : item.type === "image" ? "image"
      : item.type === "code" ? "code"
      : "paragraph";
    nodes.push({
      nodeId: createOpaqueId("node"),
      type: nodeType,
      text,
      headingPath: [...headingStack],
      page: (item.page_idx ?? 0) + 1,
      bbox,
    });
  }

  return {
    schemaVersion: "v1",
    sourceFilename: input.filename,
    sourceMimeType: input.mimeType,
    sourceSha256: input.sourceSha256,
    parser: { provider: "mineru", version: raw.version ?? "fastapi" },
    pageCount,
    nodes,
    tables: [],
    formulas: [],
    images: [],
    readingOrder: nodes.map((n) => n.nodeId),
    markdown,
  };
}

function deriveItemText(item: MinerUContentItem): string {
  if (item.text && item.text.trim()) return item.text;
  if (item.type === "table") {
    const caption = (item.table_caption ?? []).filter((s) => s && s.trim()).join("\n");
    const body = item.table_body ? tableHtmlToText(item.table_body) : "";
    const footnote = (item.table_footnote ?? []).filter((s) => s && s.trim()).join("\n");
    const combined = [caption, body, footnote].filter((s) => s.length > 0).join("\n");
    return combined.trim();
  }
  if (item.type === "code") {
    const caption = (item.code_caption ?? []).filter((s) => s && s.trim()).join("\n");
    const body = (item.code_body ?? "").trim();
    const footnote = (item.code_footnote ?? []).filter((s) => s && s.trim()).join("\n");
    const combined = [caption, body, footnote].filter((s) => s.length > 0).join("\n");
    return combined.trim();
  }
  if (item.type === "equation") {
    return (item.latex ?? "").trim();
  }
  return "";
}

/**
 * Extract cell text from a MinerU table_body HTML string (rows of <tr><td>…</td>).
 * Joins cells in a row with " | " and rows with "\n". Strips all other tags
 * and decodes the handful of HTML entities MinerU emits (&amp; &lt; &gt; &quot; &#39; &nbsp;).
 * Not a general HTML parser — MinerU's output is always flat tr/td.
 */
function tableHtmlToText(html: string): string {
  const rows: string[] = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells: string[] = [];
    const inner = rowMatch[1];
    let cellMatch: RegExpExecArray | null;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(inner)) !== null) {
      cells.push(decodeHtmlEntities(stripTags(cellMatch[1])).replace(/\s+/g, " ").trim());
    }
    if (cells.some((c) => c.length > 0)) {
      rows.push(cells.join(" | "));
    }
  }
  if (rows.length > 0) return rows.join("\n");
  // Fallback: not a tr/td table — strip tags entirely so at least cell text survives.
  return decodeHtmlEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function pickFirstFileResult(raw: MinerUResponse): MinerUFileResult | undefined {
  const results = raw.results;
  if (!results) return undefined;
  // file_names order matches the upload order; take the first one.
  const firstName = raw.file_names?.[0];
  if (firstName && results[firstName]) return results[firstName];
  const firstKey = Object.keys(results)[0];
  return firstKey ? results[firstKey] : undefined;
}

function parseContentList(value: string | MinerUContentItem[] | undefined): MinerUContentItem[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function computePageCount(items: MinerUContentItem[], middleJson: MinerUFileResult["middle_json"]): number {
  if (middleJson) {
    const obj = typeof middleJson === "string" ? safeParseJson(middleJson) : middleJson;
    if (obj && Array.isArray(obj.pdf_info)) return obj.pdf_info.length;
  }
  let max = 0;
  for (const it of items) {
    if (typeof it.page_idx === "number" && it.page_idx + 1 > max) max = it.page_idx + 1;
  }
  return max;
}

function safeParseJson(input: string): { pdf_info?: unknown[] } | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function toBBox(pageIdx: number | undefined, bbox: [number, number, number, number] | undefined): CanonicalBBox | null {
  if (!bbox || bbox.length !== 4 || pageIdx === undefined) return null;
  return { page: pageIdx + 1, x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] };
}
