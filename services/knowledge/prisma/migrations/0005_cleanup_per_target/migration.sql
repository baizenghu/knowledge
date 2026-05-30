-- KnowledgeSpace cleanup 字段从「全局共享」拆成「per-target 独立」（P0-2 + P1-7）。
--
-- 旧模型: 单一 cleanup_attempts / cleanup_next_run_at / cleanup_error_code / cleanup_error_message
-- 三个 target 共用，导致 qdrant 失败设 60s 重试可被随后写入的 object_storage 30 天 nextRunAt 覆盖。
--
-- 新模型: 每个 target 独立持有 attempts / next_run_at / error_code / error_message。
-- cleanup_last_attempt_at 仍三 target 共用（仅 admin 维护页排序用途）。

-- 1) 先 drop 0004 的旧索引（它们引用了即将被删除的 cleanup_next_run_at 列）。
DROP INDEX `knowledge_spaces_cleanup_qdrant_idx`   ON `knowledge_spaces`;
DROP INDEX `knowledge_spaces_cleanup_fulltext_idx` ON `knowledge_spaces`;
DROP INDEX `knowledge_spaces_cleanup_object_idx`   ON `knowledge_spaces`;

-- 2) 删除全局共享列。
ALTER TABLE `knowledge_spaces`
  DROP COLUMN `cleanup_attempts`,
  DROP COLUMN `cleanup_next_run_at`,
  DROP COLUMN `cleanup_error_code`,
  DROP COLUMN `cleanup_error_message`;

-- 3) 新增 per-target 字段（共 12 列：每 target 4 列）。
ALTER TABLE `knowledge_spaces`
  ADD COLUMN `cleanup_qdrant_attempts`            INT          NOT NULL DEFAULT 0,
  ADD COLUMN `cleanup_qdrant_next_run_at`         DATETIME(3)  NULL,
  ADD COLUMN `cleanup_qdrant_error_code`          VARCHAR(64)  NULL,
  ADD COLUMN `cleanup_qdrant_error_message`       TEXT         NULL,
  ADD COLUMN `cleanup_fulltext_attempts`          INT          NOT NULL DEFAULT 0,
  ADD COLUMN `cleanup_fulltext_next_run_at`       DATETIME(3)  NULL,
  ADD COLUMN `cleanup_fulltext_error_code`        VARCHAR(64)  NULL,
  ADD COLUMN `cleanup_fulltext_error_message`     TEXT         NULL,
  ADD COLUMN `cleanup_object_storage_attempts`    INT          NOT NULL DEFAULT 0,
  ADD COLUMN `cleanup_object_storage_next_run_at` DATETIME(3)  NULL,
  ADD COLUMN `cleanup_object_storage_error_code`  VARCHAR(64)  NULL,
  ADD COLUMN `cleanup_object_storage_error_message` TEXT       NULL;

-- 4) 重建索引，每 target 用自己的 (status, next_run_at)。
CREATE INDEX `knowledge_spaces_cleanup_qdrant_idx`
  ON `knowledge_spaces` (`source_system_id`, `tenant_id`, `cleanup_qdrant_status`, `cleanup_qdrant_next_run_at`);
CREATE INDEX `knowledge_spaces_cleanup_fulltext_idx`
  ON `knowledge_spaces` (`source_system_id`, `tenant_id`, `cleanup_fulltext_status`, `cleanup_fulltext_next_run_at`);
CREATE INDEX `knowledge_spaces_cleanup_object_idx`
  ON `knowledge_spaces` (`source_system_id`, `tenant_id`, `cleanup_object_storage_status`, `cleanup_object_storage_next_run_at`);
