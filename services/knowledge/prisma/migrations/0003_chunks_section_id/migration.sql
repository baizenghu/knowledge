-- Small-to-Big retrieval: section_id 用于按 (versionId, heading_path) 聚合 chunk
-- 加列 + 索引 + 一次性 backfill。版本相同、heading_path 相同的 chunk 算同一节。
-- 不重新 ingest 即可启用 section 模式。

ALTER TABLE `knowledge_chunks`
  ADD COLUMN `section_id` VARCHAR(64) NULL AFTER `acl_version`;

CREATE INDEX `knowledge_chunks_section_idx`
  ON `knowledge_chunks` (`source_system_id`, `tenant_id`, `section_id`);

-- 一次性 backfill：把 heading_path JSON 数组按 "›" 连接后与 version_id 拼接，
-- 取 SHA2 前 32 hex 当作 section_id。和 chunker computeSectionId() 完全等价。
-- MySQL 8 支持 JSON_TABLE，但简洁起见我们用 JSON_UNQUOTE + REPLACE 串拼。
UPDATE `knowledge_chunks`
SET `section_id` = SUBSTR(
  SHA2(
    CONCAT(
      `version_id`,
      '|',
      REPLACE(
        REPLACE(
          REPLACE(
            JSON_UNQUOTE(JSON_EXTRACT(IFNULL(`heading_path`, '[]'), '$')),
            '","',
            '›'
          ),
          '["',
          ''
        ),
        '"]',
        ''
      )
    ),
    256
  ),
  1,
  32
)
WHERE `section_id` IS NULL;
