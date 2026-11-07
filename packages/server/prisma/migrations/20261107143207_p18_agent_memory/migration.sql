-- CreateTable
CREATE TABLE `AgentMemory` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'note',
    `title` VARCHAR(191) NULL,
    `content` TEXT NOT NULL,
    `tags` VARCHAR(512) NULL,
    `employeeSlug` VARCHAR(191) NULL,
    `sourceTaskId` VARCHAR(191) NULL,
    `hitCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AgentMemory_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `AgentMemory_userId_kind_idx`(`userId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
