-- KnowledgeSpace 软删后外部索引清理状态机（Phase A）
--
-- 三个外部资源（Qdrant 向量库 / fulltext 全文索引 / 对象存储）独立标记，
-- 每个状态由 SpaceDeletionService 在事务外补偿；GC worker 优先重试 pending/failed。
--
-- cleanup_*_status 取值: 'ok' | 'pending' | 'running' | 'failed'
-- 历史行默认 'ok'，不被 GC 当 pending 处理。
--
-- cleanup_next_run_at 为 NULL 表示无需重试。GC worker 扫描时按 status 过滤 + cleanup_next_run_at <= NOW()。

ALTER TABLE `knowledge_spaces`
  ADD COLUMN `cleanup_qdrant_status`         VARCHAR(16) NOT NULL DEFAULT 'ok',
  ADD COLUMN `cleanup_fulltext_status`       VARCHAR(16) NOT NULL DEFAULT 'ok',
  ADD COLUMN `cleanup_object_storage_status` VARCHAR(16) NOT NULL DEFAULT 'ok',
  ADD COLUMN `cleanup_error_code`            VARCHAR(64) NULL,
  ADD COLUMN `cleanup_error_message`         TEXT NULL,
  ADD COLUMN `cleanup_attempts`              INT NOT NULL DEFAULT 0,
  ADD COLUMN `cleanup_last_attempt_at`       DATETIME(3) NULL,
  ADD COLUMN `cleanup_next_run_at`           DATETIME(3) NULL;

-- 索引带 source_system_id + tenant_id 前缀：多租户共享服务下 GC/admin 查询不跨段扫描。
CREATE INDEX `knowledge_spaces_cleanup_qdrant_idx`
  ON `knowledge_spaces` (`source_system_id`, `tenant_id`, `cleanup_qdrant_status`, `cleanup_next_run_at`);
CREATE INDEX `knowledge_spaces_cleanup_fulltext_idx`
  ON `knowledge_spaces` (`source_system_id`, `tenant_id`, `cleanup_fulltext_status`, `cleanup_next_run_at`);
CREATE INDEX `knowledge_spaces_cleanup_object_idx`
  ON `knowledge_spaces` (`source_system_id`, `tenant_id`, `cleanup_object_storage_status`, `cleanup_next_run_at`);
