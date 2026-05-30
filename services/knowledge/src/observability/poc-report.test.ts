import { describe, expect, it } from "vitest";
import {
  DEFAULT_POC_THRESHOLDS,
  evaluateThreshold,
  renderPocReport,
  type PocReportInput,
} from "./poc-report.js";

function makeInput(overrides: Partial<PocReportInput> = {}): PocReportInput {
  return {
    run: {
      runId: "run_test_1",
      datasetId: "ds_test",
      datasetName: "Smoke Dataset",
      status: "succeeded",
      config: {
        topK: 50,
        finalK: 10,
        runAnswer: true,
        parserProfile: "mineru-default",
        embeddingModel: "bge-m3",
        rerankerModel: "bge-reranker",
      },
      metrics: {
        total_samples: 100,
        recall_at_k: [
          { k: 1, value: 0.65 },
          { k: 5, value: 0.85 },
          { k: 10, value: 0.92 },
        ],
        mrr: 0.78,
        citation_accuracy: 0.82,
        answer_faithfulness: 0.74,
        empty_answer_rate: 0.05,
        latency_p50_ms: 420,
        latency_p95_ms: 1500,
      },
      failedSampleCount: 3,
      failedSampleHighlights: [
        { sampleId: "s1", query: "What is foo?", reason: "no_doc_found" },
        { sampleId: "s2", query: "Tell me bar", reason: "timeout" },
      ],
      startedAt: new Date("2026-05-18T01:00:00Z"),
      finishedAt: new Date("2026-05-18T01:05:00Z"),
    },
    parseQuality: {
      table_cell_f1: 0.82,
      formula_match_rate: 0.7,
      reading_order_accuracy: 0.9,
      ocr_cer: 0.04,
      total_parsed: 50,
      parse_degraded_rate: 0.02,
      parse_failure_rate: 0.01,
    },
    permission: {
      cross_tenant_probe_attempts: 20,
      cross_tenant_probe_denied: 20,
      acl_denies_during_run: 5,
      deleted_doc_filtered: 3,
    },
    resourceCost: {
      parser_avg_seconds: 1.2,
      embedding_avg_seconds: 0.3,
      vector_storage_bytes: 1024 * 1024 * 12,
      notes: ["Embedding model bge-m3 used CPU fallback."],
    },
    generatedAt: new Date("2026-05-18T02:00:00Z"),
    reportVersion: "v1",
    ...overrides,
  };
}

describe("evaluateThreshold", () => {
  it("all sections pass when metrics meet defaults", () => {
    const input = makeInput();
    const statuses = evaluateThreshold(input);
    expect(statuses.parse_quality).toBe("pass");
    expect(statuses.retrieval_quality).toBe("pass");
    expect(statuses.permission_correctness).toBe("pass");
    expect(statuses.performance).toBe("pass");
    expect(statuses.resource_cost).toBe("pass");
  });

  it("retrieval fails when recall@5 below threshold", () => {
    const input = makeInput();
    input.run.metrics!.recall_at_k = [
      { k: 1, value: 0.3 },
      { k: 5, value: 0.4 },
    ];
    const statuses = evaluateThreshold(input);
    expect(statuses.retrieval_quality).toBe("fail");
  });

  it("retrieval fails when empty_answer_rate too high", () => {
    const input = makeInput();
    input.run.metrics!.empty_answer_rate = 0.5;
    const statuses = evaluateThreshold(input);
    expect(statuses.retrieval_quality).toBe("fail");
  });

  it("performance fails when latency_p95_ms exceeds threshold", () => {
    const input = makeInput();
    input.run.metrics!.latency_p95_ms = 5000;
    const statuses = evaluateThreshold(input);
    expect(statuses.performance).toBe("fail");
  });

  it("permission fails when not all cross-tenant probes denied", () => {
    const input = makeInput();
    input.permission!.cross_tenant_probe_denied = 10;
    const statuses = evaluateThreshold(input);
    expect(statuses.permission_correctness).toBe("fail");
  });
});

describe("renderPocReport", () => {
  it("renders all five sections with PASS in happy path", () => {
    const md = renderPocReport(makeInput());
    expect(md).toContain("### 1. 解析质量 parse_quality — PASS");
    expect(md).toContain("### 2. 检索质量 retrieval_quality — PASS");
    expect(md).toContain("### 3. 权限正确性 permission_correctness — PASS");
    expect(md).toContain("### 4. 性能 performance — PASS");
    expect(md).toContain("### 5. 资源成本 resource_cost — PASS");
    expect(md).toContain("run_id: run_test_1");
    expect(md).toContain("report_version: v1");
    expect(md).toMatch(/generated_at: 2026-05-18T02:00:00\.000Z/);
    expect(md).toContain("---");
  });

  it("renders parse_quality as N/A without crash when parseQuality missing", () => {
    const input = makeInput({ parseQuality: undefined });
    const md = renderPocReport(input);
    expect(md).toContain("### 1. 解析质量 parse_quality — N/A");
    expect(md).toContain("未提供 parseQuality 输入");
  });

  it("includes grouped_by subtable when metrics.grouped_by present", () => {
    const input = makeInput();
    input.run.metrics!.grouped_by = {
      embedding_model: {
        "bge-m3": {
          total_samples: 50,
          recall_at_k: [{ k: 5, value: 0.88 }],
          mrr: 0.8,
          citation_accuracy: 0.85,
          empty_answer_rate: 0.04,
          latency_p50_ms: 400,
          latency_p95_ms: 1400,
        },
        "openai-3-large": {
          total_samples: 50,
          recall_at_k: [{ k: 5, value: 0.81 }],
          mrr: 0.74,
          citation_accuracy: 0.78,
          empty_answer_rate: 0.06,
          latency_p50_ms: 450,
          latency_p95_ms: 1600,
        },
      },
    };
    const md = renderPocReport(input);
    expect(md).toContain("#### 按 embedding_model 分组");
    expect(md).toContain("| bge-m3 |");
    expect(md).toContain("| openai-3-large |");
  });

  it("limits failedSampleHighlights to 5 rows", () => {
    const input = makeInput();
    input.run.failedSampleHighlights = Array.from({ length: 10 }, (_, i) => ({
      sampleId: `s${i}`,
      query: `q${i}`,
      reason: "boom",
    }));
    const md = renderPocReport(input);
    const matches = md.match(/\| s\d+ \|/g) ?? [];
    expect(matches.length).toBe(5);
    expect(md).toContain("失败样本（前 5 条）");
  });

  it("retrieval section is N/A when metrics is null", () => {
    const input = makeInput();
    input.run.metrics = null;
    const md = renderPocReport(input);
    expect(md).toContain("### 2. 检索质量 retrieval_quality — N/A");
    expect(md).toContain("### 4. 性能 performance — N/A");
  });

  it("exposes default thresholds constant", () => {
    expect(DEFAULT_POC_THRESHOLDS.recall_at_5_min).toBe(0.7);
    expect(DEFAULT_POC_THRESHOLDS.latency_p95_ms_max).toBe(2000);
  });
});
