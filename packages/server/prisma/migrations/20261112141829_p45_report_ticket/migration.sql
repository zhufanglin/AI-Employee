-- CreateTable
CREATE TABLE `ReportTicket` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `category` VARCHAR(32) NOT NULL,
    `content` TEXT NOT NULL,
    `contact` VARCHAR(120) NULL,
    `targetUrl` VARCHAR(500) NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'api',
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'open',
    `handledBy` VARCHAR(64) NULL,
    `handledNote` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReportTicket_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `ReportTicket_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
