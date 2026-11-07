-- AlterTable
ALTER TABLE `AiUsageRecord` ADD COLUMN `needsReview` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `reviewNote` TEXT NULL;
