import { describe, expect, it, vi } from "vitest";
import { loadKnowledgeServiceConfig } from "./config.js";

describe("loadKnowledgeServiceConfig", () => {
  it("keeps nonce ttl at least twice the accepted timestamp skew by default", () => {
    vi.stubEnv("KNOWLEDGE_CLOCK_SKEW_MS", "300000");
    vi.stubEnv("KNOWLEDGE_NONCE_TTL_MS", "");
    const config = loadKnowledgeServiceConfig();
    expect(config.clockSkewMs).toBe(300000);
    expect(config.nonceTtlMs).toBeGreaterThanOrEqual(config.clockSkewMs * 2);
    vi.unstubAllEnvs();
  });

  it("enforces nonce ttl lower bound even when env is misconfigured", () => {
    vi.stubEnv("KNOWLEDGE_CLOCK_SKEW_MS", "300000");
    vi.stubEnv("KNOWLEDGE_NONCE_TTL_MS", "60000");
    const config = loadKnowledgeServiceConfig();
    expect(config.nonceTtlMs).toBe(600000);
    vi.unstubAllEnvs();
  });
});
