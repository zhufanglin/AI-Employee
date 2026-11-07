-- AlterTable
ALTER TABLE `Order` ADD COLUMN `adminNote` TEXT NULL,
    ADD COLUMN `codeUrl` TEXT NULL,
    ADD COLUMN `notifyAt` DATETIME(3) NULL,
    ADD COLUMN `payChannel` VARCHAR(191) NOT NULL DEFAULT 'native',
    ADD COLUMN `prepayId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Order_wechatTransactionId_idx` ON `Order`(`wechatTransactionId`);
