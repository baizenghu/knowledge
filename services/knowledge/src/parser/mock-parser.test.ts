import { describe, expect, it } from "vitest";
import { MockParserAdapter } from "./mock-parser.js";
import { validateCanonicalDocument } from "./canonical.js";
import { sha256Hex } from "../repositories/object-store.js";

describe("MockParserAdapter", () => {
  const adapter = new MockParserAdapter();

  it("parses markdown into heading and paragraph nodes preserving heading path", async () => {
    const body = Buffer.from(
      "# Top\n\nintro paragraph.\n\n## Sub\n\nbody line 1\nbody line 2\n",
    );
    const result = await adapter.parse({
      body,
      filename: "doc.md",
      mimeType: "text/markdown",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    validateCanonicalDocument(result.document);

    const types = result.document.nodes.map((node) => node.type);
    expect(types).toEqual(["heading", "paragraph", "heading", "paragraph"]);
    const sub = result.document.nodes.find((n) => n.type === "heading" && n.text === "Sub");
    expect(sub?.headingPath).toEqual(["Top", "Sub"]);
    expect(result.document.readingOrder).toHaveLength(4);
  });

  it("degrades on unknown binary content but still returns a valid Canonical document", async () => {
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
    const result = await adapter.parse({
      body,
      filename: "image.jpg",
      mimeType: "image/jpeg",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") return;
    validateCanonicalDocument(result.document);
    expect(result.reason).toContain("mock_parser_cannot_decode");
    expect(result.document.nodes).toHaveLength(1);
  });
});
