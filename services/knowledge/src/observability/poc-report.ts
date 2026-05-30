/**
 * M6 POC acceptance report renderer.
 *
 * This module is intentionally self-contained: it only consumes the
 * `PocReportInput` shape defined below, so it can be used independently
 * of the evaluation service / eval-run-store implementation.
 */

export type PocReportInputMetrics = {
  total_samples: number;
  recall_at_k: { k: number; value: number }[];
  mrr: number;
  citation_accuracy: number;
  answer_faithfulness?: number | null;
  empty_answer_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  grouped_by?: Record<string, Record<string, Partial<PocReportInputMetrics>>>;
};

export type PocReportInputRun = {
  runId: string;
  datasetId: string;
  datasetName?: string;
  status: "queued" | "running" | "succeeded" | "failed";
  config: {
    topK?: number;
    finalK?: number;
    runAnswer?: boolean;
    parserProfile?: string;
    embeddingModel?: string;
    rerankerModel?: string;
  };
  metrics: PocReportInputMetrics | null;
  failedSampleCount: number;
  failedSampleHighlights?: Array<{ sampleId: string; query: string; reason?: string }>;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type PocReportSection =
  | "parse_quality"
  | "retrieval_quality"
  | "permission_correctness"
  | "performance"
  | "resource_cost";

export type PocResourceCostInput = {
  parser_avg_seconds?: number;
  embedding_avg_seconds?: number;
  index_avg_seconds?: number;
  rerank_avg_seconds?: number;
  llm_avg_seconds?: number;
  vector_storage_bytes?: number;
  fulltext_storage_bytes?: number;
  notes?: string[];
};

export type PocPermissionInput = {
  cross_tenant_probe_attempts: number;
  cross_tenant_probe_denied: number;
  acl_denies_during_run: number;
  deleted_doc_filtered: number;
};

export type PocParseQualityInput = {
  table_cell_f1?: number;
  formula_match_rate?: number;
  reading_order_accuracy?: number;
  ocr_cer?: number;
  human_score_avg?: number | null;
  total_parsed?: number;
  parse_degraded_rate?: number;
  parse_failure_rate?: number;
};

export type PocReportInput = {
  run: PocReportInputRun;
  parseQuality?: PocParseQualityInput;
  permission?: PocPermissionInput;
  resourceCost?: PocResourceCostInput;
  generatedAt?: Date;
  reportVersion?: string;
};

export type PocThresholds = {
  recall_at_5_min: number;
  citation_accuracy_min: number;
  empty_answer_rate_max: number;
  latency_p95_ms_max: number;
  table_cell_f1_min: number;
  parse_failure_rate_max: number;
};

export const DEFAULT_POC_THRESHOLDS: PocThresholds = {
  recall_at_5_min: 0.7,
  citation_accuracy_min: 0.6,
  empty_answer_rate_max: 0.2,
  latency_p95_ms_max: 2000,
  table_cell_f1_min: 0.7,
  parse_failure_rate_max: 0.05,
};

type Status = "pass" | "warn" | "fail" | "n/a";

function mergeThresholds(overrides?: Partial<PocThresholds>): PocThresholds {
  return { ...DEFAULT_POC_THRESHOLDS, ...(overrides ?? {}) };
}

function recallAt(metrics: PocReportInputMetrics | null | undefined, k: number): number | undefined {
  if (!metrics) return undefined;
  const entry = metrics.recall_at_k.find((r) => r.k === k);
  return entry?.value;
}

function statusUpperLabel(status: Status): string {
  return status === "n/a" ? "N/A" : status.toUpperCase();
}

function fmtNumber(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}

function fmtBytes(v: number | undefined): string {
  if (v === undefined || v === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

function fmtIso(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString();
}

export function evaluateThreshold(
  input: PocReportInput,
  thresholds?: Partial<PocThresholds>,
): Record<PocReportSection, Status> {
  const t = mergeThresholds(thresholds);
  const { run, parseQuality, permission, resourceCost } = input;
  const metrics = run.metrics;

  const result: Record<PocReportSection, Status> = {
    parse_quality: "n/a",
    retrieval_quality: "n/a",
    permission_correctness: "n/a",
    performance: "n/a",
    resource_cost: "n/a",
  };

  // parse_quality
  if (parseQuality) {
    const failures: string[] = [];
    const warns: string[] = [];
    if (parseQuality.table_cell_f1 !== undefined) {
      if (parseQuality.table_cell_f1 < t.table_cell_f1_min) failures.push("table_cell_f1");
      else if (parseQuality.table_cell_f1 < t.table_cell_f1_min + 0.05) warns.push("table_cell_f1");
    }
    if (parseQuality.parse_failure_rate !== undefined) {
      if (parseQuality.parse_failure_rate > t.parse_failure_rate_max) failures.push("parse_failure_rate");
      else if (parseQuality.parse_failure_rate > t.parse_failure_rate_max * 0.7) warns.push("parse_failure_rate");
    }
    result.parse_quality = failures.length ? "fail" : warns.length ? "warn" : "pass";
  }

  // retrieval_quality
  if (metrics) {
    const failures: string[] = [];
    const warns: string[] = [];
    const r5 = recallAt(metrics, 5);
    if (r5 !== undefined) {
      if (r5 < t.recall_at_5_min) failures.push("recall@5");
      else if (r5 < t.recall_at_5_min + 0.05) warns.push("recall@5");
    }
    if (metrics.citation_accuracy < t.citation_accuracy_min) failures.push("citation_accuracy");
    else if (metrics.citation_accuracy < t.citation_accuracy_min + 0.05) warns.push("citation_accuracy");
    if (metrics.empty_answer_rate > t.empty_answer_rate_max) failures.push("empty_answer_rate");
    else if (metrics.empty_answer_rate > t.empty_answer_rate_max * 0.7) warns.push("empty_answer_rate");
    result.retrieval_quality = failures.length ? "fail" : warns.length ? "warn" : "pass";
  }

  // permission_correctness
  if (permission) {
    const denied = permission.cross_tenant_probe_denied;
    const attempts = permission.cross_tenant_probe_attempts;
    if (attempts > 0 && denied < attempts) {
      result.permission_correctness = "fail";
    } else {
      result.permission_correctness = "pass";
    }
  }

  // performance
  if (metrics) {
    if (metrics.latency_p95_ms > t.latency_p95_ms_max) result.performance = "fail";
    else if (metrics.latency_p95_ms > t.latency_p95_ms_max * 0.85) result.performance = "warn";
    else result.performance = "pass";
  }

  // resource_cost
  if (resourceCost) {
    // Resource cost is informational; mark pass if any data provided.
    const hasData = Object.values(resourceCost).some((v) =>
      Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null,
    );
    result.resource_cost = hasData ? "pass" : "n/a";
  }

  return result;
}

function renderTable(rows: Array<[string, string, string, string]>): string {
  const header = "| 指标 | 值 | 阈值 | 状态 |\n| --- | --- | --- | --- |";
  const body = rows.map(([m, v, t, s]) => `| ${m} | ${v} | ${t} | ${s} |`).join("\n");
  return `${header}\n${body}`;
}

function renderParseQuality(input: PocReportInput, t: PocThresholds, status: Status): string {
  const pq = input.parseQuality;
  if (!pq) {
    return `### 1. 解析质量 parse_quality — N/A\n\n_未提供 parseQuality 输入，跳过本节。_`;
  }
  const rows: Array<[string, string, string, string]> = [];
  if (pq.table_cell_f1 !== undefined) {
    rows.push([
      "table_cell_f1",
      fmtNumber(pq.table_cell_f1),
      `>= ${t.table_cell_f1_min}`,
      pq.table_cell_f1 >= t.table_cell_f1_min ? "PASS" : "FAIL",
    ]);
  }
  if (pq.formula_match_rate !== undefined) {
    rows.push(["formula_match_rate", fmtNumber(pq.formula_match_rate), "—", "INFO"]);
  }
  if (pq.reading_order_accuracy !== undefined) {
    rows.push(["reading_order_accuracy", fmtNumber(pq.reading_order_accuracy), "—", "INFO"]);
  }
  if (pq.ocr_cer !== undefined) {
    rows.push(["ocr_cer", fmtNumber(pq.ocr_cer), "—", "INFO"]);
  }
  if (pq.human_score_avg !== null && pq.human_score_avg !== undefined) {
    rows.push(["human_score_avg", fmtNumber(pq.human_score_avg), "—", "INFO"]);
  }
  if (pq.total_parsed !== undefined) {
    rows.push(["total_parsed", String(pq.total_parsed), "—", "INFO"]);
  }
  if (pq.parse_degraded_rate !== undefined) {
    rows.push(["parse_degraded_rate", fmtNumber(pq.parse_degraded_rate), "—", "INFO"]);
  }
  if (pq.parse_failure_rate !== undefined) {
    rows.push([
      "parse_failure_rate",
      fmtNumber(pq.parse_failure_rate),
      `<= ${t.parse_failure_rate_max}`,
      pq.parse_failure_rate <= t.parse_failure_rate_max ? "PASS" : "FAIL",
    ]);
  }
  const table = rows.length ? renderTable(rows) : "_无可用指标。_";
  return `### 1. 解析质量 parse_quality — ${statusUpperLabel(status)}\n\n${table}`;
}

function renderRetrievalQuality(input: PocReportInput, t: PocThresholds, status: Status): string {
  const m = input.run.metrics;
  if (!m) {
    return `### 2. 检索质量 retrieval_quality — N/A\n\n_run.metrics 为空，无法评估。_`;
  }
  const rows: Array<[string, string, string, string]> = [];
  for (const r of m.recall_at_k) {
    const isFive = r.k === 5;
    rows.push([
      `recall@${r.k}`,
      fmtNumber(r.value),
      isFive ? `>= ${t.recall_at_5_min}` : "—",
      isFive ? (r.value >= t.recall_at_5_min ? "PASS" : "FAIL") : "INFO",
    ]);
  }
  rows.push(["mrr", fmtNumber(m.mrr), "—", "INFO"]);
  rows.push([
    "citation_accuracy",
    fmtNumber(m.citation_accuracy),
    `>= ${t.citation_accuracy_min}`,
    m.citation_accuracy >= t.citation_accuracy_min ? "PASS" : "FAIL",
  ]);
  if (m.answer_faithfulness !== null && m.answer_faithfulness !== undefined) {
    rows.push(["answer_faithfulness", fmtNumber(m.answer_faithfulness), "—", "INFO"]);
  }
  rows.push([
    "empty_answer_rate",
    fmtNumber(m.empty_answer_rate),
    `<= ${t.empty_answer_rate_max}`,
    m.empty_answer_rate <= t.empty_answer_rate_max ? "PASS" : "FAIL",
  ]);
  rows.push(["total_samples", String(m.total_samples), "—", "INFO"]);

  let out = `### 2. 检索质量 retrieval_quality — ${statusUpperLabel(status)}\n\n${renderTable(rows)}`;

  // grouped_by — render the embedding_model breakdown if present.
  if (m.grouped_by) {
    for (const [groupKey, subsets] of Object.entries(m.grouped_by)) {
      out += `\n\n#### 按 ${groupKey} 分组\n\n`;
      const header = "| 子集 | recall@5 | mrr | citation_accuracy | empty_answer_rate |\n| --- | --- | --- | --- | --- |";
      const lines: string[] = [header];
      for (const [subKey, sub] of Object.entries(subsets)) {
        const r5 = recallAt(sub as PocReportInputMetrics, 5);
        lines.push(
          `| ${subKey} | ${fmtNumber(r5)} | ${fmtNumber(sub.mrr)} | ${fmtNumber(sub.citation_accuracy)} | ${fmtNumber(sub.empty_answer_rate)} |`,
        );
      }
      out += lines.join("\n");
    }
  }

  return out;
}

function renderPermission(input: PocReportInput, status: Status): string {
  const p = input.permission;
  if (!p) {
    return `### 3. 权限正确性 permission_correctness — N/A\n\n_未提供 permission 输入，跳过本节。_`;
  }
  const allDenied = p.cross_tenant_probe_attempts === 0 || p.cross_tenant_probe_denied === p.cross_tenant_probe_attempts;
  const rows: Array<[string, string, string, string]> = [
    [
      "cross_tenant_probe_denied / attempts",
      `${p.cross_tenant_probe_denied} / ${p.cross_tenant_probe_attempts}`,
      "denied == attempts",
      allDenied ? "PASS" : "FAIL",
    ],
    ["acl_denies_during_run", String(p.acl_denies_during_run), "—", "INFO"],
    ["deleted_doc_filtered", String(p.deleted_doc_filtered), "—", "INFO"],
  ];
  return `### 3. 权限正确性 permission_correctness — ${statusUpperLabel(status)}\n\n${renderTable(rows)}`;
}

function renderPerformance(input: PocReportInput, t: PocThresholds, status: Status): string {
  const m = input.run.metrics;
  if (!m) {
    return `### 4. 性能 performance — N/A\n\n_run.metrics 为空，无法评估。_`;
  }
  const rows: Array<[string, string, string, string]> = [
    ["latency_p50_ms", fmtNumber(m.latency_p50_ms, 1), "—", "INFO"],
    [
      "latency_p95_ms",
      fmtNumber(m.latency_p95_ms, 1),
      `<= ${t.latency_p95_ms_max}`,
      m.latency_p95_ms <= t.latency_p95_ms_max ? "PASS" : "FAIL",
    ],
  ];
  return `### 4. 性能 performance — ${statusUpperLabel(status)}\n\n${renderTable(rows)}`;
}

function renderResourceCost(input: PocReportInput, status: Status): string {
  const r = input.resourceCost;
  if (!r) {
    return `### 5. 资源成本 resource_cost — N/A\n\n_未提供 resourceCost 输入，跳过本节。_`;
  }
  const rows: Array<[string, string, string, string]> = [];
  if (r.parser_avg_seconds !== undefined) rows.push(["parser_avg_seconds", fmtNumber(r.parser_avg_seconds, 2), "—", "INFO"]);
  if (r.embedding_avg_seconds !== undefined) rows.push(["embedding_avg_seconds", fmtNumber(r.embedding_avg_seconds, 2), "—", "INFO"]);
  if (r.index_avg_seconds !== undefined) rows.push(["index_avg_seconds", fmtNumber(r.index_avg_seconds, 2), "—", "INFO"]);
  if (r.rerank_avg_seconds !== undefined) rows.push(["rerank_avg_seconds", fmtNumber(r.rerank_avg_seconds, 2), "—", "INFO"]);
  if (r.llm_avg_seconds !== undefined) rows.push(["llm_avg_seconds", fmtNumber(r.llm_avg_seconds, 2), "—", "INFO"]);
  if (r.vector_storage_bytes !== undefined) rows.push(["vector_storage_bytes", fmtBytes(r.vector_storage_bytes), "—", "INFO"]);
  if (r.fulltext_storage_bytes !== undefined) rows.push(["fulltext_storage_bytes", fmtBytes(r.fulltext_storage_bytes), "—", "INFO"]);

  let out = `### 5. 资源成本 resource_cost — ${statusUpperLabel(status)}\n\n`;
  out += rows.length ? renderTable(rows) : "_无可用资源指标。_";
  if (r.notes && r.notes.length) {
    out += `\n\n**备注：**\n` + r.notes.map((n) => `- ${n}`).join("\n");
  }
  return out;
}

function renderHeader(input: PocReportInput): string {
  const r = input.run;
  const cfg = r.config;
  const cfgLines = [
    `- runId: \`${r.runId}\``,
    `- datasetId: \`${r.datasetId}\`${r.datasetName ? ` (${r.datasetName})` : ""}`,
    `- status: \`${r.status}\``,
    `- topK: ${cfg.topK ?? "—"} / finalK: ${cfg.finalK ?? "—"}`,
    `- runAnswer: ${cfg.runAnswer ?? "—"}`,
    `- parserProfile: ${cfg.parserProfile ?? "—"}`,
    `- embeddingModel: ${cfg.embeddingModel ?? "—"}`,
    `- rerankerModel: ${cfg.rerankerModel ?? "—"}`,
    `- startedAt: ${fmtIso(r.startedAt)}`,
    `- finishedAt: ${fmtIso(r.finishedAt)}`,
    `- failedSampleCount: ${r.failedSampleCount}`,
  ];
  return `# Knowledge POC 验收报告\n\n${cfgLines.join("\n")}`;
}

function renderFailedSamples(input: PocReportInput): string {
  const highlights = input.run.failedSampleHighlights ?? [];
  if (!highlights.length) return "";
  const rows = highlights.slice(0, 5).map((h) => {
    const reason = h.reason ? h.reason.replace(/\|/g, "\\|") : "—";
    const query = h.query.replace(/\|/g, "\\|");
    return `| ${h.sampleId} | ${query} | ${reason} |`;
  });
  const header = "| sampleId | query | reason |\n| --- | --- | --- |";
  return `### 失败样本（前 ${rows.length} 条）\n\n${header}\n${rows.join("\n")}`;
}

function renderFooter(input: PocReportInput): string {
  const generated = (input.generatedAt ?? new Date()).toISOString();
  const version = input.reportVersion ?? "v1";
  return `_generated_at: ${generated} · report_version: ${version} · run_id: ${input.run.runId}_`;
}

export function renderPocReport(input: PocReportInput, thresholds?: Partial<PocThresholds>): string {
  const t = mergeThresholds(thresholds);
  const statuses = evaluateThreshold(input, thresholds);

  const blocks: string[] = [];
  blocks.push(renderHeader(input));
  blocks.push(renderParseQuality(input, t, statuses.parse_quality));
  blocks.push(renderRetrievalQuality(input, t, statuses.retrieval_quality));
  blocks.push(renderPermission(input, statuses.permission_correctness));
  blocks.push(renderPerformance(input, t, statuses.performance));
  blocks.push(renderResourceCost(input, statuses.resource_cost));

  const failed = renderFailedSamples(input);
  if (failed) blocks.push(failed);

  blocks.push(renderFooter(input));

  return blocks.join("\n\n---\n\n") + "\n";
}
