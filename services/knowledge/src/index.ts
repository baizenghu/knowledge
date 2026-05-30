// 本地 prisma client (services/knowledge/prisma/schema.prisma 独立生成,见 generator output);
// 不要改回 "@prisma/client" — root prisma schema 不含 KnowledgeSpace 模型。
import { PrismaClient } from "../prisma/generated/client/index.js";
import { loadKnowledgeServiceConfig } from "./config.js";
import { createKnowledgeRuntime } from "./runtime.js";

export * from "./config.js";
export * from "./http/app.js";
export * from "./runtime.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadKnowledgeServiceConfig();
  const prisma = config.databaseUrl
    ? new PrismaClient({ datasources: { db: { url: config.databaseUrl } } })
    : undefined;
  const runtime = createKnowledgeRuntime(config, { prisma });
  if (process.env["KNOWLEDGE_WORKER_ENABLED"] !== "false") {
    runtime.worker.start(Number(process.env["KNOWLEDGE_WORKER_POLL_MS"] || 1_000));
  }
  runtime.app.listen(config.port, () => {
    console.log(`knowledge-service listening on :${config.port} (${prisma ? "prisma" : "memory"} stores)`);
  });
}
