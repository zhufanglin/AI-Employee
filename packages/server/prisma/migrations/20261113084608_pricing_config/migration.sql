-- AlterTable
ALTER TABLE `MediaPricing` ADD COLUMN `costNote` VARCHAR(255) NULL,
    ADD COLUMN `upstreamCoinsPerUnit` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `upstreamUnit` VARCHAR(191) NOT NULL DEFAULT 'cny',
    ADD COLUMN `upstreamUnitCostCny` DOUBLE NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ModelPricing` ADD COLUMN `costNote` VARCHAR(255) NULL,
    ADD COLUMN `upstreamCostInputPerMillionCny` DOUBLE NOT NULL DEFAULT 1.8,
    ADD COLUMN `upstreamCostOutputPerMillionCny` DOUBLE NOT NULL DEFAULT 14.4;

-- CreateTable
CREATE TABLE `PricingConfig` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'global',
    `creditsPerYuan` INTEGER NOT NULL DEFAULT 100,
    `targetMarginPercent` INTEGER NOT NULL DEFAULT 100,
    `minCreditsPerRequest` INTEGER NOT NULL DEFAULT 1,
    `trialCredits` INTEGER NOT NULL DEFAULT 200,
    `mediaCoinCny` DOUBLE NOT NULL DEFAULT 0.01,
    `updatedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PricingChangeLog` (
    `id` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `target` VARCHAR(191) NOT NULL,
    `before` TEXT NOT NULL,
    `after` TEXT NOT NULL,
    `operator` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
