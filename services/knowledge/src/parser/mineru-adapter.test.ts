import { describe, expect, it } from "vitest";
import { MinerUHttpAdapter } from "./mineru-adapter.js";
import { sha256Hex } from "../repositories/object-store.js";

describe("MinerUHttpAdapter", () => {
  it("normalizes MinerU /file_parse response into Canonical JSON", async () => {
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      fetchImpl: async () => new Response(JSON.stringify({
        task_id: "t_1",
        status: "completed",
        backend: "pipeline",
        version: "3.1.0",
        file_names: ["doc"],
        results: {
          doc: {
            md_content: "# Title\n\nbody",
            content_list: JSON.stringify([
              { type: "text", text: "Title", text_level: 1, bbox: [0, 0, 50, 20], page_idx: 0 },
              { type: "text", text: "body", bbox: [0, 30, 100, 50], page_idx: 0 },
            ]),
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const body = Buffer.from("ignored");
    const result = await adapter.parse({
      body,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.document.parser.provider).toBe("mineru");
    expect(result.document.parser.version).toBe("3.1.0");
    expect(result.document.pageCount).toBe(1);
    expect(result.document.nodes).toHaveLength(2);
    expect(result.document.nodes[0]).toMatchObject({ type: "heading", text: "Title", level: 1 });
    expect(result.document.nodes[1]).toMatchObject({ type: "paragraph", text: "body", headingPath: ["Title"] });
    expect(result.document.nodes[1].bbox).toMatchObject({ page: 1, x0: 0, y0: 30, x1: 100, y1: 50 });
  });

  it("extracts table cell text from table_body when text field is absent", async () => {
    const tableBody = '<table><tr><td>事件</td><td>触发时机</td><td>典型用途</td></tr>' +
      '<tr><td>PreToolUse</td><td>工具执行前</td><td>拦截危险命令</td></tr>' +
      '<tr><td>PostToolUse</td><td>工具执行后</td><td>自动 lint/format</td></tr>' +
      '<tr><td>UserPromptSubmit</td><td>用户发送消息时</td><td>输入预处理</td></tr>' +
      '<tr><td>Stop</td><td>Claude 完成回复时</td><td>自动运行测试</td></tr>' +
      '<tr><td>SessionStart</td><td>会话开始时</td><td>环境初始化</td></tr>' +
      '<tr><td>SessionEnd</td><td>会话结束时</td><td>清理临时文件</td></tr></table>';
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      fetchImpl: async () => new Response(JSON.stringify({
        status: "completed",
        version: "3.1.0",
        file_names: ["doc"],
        results: {
          doc: {
            md_content: "",
            content_list: JSON.stringify([
              { type: "text", text: "Hooks", text_level: 1, page_idx: 2 },
              {
                type: "table",
                table_body: tableBody,
                table_caption: ["Hooks 6 事件表"],
                page_idx: 2,
                bbox: [0, 100, 500, 400],
              },
            ]),
          },
        },
      }), { status: 200 }),
    });
    const body = Buffer.from("ignored");
    const result = await adapter.parse({
      body,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const tableNode = result.document.nodes.find((n) => n.type === "table");
    expect(tableNode).toBeDefined();
    const text = tableNode!.text;
    for (const name of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "SessionEnd"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("Hooks 6 事件表");
    expect(text).toContain("|"); // cell separator
    expect(tableNode!.headingPath).toEqual(["Hooks"]);
  });

  it("extracts code block text from code_body when text field is absent", async () => {
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      fetchImpl: async () => new Response(JSON.stringify({
        status: "completed",
        version: "3.1.0",
        file_names: ["doc"],
        results: {
          doc: {
            md_content: "",
            content_list: JSON.stringify([
              {
                type: "code",
                sub_type: "json",
                code_body: '{ "hooks": { "PreToolUse": [] } }',
                code_caption: ["settings.json"],
                page_idx: 0,
              },
            ]),
          },
        },
      }), { status: 200 }),
    });
    const body = Buffer.from("x");
    const result = await adapter.parse({
      body,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.document.nodes).toHaveLength(1);
    expect(result.document.nodes[0].type).toBe("code");
    expect(result.document.nodes[0].text).toContain("PreToolUse");
    expect(result.document.nodes[0].text).toContain("settings.json");
  });

  it("decodes HTML entities inside table cells", async () => {
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      fetchImpl: async () => new Response(JSON.stringify({
        status: "completed",
        version: "3.1.0",
        file_names: ["doc"],
        results: {
          doc: {
            content_list: JSON.stringify([
              {
                type: "table",
                table_body: '<table><tr><td>a &amp; b</td><td>&lt;tag&gt;</td></tr></table>',
                page_idx: 0,
              },
            ]),
          },
        },
      }), { status: 200 }),
    });
    const body = Buffer.from("x");
    const result = await adapter.parse({
      body, filename: "doc.pdf", mimeType: "application/pdf",
      sourceSha256: sha256Hex(body), documentId: "doc_1", versionId: "ver_1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.document.nodes[0].text).toBe("a & b | <tag>");
  });

  it("reports task-level failure with non-retryable flag", async () => {
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      fetchImpl: async () => new Response(JSON.stringify({
        task_id: "t_2",
        status: "failed",
        error: "Unexpected error from cudaGetDeviceCount()",
      }), { status: 200 }),
    });
    const body = Buffer.from("payload");
    const result = await adapter.parse({
      body,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("mineru_task_failed");
  });

  it("reports failure with retryable flag when MinerU returns 5xx", async () => {
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      fetchImpl: async () => new Response("err", { status: 503 }),
    });
    const body = Buffer.from("payload");
    const result = await adapter.parse({
      body,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("mineru_http_503");
  });

  it("marks timeout as retryable failure when fetch is aborted", async () => {
    const adapter = new MinerUHttpAdapter({
      endpoint: "http://mineru.test",
      timeoutMs: 5,
      fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    const body = Buffer.from("payload");
    const result = await adapter.parse({
      body,
      filename: "doc.pdf",
      mimeType: "application/pdf",
      sourceSha256: sha256Hex(body),
      documentId: "doc_1",
      versionId: "ver_1",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("mineru_timeout");
  });
});
