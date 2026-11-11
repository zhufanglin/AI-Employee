-- CreateTable
CREATE TABLE `ChannelInboundMsg` (
    `id` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(32) NOT NULL,
    `msgId` VARCHAR(191) NOT NULL,
    `fromUser` VARCHAR(191) NULL,
    `taskId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChannelInboundMsg_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `ChannelInboundMsg_channel_msgId_key`(`channel`, `msgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
