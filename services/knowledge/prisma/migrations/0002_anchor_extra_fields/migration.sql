-- knowledge_citation_anchors: 增加由 in-memory 实现承载的字段，以便 Prisma 实现可以无损落库
ALTER TABLE `knowledge_citation_anchors`
  ADD COLUMN `space_id` VARCHAR(64) NULL AFTER `version_id`,
  ADD COLUMN `acl_hash` VARCHAR(64) NULL AFTER `space_id`,
  ADD COLUMN `acl_version` INTEGER NULL AFTER `acl_hash`,
  ADD COLUMN `node_ids` JSON NULL AFTER `node_id`,
  ADD COLUMN `char_span` JSON NULL AFTER `char_end`;
