-- AlterTable
ALTER TABLE `MediaTaskRecord` ADD COLUMN `providerStatus` VARCHAR(191) NULL,
    ADD COLUMN `resultMeta` JSON NULL,
    ADD COLUMN `resultUrl` TEXT NULL;
