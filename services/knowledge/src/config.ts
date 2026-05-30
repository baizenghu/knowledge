export type KnowledgeServiceConfig = {
  port: number;
  serviceToken: string;
  sourceSystemId: string;
  databaseUrl?: string;
  nonceTtlMs: number;
  clockSkewMs: number;
  gcEnabled: boolean;
  gcRetentionDays: number;
  gcBatchSize: number;
  gcIntervalMs: number;
  gcMaxAttempts: number;
};

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadKnowledgeServiceConfig(): KnowledgeServiceConfig {
  const clockSkewMs = readNumber("KNOWLEDGE_CLOCK_SKEW_MS", 5 * 60_000);
  const configuredNonceTtlMs = readNumber("KNOWLEDGE_NONCE_TTL_MS", 10 * 60_000);
  const nonceTtlMs = Math.max(configuredNonceTtlMs, clockSkewMs * 2);
  return {
    port: readNumber("KNOWLEDGE_SERVICE_PORT", 8080),
    serviceToken: process.env["KNOWLEDGE_SERVICE_TOKEN"] || "dev-knowledge-token",
    sourceSystemId: process.env["KNOWLEDGE_SOURCE_SYSTEM_ID"] || "octopus",
    databaseUrl: process.env["KNOWLEDGE_DATABASE_URL"],
    nonceTtlMs,
    clockSkewMs,
    gcEnabled: process.env["KNOWLEDGE_GC_ENABLED"] !== "false",
    gcRetentionDays: readNumber("KNOWLEDGE_GC_RETENTION_DAYS", 30),
    gcBatchSize: readNumber("KNOWLEDGE_GC_BATCH_SIZE", 50),
    gcIntervalMs: readNumber("KNOWLEDGE_GC_INTERVAL_MS", 3_600_000),
    gcMaxAttempts: readNumber("KNOWLEDGE_GC_MAX_ATTEMPTS", 10),
  };
}
