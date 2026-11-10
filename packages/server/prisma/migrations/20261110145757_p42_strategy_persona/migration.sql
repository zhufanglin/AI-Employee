-- CreateTable
CREATE TABLE `StrategyDoc` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `version` VARCHAR(191) NOT NULL DEFAULT 'V1.0',
    `filePath` VARCHAR(191) NOT NULL,
    `updatedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StrategyDoc_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StrategyIteration` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `versionNo` VARCHAR(191) NOT NULL,
    `versionType` VARCHAR(191) NOT NULL DEFAULT '微调',
    `iteratedAt` DATETIME(3) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `sections` VARCHAR(191) NULL,
    `summary` VARCHAR(191) NOT NULL,
    `author` VARCHAR(191) NULL,
    `docUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StrategyIteration_phone_versionNo_idx`(`phone`, `versionNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PersonaProfile` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `positioning` TEXT NULL,
    `plan` TEXT NOT NULL,
    `accountId` VARCHAR(191) NULL,
    `followers` VARCHAR(191) NULL,
    `homepage` VARCHAR(191) NULL,
    `effectiveAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PersonaProfile_phone_name_idx`(`phone`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
