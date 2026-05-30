import { createOpaqueId } from "@octopus/knowledge-contracts";
import type { CanonicalDocument, CanonicalNode } from "./canonical.js";
import { validateCanonicalDocument } from "./canonical.js";
import type { ParseInput, ParseResult, ParserAdapter } from "./parser-adapter.js";

/**
 * Mock parser produces a Canonical JSON document from plain text or markdown
 * input. Useful for POC / tests / CI environments without MinerU running.
 * Unknown binary types fall back to a degraded single-node document so that
 * the rest of the pipeline still has something to index.
 */
export class MockParserAdapter implements ParserAdapter {
  readonly provider = "mock";
  readonly version = "1.0.0";

  async parse(input: ParseInput): Promise<ParseResult> {
    const mime = (input.mimeType || "").toLowerCase();
    const filename = input.filename || "";
    const looksTextual = mime.startsWith("text/")
      || mime === "application/json"
      || mime === "application/xml"
      || filename.endsWith(".md")
      || filename.endsWith(".txt")
      || isLikelyUtf8(input.body);

    if (!looksTextual) {
      return {
        status: "degraded",
        reason: `mock_parser_cannot_decode_${mime || "binary"}`,
        document: buildDegradedDocument(input),
      };
    }

    const text = input.body.toString("utf8");
    const nodes = parseTextToNodes(text);
    const document: CanonicalDocument = {
      schemaVersion: "v1",
      sourceFilename: input.filename,
      sourceMimeType: input.mimeType,
      sourceSha256: input.sourceSha256,
      parser: { provider: this.provider, version: this.version },
      pageCount: 1,
      nodes,
      tables: [],
      formulas: [],
      images: [],
      readingOrder: nodes.map((node) => node.nodeId),
      markdown: text,
    };
    validateCanonicalDocument(document);
    return { status: "ok", document };
  }
}

function parseTextToNodes(text: string): CanonicalNode[] {
  const lines = text.split(/\r?\n/);
  const headingPath: string[] = [];
  const nodes: CanonicalNode[] = [];
  let charCursor = 0;
  let paragraphBuffer: string[] = [];
  let paragraphStart = 0;

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    const content = paragraphBuffer.join("\n");
    nodes.push({
      nodeId: createOpaqueId("node"),
      type: "paragraph",
      text: content,
      headingPath: [...headingPath],
      page: 1,
      charSpan: { start: paragraphStart, end: paragraphStart + content.length },
    });
    paragraphBuffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();
      headingPath.splice(level - 1);
      headingPath[level - 1] = heading;
      nodes.push({
        nodeId: createOpaqueId("node"),
        type: "heading",
        text: heading,
        headingPath: [...headingPath],
        level,
        page: 1,
        charSpan: { start: charCursor, end: charCursor + line.length },
      });
    } else if (line.trim() === "") {
      flushParagraph();
      paragraphStart = charCursor + line.length + 1;
    } else {
      if (paragraphBuffer.length === 0) {
        paragraphStart = charCursor;
      }
      paragraphBuffer.push(line);
    }
    charCursor += line.length + 1;
  }
  flushParagraph();
  return nodes;
}

function buildDegradedDocument(input: ParseInput): CanonicalDocument {
  const nodeId = createOpaqueId("node");
  return {
    schemaVersion: "v1",
    sourceFilename: input.filename,
    sourceMimeType: input.mimeType,
    sourceSha256: input.sourceSha256,
    parser: { provider: "mock", version: "1.0.0" },
    pageCount: 0,
    nodes: [
      {
        nodeId,
        type: "paragraph",
        text: "[binary content not extracted by mock parser]",
        headingPath: [],
      },
    ],
    tables: [],
    formulas: [],
    images: [],
    readingOrder: [nodeId],
    markdown: "",
  };
}

function isLikelyUtf8(body: Buffer): boolean {
  if (body.length === 0) return true;
  const sample = body.subarray(0, Math.min(body.length, 512));
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09) nonPrintable += 1;
    if (byte === 0x0b || byte === 0x0c) nonPrintable += 1;
  }
  return nonPrintable / sample.length < 0.1;
}
