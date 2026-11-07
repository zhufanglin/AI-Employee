-- AlterTable
ALTER TABLE `AiEmployee` ADD COLUMN `avatarEmoji` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `category` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `cliRequirement` VARCHAR(191) NOT NULL DEFAULT 'none',
    ADD COLUMN `cronPresets` JSON NULL,
    ADD COLUMN `skillName` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `skillVersion` VARCHAR(191) NOT NULL DEFAULT '1.0.0',
    ADD COLUMN `tier` VARCHAR(191) NOT NULL DEFAULT 'standard',
    ADD COLUMN `usageExample` VARCHAR(191) NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE `AiEmployeeInstall` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `version` VARCHAR(191) NOT NULL DEFAULT '1.0.0',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `expiresAt` DATETIME(3) NULL,
    `workspacePath` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiEmployeeInstall_userId_idx`(`userId`),
    INDEX `AiEmployeeInstall_employeeId_idx`(`employeeId`),
    INDEX `AiEmployeeInstall_enabled_expiresAt_idx`(`enabled`, `expiresAt`),
    UNIQUE INDEX `AiEmployeeInstall_userId_employeeId_key`(`userId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeCron` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `workflowKey` VARCHAR(191) NOT NULL DEFAULT 'default',
    `cronExpr` VARCHAR(191) NOT NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Shanghai',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `lastRunAt` DATETIME(3) NULL,
    `nextRunAt` DATETIME(3) NULL,
    `missedCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EmployeeCron_userId_idx`(`userId`),
    INDEX `EmployeeCron_employeeId_idx`(`employeeId`),
    INDEX `EmployeeCron_enabled_nextRunAt_idx`(`enabled`, `nextRunAt`),
    INDEX `EmployeeCron_userId_employeeId_idx`(`userId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeTask` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `cronId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `input` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `outputKind` VARCHAR(191) NOT NULL DEFAULT 'text',
    `outputText` MEDIUMTEXT NULL,
    `outputPath` MEDIUMTEXT NULL,
    `outputMeta` JSON NULL,
    `error` MEDIUMTEXT NULL,
    `executor` VARCHAR(191) NOT NULL DEFAULT 'cloud',
    `runAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `creditsCharged` INTEGER NOT NULL DEFAULT 0,
    `missedOf` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EmployeeTask_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `EmployeeTask_userId_status_idx`(`userId`, `status`),
    INDEX `EmployeeTask_status_executor_runAt_idx`(`status`, `executor`, `runAt`),
    INDEX `EmployeeTask_employeeId_idx`(`employeeId`),
    INDEX `EmployeeTask_cronId_idx`(`cronId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeTaskArtifact` (
    `id` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'text',
    `path` MEDIUMTEXT NULL,
    `url` MEDIUMTEXT NULL,
    `text` MEDIUMTEXT NULL,
    `mime` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmployeeTaskArtifact_taskId_idx`(`taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `AiEmployee_category_idx` ON `AiEmployee`(`category`);

-- CreateIndex
CREATE INDEX `AiEmployee_tier_idx` ON `AiEmployee`(`tier`);
