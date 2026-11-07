-- AlterTable
ALTER TABLE `ModelPricing` ADD COLUMN `provider` VARCHAR(191) NULL DEFAULT 'ark',
    ADD COLUMN `upstreamModelId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `UserMonthlyUsage` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `quotaLimit` INTEGER NOT NULL,
    `quotaUsed` INTEGER NOT NULL DEFAULT 0,
    `quotaRemaining` INTEGER NOT NULL,
    `resetAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserMonthlyUsage_userId_idx`(`userId`),
    INDEX `UserMonthlyUsage_resetAt_idx`(`resetAt`),
    UNIQUE INDEX `UserMonthlyUsage_userId_year_month_key`(`userId`, `year`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `UserMonthlyUsage` ADD CONSTRAINT `UserMonthlyUsage_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
