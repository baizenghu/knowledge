import type { ParseInput, ParseResult, ParserAdapter } from "./parser-adapter.js";

/**
 * Dispatches each document to the right parser by content type.
 *
 * 文本类文档（markdown / txt / json / xml / 纯文本）本身就是结构化文本，
 * 走 MinerU（PDF/图像版面解析器）会被拒（HTTP 400）；它们应交给文本解析器
 * 直接按标题/段落抽结构。二进制文档（PDF / 图片 / office）才走 MinerU。
 *
 * 这样配置 PARSER_PROVIDER=mineru 时，PDF 仍走 MinerU，而 .md/.txt 不再 400。
 */
export class RoutingParserAdapter implements ParserAdapter {
  readonly provider = "routing";
  readonly version = "1.0.0";

  constructor(
    private readonly binaryParser: ParserAdapter,
    private readonly textParser: ParserAdapter,
  ) {}

  parse(input: ParseInput, signal?: AbortSignal): Promise<ParseResult> {
    const parser = isTextualDocument(input) ? this.textParser : this.binaryParser;
    return parser.parse(input, signal);
  }
}

/** 文本类文档判定：按 mime 与文件扩展名，二者任一命中即视为文本。 */
export function isTextualDocument(input: { mimeType?: string | null; filename?: string | null }): boolean {
  const mime = (input.mimeType || "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/xml") return true;

  const name = (input.filename || "").toLowerCase();
  return /\.(md|markdown|txt|text|json|xml|log|csv|tsv|yaml|yml)$/.test(name);
}
