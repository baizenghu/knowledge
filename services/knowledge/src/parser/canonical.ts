/**
 * Canonical JSON contract for parsed documents.
 *
 * MinerU and any other parser implementation MUST normalize their output into
 * this shape before downstream chunking/embedding/citation can consume it.
 * Citation needs (page_no, bbox or char_offset, node_id, heading_path,
 * asset_hash) to round-trip back to the original file, so every node carries
 * enough provenance to rebuild the link.
 */

export type CanonicalNodeType =
  | "heading"
  | "paragraph"
  | "list_item"
  | "table"
  | "formula"
  | "image"
  | "caption"
  | "code"
  | "quote";

export type CanonicalBBox = {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type CanonicalCharSpan = {
  start: number;
  end: number;
};

export type CanonicalNode = {
  nodeId: string;
  type: CanonicalNodeType;
  text: string;
  headingPath: string[];
  page?: number | null;
  bbox?: CanonicalBBox | null;
  charSpan?: CanonicalCharSpan | null;
  level?: number | null;
  tableId?: string | null;
  formulaId?: string | null;
  imageAssetId?: string | null;
  metadata?: Record<string, unknown>;
};

export type CanonicalTable = {
  tableId: string;
  rows: string[][];
  page?: number | null;
  bbox?: CanonicalBBox | null;
  caption?: string | null;
};

export type CanonicalFormula = {
  formulaId: string;
  latex: string;
  page?: number | null;
  bbox?: CanonicalBBox | null;
};

export type CanonicalImage = {
  assetId: string;
  sha256: string;
  mimeType: string;
  page?: number | null;
  bbox?: CanonicalBBox | null;
  caption?: string | null;
};

export type CanonicalAsset = {
  assetId: string;
  kind: "markdown" | "canonical_json" | "image" | "table" | "raw";
  objectUri: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string | null;
};

export type CanonicalDocument = {
  schemaVersion: "v1";
  sourceFilename: string | null;
  sourceMimeType: string | null;
  sourceSha256: string;
  parser: { provider: string; version: string };
  pageCount: number;
  nodes: CanonicalNode[];
  tables: CanonicalTable[];
  formulas: CanonicalFormula[];
  images: CanonicalImage[];
  readingOrder: string[];
  markdown: string;
};

export class CanonicalDocumentValidationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`canonical document failed validation: ${violations.join("; ")}`);
    this.name = "CanonicalDocumentValidationError";
  }
}

export function validateCanonicalDocument(doc: CanonicalDocument): void {
  const violations: string[] = [];
  if (doc.schemaVersion !== "v1") {
    violations.push(`schemaVersion must be "v1", got "${doc.schemaVersion}"`);
  }
  if (!doc.sourceSha256 || !/^[a-f0-9]{64}$/i.test(doc.sourceSha256)) {
    violations.push("sourceSha256 must be a 64-character hex digest");
  }
  if (!Number.isInteger(doc.pageCount) || doc.pageCount < 0) {
    violations.push("pageCount must be a non-negative integer");
  }
  const nodeIds = new Set<string>();
  for (const node of doc.nodes) {
    if (!node.nodeId) violations.push("node.nodeId is required");
    if (nodeIds.has(node.nodeId)) violations.push(`duplicate nodeId ${node.nodeId}`);
    nodeIds.add(node.nodeId);
    if (!Array.isArray(node.headingPath)) violations.push(`node ${node.nodeId} headingPath must be an array`);
  }
  for (const orderedId of doc.readingOrder) {
    if (!nodeIds.has(orderedId)) {
      violations.push(`readingOrder references missing nodeId ${orderedId}`);
    }
  }
  if (violations.length > 0) {
    throw new CanonicalDocumentValidationError(violations);
  }
}
