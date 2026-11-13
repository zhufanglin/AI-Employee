-- CreateTable
CREATE TABLE `TimelineJob` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'queued',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `spec` JSON NULL,
    `resultUrl` MEDIUMTEXT NULL,
    `error` MEDIUMTEXT NULL,
    `durationSeconds` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TimelineJob_phone_idx`(`phone`),
    INDEX `TimelineJob_status_idx`(`status`),
    INDEX `TimelineJob_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
