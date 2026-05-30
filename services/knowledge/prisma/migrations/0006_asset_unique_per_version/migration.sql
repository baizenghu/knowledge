-- knowledge_assets 内容寻址唯一约束从「租户全局」收窄为「版本内」。
--
-- 旧约束: UNIQUE (source_system_id, tenant_id, sha256, type)
--   问题: assetId 由 ingest 随机生成 (createOpaqueId)，重试时同内容拿到新 assetId，
--   PrismaKnowledgeAssetStore.upsert 按 assetId 去重 → 找不到旧行 → INSERT →
--   撞该全局唯一约束 P2002。任何「写过 asset 后才失败」的 ingest 重试必死、进死信。
--   且该约束语义本身有误: asset 是 per-version 的 (有 version_id 外键 + listForVersion)，
--   不该禁止两个版本/文档持有字节相同的内容。
--
-- 新约束: UNIQUE (source_system_id, tenant_id, version_id, sha256, type)
--   同一 version 内同 (sha256, type) 只存一行 → upsert 按内容去重、重试幂等；
--   不同 version/文档可持有相同内容。MySQL 唯一索引中 version_id 为 NULL 的行互不冲突。

-- 注: 新索引用自定义短名 (schema 里 @@unique(..., map: ...))，
-- 因为 Prisma 默认名 knowledge_assets_..._version_id_sha256_type_key 超过 MySQL 64 字符上限。
DROP INDEX `knowledge_assets_source_system_id_tenant_id_sha256_type_key` ON `knowledge_assets`;

CREATE UNIQUE INDEX `knowledge_assets_version_content_key`
  ON `knowledge_assets` (`source_system_id`, `tenant_id`, `version_id`, `sha256`, `type`);
