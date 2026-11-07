-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NULL,
    `avatar` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'user',
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `credits` INTEGER NOT NULL DEFAULT 0,
    `totalCreditsConsumed` INTEGER NOT NULL DEFAULT 0,
    `totalCreditsRecharged` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'register',
    `wechatOpenId` VARCHAR(191) NULL,
    `wechatUnionId` VARCHAR(191) NULL,
    `wechatNickname` VARCHAR(191) NULL,
    `wechatAvatar` VARCHAR(191) NULL,

    UNIQUE INDEX `User_phone_key`(`phone`),
    UNIQUE INDEX `User_email_key`(`email`),
    UNIQUE INDEX `User_wechatOpenId_key`(`wechatOpenId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accessToken` VARCHAR(512) NOT NULL,
    `refreshToken` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `deviceId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Session_accessToken_key`(`accessToken`),
    UNIQUE INDEX `Session_refreshToken_key`(`refreshToken`),
    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_accessToken_idx`(`accessToken`),
    INDEX `Session_refreshToken_idx`(`refreshToken`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProxyToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ProxyToken_token_key`(`token`),
    INDEX `ProxyToken_token_idx`(`token`),
    INDEX `ProxyToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VerificationCode` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `used` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userId` VARCHAR(191) NULL,

    INDEX `VerificationCode_phone_code_purpose_idx`(`phone`, `code`, `purpose`),
    INDEX `VerificationCode_userId_fkey`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SmsConfig` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'tencent',
    `secretId` VARCHAR(191) NOT NULL,
    `secretKey` VARCHAR(191) NOT NULL,
    `signName` VARCHAR(191) NOT NULL,
    `templateCode` VARCHAR(191) NOT NULL,
    `sdkAppId` VARCHAR(191) NULL,
    `region` VARCHAR(191) NOT NULL DEFAULT 'ap-guangzhou',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModelPricing` (
    `id` VARCHAR(191) NOT NULL,
    `modelId` VARCHAR(191) NOT NULL,
    `modelName` VARCHAR(191) NOT NULL,
    `pricingMode` VARCHAR(191) NOT NULL DEFAULT 'per_request',
    `pricePerRequest` INTEGER NOT NULL DEFAULT 1,
    `pricePerInputToken` INTEGER NOT NULL DEFAULT 0,
    `pricePerOutputToken` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ModelPricing_modelId_key`(`modelId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MediaPricing` (
    `id` VARCHAR(191) NOT NULL,
    `taskType` VARCHAR(191) NOT NULL,
    `taskName` VARCHAR(191) NOT NULL,
    `pricingMode` VARCHAR(191) NOT NULL,
    `pricePerRequest` INTEGER NOT NULL DEFAULT 1,
    `pricePerInputSecond` DOUBLE NOT NULL DEFAULT 0,
    `defaultEstimatedSeconds` INTEGER NOT NULL DEFAULT 60,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MediaPricing_taskType_key`(`taskType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MediaTaskRecord` (
    `id` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `taskType` VARCHAR(191) NOT NULL,
    `estimatedAmount` INTEGER NOT NULL,
    `settledAmount` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `inputSeconds` DOUBLE NULL,
    `agentSettledAmount` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settledAt` DATETIME(3) NULL,

    UNIQUE INDEX `MediaTaskRecord_taskId_key`(`taskId`),
    INDEX `MediaTaskRecord_userId_idx`(`userId`),
    INDEX `MediaTaskRecord_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiUsageRecord` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `modelId` VARCHAR(191) NOT NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `totalTokens` INTEGER NOT NULL DEFAULT 0,
    `creditsCharged` INTEGER NOT NULL DEFAULT 0,
    `pricingMode` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `isPartialDeduct` BOOLEAN NOT NULL DEFAULT false,
    `creditTransactionId` VARCHAR(191) NULL,
    `channelType` VARCHAR(191) NULL,
    `channelId` VARCHAR(191) NULL,
    `correlationId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `requestContent` MEDIUMTEXT NULL,
    `responseContent` MEDIUMTEXT NULL,

    UNIQUE INDEX `AiUsageRecord_creditTransactionId_key`(`creditTransactionId`),
    INDEX `AiUsageRecord_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `AiUsageRecord_modelId_createdAt_idx`(`modelId`, `createdAt`),
    INDEX `AiUsageRecord_channelType_createdAt_idx`(`channelType`, `createdAt`),
    INDEX `AiUsageRecord_correlationId_idx`(`correlationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SiteConfig` (
    `id` VARCHAR(191) NOT NULL,
    `siteName` VARCHAR(191) NOT NULL DEFAULT 'AI员工',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `defaultModelDisplayName` VARCHAR(191) NOT NULL DEFAULT '40+模型自动切换',
    `defaultProviderName` VARCHAR(191) NOT NULL DEFAULT '超级大模型',
    `customerServiceQrCodeUrl` MEDIUMTEXT NULL,
    `aiApiToken` MEDIUMTEXT NULL,
    `aiApiBaseUrl` VARCHAR(191) NULL DEFAULT 'https://zaozao.34ai.cc/api/v1',
    `aiApiChatModel` VARCHAR(191) NULL DEFAULT 'gpt-5.2',
    `aiApiImageModel` VARCHAR(191) NULL DEFAULT 'gpt-image-2',
    `freeMonthlyQuota` INTEGER NOT NULL DEFAULT 10,
    `winClientUrl` MEDIUMTEXT NULL,
    `macClientUrl` MEDIUMTEXT NULL,
    `activeVolcPlanType` VARCHAR(191) NOT NULL DEFAULT 'coding',
    `codingPlanDefaultModel` VARCHAR(191) NOT NULL DEFAULT 'deepseek-v4-flash',
    `agentPlanDefaultModel` VARCHAR(191) NOT NULL DEFAULT 'deepseek-v4-flash',
    `smsLoginEnabled` BOOLEAN NOT NULL DEFAULT true,
    `voiceAsrApiKey` VARCHAR(191) NOT NULL DEFAULT '',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CreditPackage` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `credits` INTEGER NOT NULL,
    `price` INTEGER NOT NULL,
    `priceDisplay` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CreditTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `amount` INTEGER NOT NULL,
    `balanceBefore` INTEGER NOT NULL,
    `balanceAfter` INTEGER NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `relatedOrderId` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CreditTransaction_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `CreditTransaction_type_idx`(`type`),
    INDEX `CreditTransaction_createdAt_idx`(`createdAt`),
    INDEX `CreditTransaction_relatedOrderId_fkey`(`relatedOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NOT NULL,
    `orderNo` VARCHAR(191) NOT NULL,
    `amount` INTEGER NOT NULL,
    `credits` INTEGER NOT NULL,
    `payMethod` VARCHAR(191) NOT NULL DEFAULT 'wechat',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `wechatTransactionId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_orderNo_key`(`orderNo`),
    INDEX `Order_userId_idx`(`userId`),
    INDEX `Order_status_idx`(`status`),
    INDEX `Order_createdAt_idx`(`createdAt`),
    INDEX `Order_packageId_fkey`(`packageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WechatPayConfig` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `mchId` VARCHAR(191) NOT NULL,
    `apiKey` MEDIUMTEXT NOT NULL,
    `apiV3Key` MEDIUMTEXT NULL,
    `certSerialNo` VARCHAR(191) NULL,
    `privateKey` MEDIUMTEXT NULL,
    `description` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `publicKey` MEDIUMTEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AudioMaterial` (
    `id` VARCHAR(191) NOT NULL,
    `audioUrl` MEDIUMTEXT NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AudioMaterial_phone_idx`(`phone`),
    INDEX `AudioMaterial_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FusionFolder` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FusionFolder_phone_idx`(`phone`),
    INDEX `FusionFolder_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FusionMaterial` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `folderId` VARCHAR(191) NOT NULL,
    `fileUrl` MEDIUMTEXT NOT NULL,
    `fileName` VARCHAR(191) NOT NULL DEFAULT '',
    `type` VARCHAR(191) NOT NULL DEFAULT 'video',
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `duration` DOUBLE NOT NULL DEFAULT 0,
    `tags` VARCHAR(1000) NOT NULL DEFAULT '',
    `isBroadcast` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FusionMaterial_phone_idx`(`phone`),
    INDEX `FusionMaterial_folderId_idx`(`folderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CloneRecord` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `sourceUrl` MEDIUMTEXT NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'polling',
    `resultUrl` MEDIUMTEXT NULL,
    `text` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CloneRecord_phone_idx`(`phone`),
    INDEX `CloneRecord_type_idx`(`type`),
    INDEX `CloneRecord_status_idx`(`status`),
    INDEX `CloneRecord_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ComposeVideo` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `videoUrl` MEDIUMTEXT NULL,
    `sceneTaskId` VARCHAR(191) NULL,
    `sourceAudioUrl` MEDIUMTEXT NULL,
    `composeType` VARCHAR(191) NOT NULL DEFAULT 'lipsync',
    `styleId` VARCHAR(191) NULL,
    `styleName` VARCHAR(191) NULL,
    `title` MEDIUMTEXT NULL,
    `materials` MEDIUMTEXT NULL,
    `cloneAudioUrl` MEDIUMTEXT NULL,
    `text` MEDIUMTEXT NULL,
    `cloneTaskId` VARCHAR(191) NULL,
    `musetalkTaskId` VARCHAR(191) NULL,
    `smartClipTaskId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'cloning_audio',
    `resultUrl` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ComposeVideo_phone_idx`(`phone`),
    INDEX `ComposeVideo_status_idx`(`status`),
    INDEX `ComposeVideo_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OssConfig` (
    `id` VARCHAR(191) NOT NULL,
    `accessKeyId` VARCHAR(191) NOT NULL,
    `accessKeySecret` MEDIUMTEXT NOT NULL,
    `bucketName` VARCHAR(191) NOT NULL,
    `endpoint` VARCHAR(191) NOT NULL,
    `region` VARCHAR(191) NOT NULL DEFAULT 'oss-cn-hangzhou',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiEmployee` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `nameEn` VARCHAR(191) NOT NULL DEFAULT '',
    `title` VARCHAR(191) NOT NULL DEFAULT '',
    `titleEn` VARCHAR(191) NOT NULL DEFAULT '',
    `avatarUrl` VARCHAR(191) NOT NULL DEFAULT '',
    `description` VARCHAR(191) NOT NULL DEFAULT '',
    `mission` VARCHAR(191) NOT NULL DEFAULT '',
    `coreDirective` VARCHAR(191) NOT NULL DEFAULT '',
    `price` INTEGER NOT NULL DEFAULT 0,
    `priceDisplay` VARCHAR(191) NOT NULL DEFAULT '',
    `tags` VARCHAR(191) NOT NULL DEFAULT '[]',
    `capabilities` VARCHAR(191) NOT NULL DEFAULT '[]',
    `kpi` VARCHAR(191) NOT NULL DEFAULT '[]',
    `tools` VARCHAR(191) NOT NULL DEFAULT '[]',
    `systemLogs` VARCHAR(191) NOT NULL DEFAULT '[]',
    `parentSlug` VARCHAR(191) NULL,
    `center` VARCHAR(191) NOT NULL DEFAULT '',
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `soulContent` MEDIUMTEXT NULL,
    `agentConfig` MEDIUMTEXT NULL,
    `skillSlugs` VARCHAR(191) NOT NULL DEFAULT '[]',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isBundled` BOOLEAN NOT NULL DEFAULT false,
    `downloads` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiEmployee_slug_key`(`slug`),
    INDEX `AiEmployee_parentSlug_idx`(`parentSlug`),
    INDEX `AiEmployee_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiEmployeePurchase` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `employeeSlug` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `purchasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NULL,
    `durationDays` INTEGER NULL,
    `orderNo` VARCHAR(191) NULL,
    `pricePerDay` INTEGER NOT NULL DEFAULT 0,

    INDEX `AiEmployeePurchase_userId_idx`(`userId`),
    INDEX `AiEmployeePurchase_employeeId_idx`(`employeeId`),
    INDEX `AiEmployeePurchase_status_idx`(`status`),
    INDEX `AiEmployeePurchase_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `AiEmployeePurchase_userId_employeeId_key`(`userId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeOrder` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `employeeSlug` VARCHAR(191) NOT NULL,
    `orderNo` VARCHAR(191) NOT NULL,
    `durationDays` INTEGER NOT NULL,
    `pricePerDay` INTEGER NOT NULL,
    `totalAmount` INTEGER NOT NULL,
    `payMethod` VARCHAR(191) NOT NULL DEFAULT 'wechat',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `wechatTransactionId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NOT NULL,
    `employeeExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EmployeeOrder_orderNo_key`(`orderNo`),
    INDEX `EmployeeOrder_userId_idx`(`userId`),
    INDEX `EmployeeOrder_status_idx`(`status`),
    INDEX `EmployeeOrder_employeeSlug_idx`(`employeeSlug`),
    INDEX `EmployeeOrder_createdAt_idx`(`createdAt`),
    INDEX `EmployeeOrder_employeeId_fkey`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContentCollection` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `link` MEDIUMTEXT NULL,
    `contentSummary` MEDIUMTEXT NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `mustUse` BOOLEAN NOT NULL DEFAULT false,
    `isUsed` BOOLEAN NOT NULL DEFAULT false,
    `operationType` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ContentCollection_phone_idx`(`phone`),
    INDEX `ContentCollection_category_idx`(`category`),
    INDEX `ContentCollection_mustUse_idx`(`mustUse`),
    INDEX `ContentCollection_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyDistribution` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `summaryContent` MEDIUMTEXT NOT NULL,
    `posterImage` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `distributedAt` DATETIME(3) NULL,

    INDEX `DailyDistribution_phone_idx`(`phone`),
    INDEX `DailyDistribution_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PotentialCustomer` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `company` VARCHAR(191) NULL,
    `wechatNickname` VARCHAR(191) NULL,
    `industry` VARCHAR(191) NULL,
    `position` VARCHAR(191) NULL,
    `lastCommDate` DATETIME(3) NULL,
    `addWechatDate` DATETIME(3) NULL,
    `interaction` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PotentialCustomer_phone_idx`(`phone`),
    INDEX `PotentialCustomer_lastCommDate_idx`(`lastCommDate`),
    INDEX `PotentialCustomer_addWechatDate_idx`(`addWechatDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TodayCommunication` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `potentialCustomerId` VARCHAR(191) NULL,
    `wechatNickname` VARCHAR(191) NULL,
    `seedingContent` MEDIUMTEXT NULL,
    `communicationStrategy` MEDIUMTEXT NULL,
    `commDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualCommContent` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TodayCommunication_phone_idx`(`phone`),
    INDEX `TodayCommunication_commDate_idx`(`commDate`),
    INDEX `TodayCommunication_wechatNickname_idx`(`wechatNickname`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerProfile` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `company` VARCHAR(191) NULL,
    `wechatNickname` VARCHAR(191) NULL,
    `industry` VARCHAR(191) NULL,
    `position` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `potentialCustomerId` VARCHAR(191) NULL,
    `lastCommDate` DATETIME(3) NULL,
    `dealAmount` DOUBLE NOT NULL DEFAULT 0,
    `collectDate` DATETIME(3) NULL,
    `responsiblePerson` VARCHAR(191) NULL,
    `addWechatDate` DATETIME(3) NULL,
    `satisfaction` VARCHAR(191) NULL,
    `dealDate` DATETIME(3) NULL,
    `remark` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CustomerProfile_phone_idx`(`phone`),
    INDEX `CustomerProfile_wechatNickname_idx`(`wechatNickname`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StrategySummary` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `content` MEDIUMTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `StrategySummary_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerCollection` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(191) NULL,
    `link` MEDIUMTEXT NULL,
    `wechat` VARCHAR(191) NULL,
    `introduction` MEDIUMTEXT NULL,
    `followerCount` INTEGER NULL,
    `collectTime` DATETIME(3) NULL,
    `isWechatAdded` BOOLEAN NOT NULL DEFAULT false,
    `wechatAddedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CustomerCollection_phone_idx`(`phone`),
    INDEX `CustomerCollection_isWechatAdded_idx`(`isWechatAdded`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserChatPrompt` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `wechatNickname` VARCHAR(191) NOT NULL,
    `prompt` MEDIUMTEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserChatPrompt_phone_idx`(`phone`),
    INDEX `UserChatPrompt_wechatNickname_idx`(`wechatNickname`),
    UNIQUE INDEX `UserChatPrompt_phone_wechatNickname_key`(`phone`, `wechatNickname`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemInfo` (
    `id` VARCHAR(191) NOT NULL,
    `agentServerUrl` VARCHAR(191) NOT NULL DEFAULT 'https://agent.topagent.cc',
    `computeApiToken` VARCHAR(191) NULL,
    `siteDomain` VARCHAR(191) NULL,
    `serverIp` VARCHAR(191) NULL,
    `isAuthorized` BOOLEAN NOT NULL DEFAULT false,
    `lastVerifiedAt` DATETIME(3) NULL,
    `authorizedAt` DATETIME(3) NULL,
    `piracyContactWechat` VARCHAR(191) NOT NULL DEFAULT '18625522203',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `agentPlanEnabled` BOOLEAN NOT NULL DEFAULT true,
    `agentPlanAfpToCreditsRate` DOUBLE NOT NULL DEFAULT 5,
    `agentQuoteRateToAdmin` DOUBLE NOT NULL DEFAULT 0.005,
    `agentVolcCostRate` DOUBLE NOT NULL DEFAULT 0.002,
    `agentPlanExtraConfig` MEDIUMTEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RedemptionCode` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'unused',
    `expiresAt` DATETIME(3) NULL,
    `validDays` INTEGER NULL,
    `usedByUserId` VARCHAR(191) NULL,
    `usedAt` DATETIME(3) NULL,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RedemptionCode_code_key`(`code`),
    INDEX `RedemptionCode_status_packageId_idx`(`status`, `packageId`),
    INDEX `RedemptionCode_batchId_idx`(`batchId`),
    INDEX `RedemptionCode_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProxyToken` ADD CONSTRAINT `ProxyToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VerificationCode` ADD CONSTRAINT `VerificationCode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiUsageRecord` ADD CONSTRAINT `AiUsageRecord_creditTransactionId_fkey` FOREIGN KEY (`creditTransactionId`) REFERENCES `CreditTransaction`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiUsageRecord` ADD CONSTRAINT `AiUsageRecord_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CreditTransaction` ADD CONSTRAINT `CreditTransaction_relatedOrderId_fkey` FOREIGN KEY (`relatedOrderId`) REFERENCES `Order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CreditTransaction` ADD CONSTRAINT `CreditTransaction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `CreditPackage`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FusionFolder` ADD CONSTRAINT `FusionFolder_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `FusionFolder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FusionMaterial` ADD CONSTRAINT `FusionMaterial_folderId_fkey` FOREIGN KEY (`folderId`) REFERENCES `FusionFolder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiEmployeePurchase` ADD CONSTRAINT `AiEmployeePurchase_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `AiEmployee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiEmployeePurchase` ADD CONSTRAINT `AiEmployeePurchase_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmployeeOrder` ADD CONSTRAINT `EmployeeOrder_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `AiEmployee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmployeeOrder` ADD CONSTRAINT `EmployeeOrder_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
