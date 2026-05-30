-- CreateTable
CREATE TABLE `knowledge_spaces` (
    `space_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `owner_type` VARCHAR(32) NOT NULL,
    `owner_id` VARCHAR(128) NOT NULL,
    `default_acl` JSON NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `created_by` VARCHAR(128) NOT NULL,
    `updated_by` VARCHAR(128) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_spaces_source_system_id_tenant_id_type_status_idx`(`source_system_id`, `tenant_id`, `type`, `status`),
    INDEX `knowledge_spaces_source_system_id_tenant_id_owner_type_owner_idx`(`source_system_id`, `tenant_id`, `owner_type`, `owner_id`),
    INDEX `knowledge_spaces_source_system_id_tenant_id_deleted_at_idx`(`source_system_id`, `tenant_id`, `deleted_at`),
    UNIQUE INDEX `knowledge_spaces_source_system_id_tenant_id_space_id_key`(`source_system_id`, `tenant_id`, `space_id`),
    PRIMARY KEY (`space_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_documents` (
    `document_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `space_id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(512) NOT NULL,
    `document_type` VARCHAR(64) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `visibility_status` VARCHAR(32) NOT NULL DEFAULT 'hidden',
    `current_version_id` VARCHAR(64) NULL,
    `current_version_number` INTEGER NULL,
    `acl_hash` VARCHAR(64) NOT NULL,
    `acl_version` INTEGER NOT NULL DEFAULT 1,
    `metadata` JSON NULL,
    `tags` JSON NULL,
    `source_file_id` VARCHAR(64) NULL,
    `source_filename` VARCHAR(512) NULL,
    `source_mime_type` VARCHAR(128) NULL,
    `source_sha256` CHAR(64) NULL,
    `created_by` VARCHAR(128) NOT NULL,
    `updated_by` VARCHAR(128) NULL,
    `deleted_at` DATETIME(3) NULL,
    `searchable_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_documents_source_system_id_tenant_id_space_id_stat_idx`(`source_system_id`, `tenant_id`, `space_id`, `status`),
    INDEX `knowledge_documents_source_system_id_tenant_id_visibility_st_idx`(`source_system_id`, `tenant_id`, `visibility_status`, `deleted_at`),
    INDEX `knowledge_documents_source_system_id_tenant_id_acl_hash_acl__idx`(`source_system_id`, `tenant_id`, `acl_hash`, `acl_version`),
    INDEX `knowledge_documents_source_system_id_tenant_id_source_sha256_idx`(`source_system_id`, `tenant_id`, `source_sha256`),
    INDEX `knowledge_documents_source_system_id_tenant_id_current_versi_idx`(`source_system_id`, `tenant_id`, `current_version_id`),
    UNIQUE INDEX `knowledge_documents_source_system_id_tenant_id_document_id_key`(`source_system_id`, `tenant_id`, `document_id`),
    PRIMARY KEY (`document_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_document_versions` (
    `version_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `document_id` VARCHAR(64) NOT NULL,
    `version_number` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `parser_name` VARCHAR(64) NULL,
    `parser_version` VARCHAR(64) NULL,
    `parser_profile` VARCHAR(128) NULL,
    `parser_config_hash` VARCHAR(128) NULL,
    `degraded` BOOLEAN NOT NULL DEFAULT false,
    `degraded_reason` VARCHAR(255) NULL,
    `canonical_json_uri` VARCHAR(1024) NULL,
    `markdown_uri` VARCHAR(1024) NULL,
    `page_count` INTEGER NULL,
    `language` VARCHAR(32) NULL,
    `content_sha256` CHAR(64) NOT NULL,
    `text_sha256` CHAR(64) NULL,
    `chunk_profile` VARCHAR(128) NULL,
    `embedding_model` VARCHAR(128) NULL,
    `embedding_version` VARCHAR(128) NULL,
    `index_version` VARCHAR(64) NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `created_by` VARCHAR(128) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `searchable_at` DATETIME(3) NULL,

    INDEX `knowledge_document_versions_source_system_id_tenant_id_docum_idx`(`source_system_id`, `tenant_id`, `document_id`, `status`),
    INDEX `knowledge_document_versions_source_system_id_tenant_id_conte_idx`(`source_system_id`, `tenant_id`, `content_sha256`, `parser_config_hash`),
    INDEX `knowledge_document_versions_source_system_id_tenant_id_embed_idx`(`source_system_id`, `tenant_id`, `embedding_model`, `chunk_profile`),
    UNIQUE INDEX `knowledge_document_versions_source_system_id_tenant_id_versi_key`(`source_system_id`, `tenant_id`, `version_id`),
    UNIQUE INDEX `knowledge_document_versions_source_system_id_tenant_id_docum_key`(`source_system_id`, `tenant_id`, `document_id`, `version_number`),
    PRIMARY KEY (`version_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_assets` (
    `asset_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `document_id` VARCHAR(64) NULL,
    `version_id` VARCHAR(64) NULL,
    `type` VARCHAR(64) NOT NULL,
    `uri` VARCHAR(1024) NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `mime_type` VARCHAR(128) NULL,
    `size_bytes` BIGINT NULL,
    `page_no` INTEGER NULL,
    `bbox` JSON NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `knowledge_assets_source_system_id_tenant_id_document_id_vers_idx`(`source_system_id`, `tenant_id`, `document_id`, `version_id`),
    INDEX `knowledge_assets_source_system_id_tenant_id_type_created_at_idx`(`source_system_id`, `tenant_id`, `type`, `created_at`),
    UNIQUE INDEX `knowledge_assets_source_system_id_tenant_id_asset_id_key`(`source_system_id`, `tenant_id`, `asset_id`),
    UNIQUE INDEX `knowledge_assets_source_system_id_tenant_id_sha256_type_key`(`source_system_id`, `tenant_id`, `sha256`, `type`),
    PRIMARY KEY (`asset_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_chunks` (
    `chunk_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `space_id` VARCHAR(64) NOT NULL,
    `document_id` VARCHAR(64) NOT NULL,
    `version_id` VARCHAR(64) NOT NULL,
    `version_number` INTEGER NOT NULL,
    `chunk_index` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `text` LONGTEXT NOT NULL,
    `text_hash` CHAR(64) NOT NULL,
    `token_count` INTEGER NULL,
    `node_ids` JSON NOT NULL,
    `heading_path` JSON NULL,
    `page_start` INTEGER NULL,
    `page_end` INTEGER NULL,
    `bbox_refs` JSON NULL,
    `acl_hash` VARCHAR(64) NOT NULL,
    `acl_version` INTEGER NOT NULL,
    `embedding_model` VARCHAR(128) NULL,
    `embedding_version` VARCHAR(128) NULL,
    `vector_point_id` VARCHAR(128) NULL,
    `fulltext_doc_id` VARCHAR(128) NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `knowledge_chunks_space_status_idx`(`source_system_id`, `tenant_id`, `space_id`, `status`),
    INDEX `knowledge_chunks_source_system_id_tenant_id_document_id_vers_idx`(`source_system_id`, `tenant_id`, `document_id`, `version_id`),
    INDEX `knowledge_chunks_source_system_id_tenant_id_acl_hash_acl_ver_idx`(`source_system_id`, `tenant_id`, `acl_hash`, `acl_version`, `status`),
    INDEX `knowledge_chunks_source_system_id_tenant_id_deleted_at_idx`(`source_system_id`, `tenant_id`, `deleted_at`),
    UNIQUE INDEX `knowledge_chunks_source_system_id_tenant_id_chunk_id_key`(`source_system_id`, `tenant_id`, `chunk_id`),
    UNIQUE INDEX `knowledge_chunks_source_system_id_tenant_id_version_id_chunk_key`(`source_system_id`, `tenant_id`, `version_id`, `chunk_index`),
    UNIQUE INDEX `knowledge_chunks_source_system_id_tenant_id_vector_point_id_key`(`source_system_id`, `tenant_id`, `vector_point_id`),
    PRIMARY KEY (`chunk_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_citation_anchors` (
    `anchor_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `document_id` VARCHAR(64) NOT NULL,
    `version_id` VARCHAR(64) NOT NULL,
    `chunk_id` VARCHAR(64) NULL,
    `node_id` VARCHAR(128) NULL,
    `page_no` INTEGER NULL,
    `bbox` JSON NULL,
    `char_start` INTEGER NULL,
    `char_end` INTEGER NULL,
    `heading_path` JSON NULL,
    `asset_id` VARCHAR(64) NULL,
    `source_file_id` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_citation_anchors_source_system_id_tenant_id_docume_idx`(`source_system_id`, `tenant_id`, `document_id`, `version_id`),
    INDEX `knowledge_citation_anchors_source_system_id_tenant_id_chunk__idx`(`source_system_id`, `tenant_id`, `chunk_id`),
    INDEX `knowledge_citation_anchors_source_system_id_tenant_id_page_n_idx`(`source_system_id`, `tenant_id`, `page_no`),
    UNIQUE INDEX `knowledge_citation_anchors_source_system_id_tenant_id_anchor_key`(`source_system_id`, `tenant_id`, `anchor_id`),
    PRIMARY KEY (`anchor_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_acl_snapshots` (
    `acl_hash` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `canonical_json` JSON NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_acl_snapshots_source_system_id_tenant_id_created_a_idx`(`source_system_id`, `tenant_id`, `created_at`),
    UNIQUE INDEX `knowledge_acl_snapshots_source_system_id_tenant_id_sha256_key`(`source_system_id`, `tenant_id`, `sha256`),
    PRIMARY KEY (`source_system_id`, `tenant_id`, `acl_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_acl_principals` (
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `document_id` VARCHAR(64) NOT NULL,
    `acl_hash` VARCHAR(64) NOT NULL,
    `acl_version` INTEGER NOT NULL,
    `permission` VARCHAR(16) NOT NULL,
    `principal_type` VARCHAR(32) NOT NULL,
    `principal_id` VARCHAR(128) NOT NULL,
    `effective_from` DATETIME(3) NULL,
    `effective_to` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_acl_principals_source_system_id_tenant_id_permissi_idx`(`source_system_id`, `tenant_id`, `permission`, `principal_type`, `principal_id`),
    INDEX `knowledge_acl_principals_source_system_id_tenant_id_document_idx`(`source_system_id`, `tenant_id`, `document_id`, `acl_version`),
    INDEX `knowledge_acl_principals_source_system_id_tenant_id_acl_hash_idx`(`source_system_id`, `tenant_id`, `acl_hash`),
    PRIMARY KEY (`source_system_id`, `tenant_id`, `document_id`, `acl_version`, `permission`, `principal_type`, `principal_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_upload_sessions` (
    `upload_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `space_id` VARCHAR(64) NOT NULL,
    `asset_id` VARCHAR(64) NOT NULL,
    `object_uri` VARCHAR(1024) NOT NULL,
    `filename` VARCHAR(512) NOT NULL,
    `mime_type` VARCHAR(128) NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `claimed_sha256` CHAR(64) NULL,
    `actual_sha256` CHAR(64) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'issued',
    `issued_by` VARCHAR(128) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_upload_sessions_source_system_id_tenant_id_space_i_idx`(`source_system_id`, `tenant_id`, `space_id`, `status`),
    INDEX `knowledge_upload_sessions_source_system_id_tenant_id_expires_idx`(`source_system_id`, `tenant_id`, `expires_at`),
    INDEX `knowledge_upload_sessions_source_system_id_tenant_id_asset_i_idx`(`source_system_id`, `tenant_id`, `asset_id`),
    INDEX `knowledge_upload_sessions_claimed_hash_idx`(`source_system_id`, `tenant_id`, `space_id`, `claimed_sha256`, `status`),
    UNIQUE INDEX `knowledge_upload_sessions_source_system_id_tenant_id_upload__key`(`source_system_id`, `tenant_id`, `upload_id`),
    PRIMARY KEY (`upload_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_jobs` (
    `job_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `priority` INTEGER NOT NULL DEFAULT 100,
    `space_id` VARCHAR(64) NULL,
    `document_id` VARCHAR(64) NULL,
    `version_id` VARCHAR(64) NULL,
    `idempotency_key` VARCHAR(255) NULL,
    `payload` JSON NULL,
    `progress` JSON NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `locked_by` VARCHAR(128) NULL,
    `locked_at` DATETIME(3) NULL,
    `run_after_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `deadline_at` DATETIME(3) NULL,
    `dead_letter_at` DATETIME(3) NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `degraded_reason` VARCHAR(255) NULL,
    `created_by` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_jobs_source_system_id_tenant_id_status_priority_ru_idx`(`source_system_id`, `tenant_id`, `status`, `priority`, `run_after_at`),
    INDEX `knowledge_jobs_source_system_id_tenant_id_type_status_idx`(`source_system_id`, `tenant_id`, `type`, `status`),
    INDEX `knowledge_jobs_source_system_id_tenant_id_document_id_status_idx`(`source_system_id`, `tenant_id`, `document_id`, `status`),
    INDEX `knowledge_jobs_source_system_id_tenant_id_locked_at_idx`(`source_system_id`, `tenant_id`, `locked_at`),
    INDEX `knowledge_jobs_source_system_id_tenant_id_dead_letter_at_idx`(`source_system_id`, `tenant_id`, `dead_letter_at`),
    UNIQUE INDEX `knowledge_jobs_source_system_id_tenant_id_job_id_key`(`source_system_id`, `tenant_id`, `job_id`),
    PRIMARY KEY (`job_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_idempotency_keys` (
    `key_hash` CHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `raw_key` VARCHAR(255) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `method` VARCHAR(16) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `response_json` JSON NULL,
    `resource_type` VARCHAR(64) NULL,
    `resource_id` VARCHAR(64) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_idempotency_keys_source_system_id_tenant_id_expire_idx`(`source_system_id`, `tenant_id`, `expires_at`),
    UNIQUE INDEX `knowledge_idempotency_keys_source_system_id_tenant_id_key_ha_key`(`source_system_id`, `tenant_id`, `key_hash`),
    PRIMARY KEY (`key_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_reindex_plans` (
    `plan_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `document_id` VARCHAR(64) NOT NULL,
    `job_id` VARCHAR(64) NOT NULL,
    `mode` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `old_index_version` VARCHAR(64) NULL,
    `new_index_version` VARCHAR(64) NULL,
    `embedding_model` VARCHAR(128) NULL,
    `chunk_profile` VARCHAR(128) NULL,
    `promoted_at` DATETIME(3) NULL,
    `rolled_back_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_reindex_plans_source_system_id_tenant_id_document__idx`(`source_system_id`, `tenant_id`, `document_id`, `status`),
    INDEX `knowledge_reindex_plans_source_system_id_tenant_id_job_id_idx`(`source_system_id`, `tenant_id`, `job_id`),
    UNIQUE INDEX `knowledge_reindex_plans_source_system_id_tenant_id_plan_id_key`(`source_system_id`, `tenant_id`, `plan_id`),
    PRIMARY KEY (`plan_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_evaluation_datasets` (
    `dataset_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `version` VARCHAR(64) NOT NULL,
    `description` TEXT NULL,
    `storage_uri` VARCHAR(1024) NULL,
    `manifest` JSON NULL,
    `created_by` VARCHAR(128) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_evaluation_datasets_source_system_id_tenant_id_cre_idx`(`source_system_id`, `tenant_id`, `created_at`),
    UNIQUE INDEX `knowledge_evaluation_datasets_source_system_id_tenant_id_dat_key`(`source_system_id`, `tenant_id`, `dataset_id`),
    UNIQUE INDEX `knowledge_evaluation_datasets_source_system_id_tenant_id_nam_key`(`source_system_id`, `tenant_id`, `name`, `version`),
    PRIMARY KEY (`dataset_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_evaluation_runs` (
    `run_id` VARCHAR(64) NOT NULL,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `dataset_id` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `parser_profile` VARCHAR(128) NULL,
    `embedding_model` VARCHAR(128) NULL,
    `chunk_profile` VARCHAR(128) NULL,
    `metrics` JSON NULL,
    `report_uri` VARCHAR(1024) NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `created_by` VARCHAR(128) NOT NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `knowledge_evaluation_runs_source_system_id_tenant_id_dataset_idx`(`source_system_id`, `tenant_id`, `dataset_id`, `status`),
    INDEX `knowledge_evaluation_runs_source_system_id_tenant_id_created_idx`(`source_system_id`, `tenant_id`, `created_at`),
    UNIQUE INDEX `knowledge_evaluation_runs_source_system_id_tenant_id_run_id_key`(`source_system_id`, `tenant_id`, `run_id`),
    PRIMARY KEY (`run_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_audit_events` (
    `event_id` BIGINT NOT NULL AUTO_INCREMENT,
    `source_system_id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `user_id` VARCHAR(128) NULL,
    `request_id` VARCHAR(128) NULL,
    `action` VARCHAR(128) NOT NULL,
    `resource_type` VARCHAR(64) NULL,
    `resource_id` VARCHAR(64) NULL,
    `success` BOOLEAN NOT NULL DEFAULT true,
    `details` JSON NULL,
    `error_code` VARCHAR(64) NULL,
    `duration_ms` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_audit_events_source_system_id_tenant_id_user_id_cr_idx`(`source_system_id`, `tenant_id`, `user_id`, `created_at`),
    INDEX `knowledge_audit_events_source_system_id_tenant_id_action_cre_idx`(`source_system_id`, `tenant_id`, `action`, `created_at`),
    INDEX `knowledge_audit_events_source_system_id_tenant_id_resource_t_idx`(`source_system_id`, `tenant_id`, `resource_type`, `resource_id`),
    PRIMARY KEY (`event_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `knowledge_documents` ADD CONSTRAINT `knowledge_documents_space_id_fkey` FOREIGN KEY (`space_id`) REFERENCES `knowledge_spaces`(`space_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_document_versions` ADD CONSTRAINT `knowledge_document_versions_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_assets` ADD CONSTRAINT `knowledge_assets_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_assets` ADD CONSTRAINT `knowledge_assets_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `knowledge_document_versions`(`version_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_chunks` ADD CONSTRAINT `knowledge_chunks_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_chunks` ADD CONSTRAINT `knowledge_chunks_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `knowledge_document_versions`(`version_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_citation_anchors` ADD CONSTRAINT `knowledge_citation_anchors_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_citation_anchors` ADD CONSTRAINT `knowledge_citation_anchors_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `knowledge_document_versions`(`version_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_citation_anchors` ADD CONSTRAINT `knowledge_citation_anchors_chunk_id_fkey` FOREIGN KEY (`chunk_id`) REFERENCES `knowledge_chunks`(`chunk_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_acl_principals` ADD CONSTRAINT `knowledge_acl_principals_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`document_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_acl_principals` ADD CONSTRAINT `knowledge_acl_principals_source_system_id_tenant_id_acl_has_fkey` FOREIGN KEY (`source_system_id`, `tenant_id`, `acl_hash`) REFERENCES `knowledge_acl_snapshots`(`source_system_id`, `tenant_id`, `acl_hash`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_jobs` ADD CONSTRAINT `knowledge_jobs_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`document_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledge_evaluation_runs` ADD CONSTRAINT `knowledge_evaluation_runs_dataset_id_fkey` FOREIGN KEY (`dataset_id`) REFERENCES `knowledge_evaluation_datasets`(`dataset_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

