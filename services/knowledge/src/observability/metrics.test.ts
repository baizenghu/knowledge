import { beforeEach, describe, expect, it } from "vitest";
import {
  aclDenyCounter,
  citationHitCounter,
  knowledgeRegistry,
  parseDuration,
  parseFailureCounter,
  sanitizeLabel,
} from "./metrics.js";

describe("sanitizeLabel", () => {
  it("returns empty string for null / undefined", () => {
    expect(sanitizeLabel(undefined)).toBe("");
    expect(sanitizeLabel(null)).toBe("");
  });

  it("truncates inputs longer than 64 chars", () => {
    const long = "a".repeat(200);
    const out = sanitizeLabel(long);
    expect(out.length).toBe(64);
    expect(out).toBe("a".repeat(64));
  });

  it("replaces newline / comma / quote / backslash / tab / cr with _", () => {
    expect(sanitizeLabel("ten,ant\n1")).toBe("ten_ant_1");
    expect(sanitizeLabel("ev\"il\\\rfoo")).toBe("ev_il__foo");
  });

  it("passes alphanumerics through unchanged", () => {
    expect(sanitizeLabel("tenant-abc_123")).toBe("tenant-abc_123");
  });
});

describe("knowledgeRegistry metrics", () => {
  beforeEach(() => {
    knowledgeRegistry.resetMetrics();
  });

  it("records parse duration samples with tenant_id and parser_provider labels", async () => {
    parseDuration.observe({ tenant_id: "t1", parser_provider: "mock", status: "ok" }, 0.42);
    parseDuration.observe({ tenant_id: "t1", parser_provider: "mock", status: "ok" }, 1.5);

    const json = await knowledgeRegistry.getMetricsAsJSON();
    const histogram = json.find((m) => m.name === "knowledge_parse_duration_seconds");
    expect(histogram).toBeDefined();
    // sum + count samples + per-bucket samples all live in values[]; assert
    // total count for the (t1, mock, ok) label set is exactly 2.
    const count = histogram!.values.find((v) =>
      v.metricName === "knowledge_parse_duration_seconds_count" &&
      v.labels.tenant_id === "t1" &&
      v.labels.parser_provider === "mock" &&
      v.labels.status === "ok",
    );
    expect(count?.value).toBe(2);
  });

  it("counts parse failures per tenant + reason", async () => {
    parseFailureCounter.inc({ tenant_id: "t1", parser_provider: "mock", reason: "timeout" });
    parseFailureCounter.inc({ tenant_id: "t1", parser_provider: "mock", reason: "timeout" });
    parseFailureCounter.inc({ tenant_id: "t2", parser_provider: "mock", reason: "corrupt" });

    const json = await knowledgeRegistry.getMetricsAsJSON();
    const counter = json.find((m) => m.name === "knowledge_parse_failures_total");
    expect(counter).toBeDefined();
    const t1 = counter!.values.find((v) => v.labels.tenant_id === "t1" && v.labels.reason === "timeout");
    const t2 = counter!.values.find((v) => v.labels.tenant_id === "t2" && v.labels.reason === "corrupt");
    expect(t1?.value).toBe(2);
    expect(t2?.value).toBe(1);
  });

  it("exposes acl denies + citation outcomes through the registry text dump", async () => {
    aclDenyCounter.inc({ tenant_id: "t1", stage: "search_filter" });
    citationHitCounter.inc({ tenant_id: "t1", outcome: "ok" });
    citationHitCounter.inc({ tenant_id: "t1", outcome: "not_found" });

    const text = await knowledgeRegistry.metrics();
    expect(text).toContain("knowledge_acl_denies_total");
    expect(text).toContain("knowledge_citation_hits_total");
    expect(text).toMatch(/knowledge_acl_denies_total\{[^}]*stage="search_filter"[^}]*\} 1/);
    expect(text).toMatch(/knowledge_citation_hits_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(text).toMatch(/knowledge_citation_hits_total\{[^}]*outcome="not_found"[^}]*\} 1/);
  });

  it("sanitizes labels written via the helper", () => {
    // We do not enforce sanitize at the prom-client layer (it accepts any
    // string) — call-sites are expected to wrap with sanitizeLabel. Verify
    // that wrapping works end-to-end.
    const tenant = sanitizeLabel("ten,ant\nattack");
    parseFailureCounter.inc({ tenant_id: tenant, parser_provider: "mock", reason: "x" });
    expect(tenant).toBe("ten_ant_attack");
  });
});
