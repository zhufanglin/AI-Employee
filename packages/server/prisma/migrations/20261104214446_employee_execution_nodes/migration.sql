-- CreateTable
CREATE TABLE `EmployeeExecutionNode` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `executor` VARCHAR(191) NOT NULL DEFAULT 'desktop',
    `status` VARCHAR(191) NOT NULL DEFAULT 'online',
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EmployeeExecutionNode_userId_status_idx`(`userId`, `status`),
    INDEX `EmployeeExecutionNode_status_lastSeenAt_idx`(`status`, `lastSeenAt`),
    UNIQUE INDEX `EmployeeExecutionNode_userId_deviceId_key`(`userId`, `deviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EmployeeExecutionNode` ADD CONSTRAINT `EmployeeExecutionNode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
