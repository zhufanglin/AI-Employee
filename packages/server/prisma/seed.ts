/**
 * seed.ts -- 由生产库配置快照（2026-10-29 导出）生成的初始化数据
 * 敏感值统一走环境变量，不写死在代码里。
 */
import { PrismaClient } from "@prisma/client";
import { EMPLOYEES } from "./employees";
import { SKILL_CONTENT } from "./skills-content";

const prisma = new PrismaClient();
const env = (k: string, d = "") => process.env[k] ?? d;

async function main() {
  // ---------- SiteConfig（单行） ----------
  const site = {
    siteName: "AI员工",
    defaultModelDisplayName: "40+模型自动切换",
    defaultProviderName: "超级大模型",
    customerServiceQrCodeUrl: "",
    aiApiBaseUrl: env("AI_API_BASE_URL", "https://api.deepseek.com/v1"),
    aiApiToken: env("AI_API_TOKEN"),
    aiApiChatModel: env("AI_CHAT_MODEL", "deepseek-chat"),
    aiApiImageModel: env("AI_IMAGE_MODEL", ""),
    freeMonthlyQuota: 10,
    smsLoginEnabled: true,
    voiceAsrApiKey: env("VOICE_ASR_API_KEY"),
  };
  const existSite = await prisma.siteConfig.findFirst();
  if (existSite) await prisma.siteConfig.update({ where: { id: existSite.id }, data: site });
  else await prisma.siteConfig.create({ data: site });

  // ---------- SystemInfo（单行，去掉原版在线授权） ----------
  const sys = {
    siteDomain: "fcmediaagent.com",
    serverIp: env("SERVER_IP", ""),
    agentServerUrl: env("AGENT_SERVER_URL", ""),
    isAuthorized: true, // 复刻版不做在线授权校验
    agentPlanEnabled: false,
  };
  const existSys = await prisma.systemInfo.findFirst();
  if (existSys) await prisma.systemInfo.update({ where: { id: existSys.id }, data: sys });
  else await prisma.systemInfo.create({ data: sys });

  // ---------- ModelPricing（11 个，全部按次 1 积分） ----------
  // alias = 展示名（前端/compute/models 里用）；provider/upstreamModelId = 真正调上游的 id
  const models: Array<[string, string, string, string]> = [
    ["ark-code-latest", "40+模型自动切换", "ark", "doubao-seed-2-0-code-preview-260215"],
    ["doubao-seed-code", "Doubao Seed Code", "ark", "doubao-seed-2-0-code-preview-260215"],
    ["doubao-seed-2.0-code", "Doubao Seed 2.0 Code", "ark", "doubao-seed-2-0-code-preview-260215"],
    ["doubao-seed-2.0-pro", "Doubao Seed 2.0 Pro", "ark", "doubao-seed-2-1-pro-260628"],
    ["doubao-seed-2.0-lite", "Doubao Seed 2.0 Lite", "ark", "doubao-seed-2-0-lite-260428"],
    ["glm-5.1", "GLM 5.1", "ark", "glm-4-5-air-20250728"],
    ["deepseek-v3.2", "DeepSeek V3.2", "ark", "doubao-seed-2-1-pro-260628"],
    ["deepseek-v4-flash", "超级精调模型", "ark", "doubao-seed-2-1-turbo-260628"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro", "ark", "doubao-seed-2-1-pro-260628"],
    ["minimax-latest", "MiniMax Latest", "ark", "doubao-seed-2-1-pro-260628"],
    ["kimi-k2.6", "Kimi K2.6", "ark", "doubao-seed-2-1-pro-260628"],
  ];
  for (const [modelId, modelName, provider, upstreamModelId] of models) {
    await prisma.modelPricing.upsert({
      where: { modelId },
      update: { modelName, provider, upstreamModelId },
      // ⚠️ 占位价：原版全部 per_request=1（每对话 1 积分），未按 token 计费；上线前需决定是否改 per_token
      create: { modelId, modelName, provider, upstreamModelId, pricingMode: "per_request", pricePerRequest: 1, isActive: true },
    });
  }

  // ---------- MediaPricing（6 条） ----------
  // ⚠️ 占位价：数值来自原版生产库，仅用于功能联调；上线前必须由用户重新定价。
  // 说明与成本对照见 docs/定价-占位与待批注.md（T-17）
  const media = [
    { taskType: "smart_clip", taskName: "真人口播混剪", pricingMode: "per_input_second", pricePerRequest: 1, pricePerInputSecond: 0.5, defaultEstimatedSeconds: 60 },
    { taskType: "lipsync", taskName: "数字人对口型", pricingMode: "per_input_second", pricePerRequest: 1, pricePerInputSecond: 1.2, defaultEstimatedSeconds: 60 },
    { taskType: "file_upload", taskName: "临时文件上传", pricingMode: "per_request", pricePerRequest: 2, pricePerInputSecond: 0, defaultEstimatedSeconds: 60 },
    { taskType: "video_gen", taskName: "AI 视频生成", pricingMode: "per_request", pricePerRequest: 20, pricePerInputSecond: 0, defaultEstimatedSeconds: 60 },
    { taskType: "indextts", taskName: "IndexTTS 音色克隆", pricingMode: "per_request", pricePerRequest: 10, pricePerInputSecond: 0, defaultEstimatedSeconds: 60 },
    { taskType: "image_gen", taskName: "AI 图片生成", pricingMode: "per_request", pricePerRequest: 20, pricePerInputSecond: 0, defaultEstimatedSeconds: 60 },
  ];
  for (const m of media) {
    const exist = await prisma.mediaPricing.findFirst({ where: { taskType: m.taskType } });
    if (exist) await prisma.mediaPricing.update({ where: { id: exist.id }, data: m });
    else await prisma.mediaPricing.create({ data: m });
  }

  // ---------- CreditPackage ----------
  // ⚠️ 占位价：原版「999 积分 = 1 分钱」「9999 积分 = 1 元」是联调数据，不可对外售卖。
  // 改价请走 PATCH /api/admin/packages 或 SQL，改完不要重跑 seed（会覆盖回来）。见 docs/定价-占位与待批注.md
  const packs = [
    { name: "小康", credits: 999, price: 1, priceDisplay: "0.01", description: "", sort: 0 },
    { name: "黄金套餐", credits: 9999, price: 100, priceDisplay: "1", description: "", sort: 0 },
  ];
  for (const p of packs) {
    const exist = await prisma.creditPackage.findFirst({ where: { name: p.name } });
    if (exist) await prisma.creditPackage.update({ where: { id: exist.id }, data: p });
    else await prisma.creditPackage.create({ data: p });
  }

  // ---------- 短信 / OSS / 微信支付（密钥来自环境变量） ----------
  const sms = {
    provider: "aliyun",
    secretId: env("ALIYUN_SMS_ACCESS_KEY_ID"),
    secretKey: env("ALIYUN_SMS_ACCESS_KEY_SECRET"),
    signName: env("ALIYUN_SMS_SIGN_NAME", "中科元晟智科人工智能科技有限公司"),
    templateCode: env("ALIYUN_SMS_TEMPLATE_CODE", "SMS_512280223"),
    region: env("ALIYUN_SMS_REGION", "cn-hangzhou"),
    isActive: true,
  };
  const existSms = await prisma.smsConfig.findFirst();
  if (existSms) await prisma.smsConfig.update({ where: { id: existSms.id }, data: sms });
  else await prisma.smsConfig.create({ data: sms });

  const oss = {
    accessKeyId: env("OSS_ACCESS_KEY_ID"),
    accessKeySecret: env("OSS_ACCESS_KEY_SECRET"),
    bucketName: env("OSS_BUCKET", "zhongke001"),
    endpoint: env("OSS_ENDPOINT", "oss-cn-beijing.aliyuncs.com"),
    region: env("OSS_REGION", "oss-cn-beijing"),
    isActive: true,
  };
  const existOss = await prisma.ossConfig.findFirst();
  if (existOss) await prisma.ossConfig.update({ where: { id: existOss.id }, data: oss });
  else await prisma.ossConfig.create({ data: oss });

  const pay = {
    appId: env("WECHAT_PAY_APP_ID", "wx219da5e18416b3fd"),
    mchId: env("WECHAT_PAY_MCH_ID", "1118595998"),
    apiKey: env("WECHAT_PAY_API_KEY", ""),
    apiV3Key: env("WECHAT_PAY_API_V3_KEY"),
    certSerialNo: env("WECHAT_PAY_SERIAL_NO"),
    privateKey: env("WECHAT_PAY_PRIVATE_KEY", ""),
    isActive: true,
  };
  const existPay = await prisma.wechatPayConfig.findFirst();
  if (existPay) await prisma.wechatPayConfig.update({ where: { id: existPay.id }, data: pay });
  else await prisma.wechatPayConfig.create({ data: pay });

  // ---------- M6.5 员工目录：17 个 Skill 员工 ----------
  let withSkill = 0;
  for (const e of EMPLOYEES) {
    const skillMd = SKILL_CONTENT[e.slug] ?? null;
    if (skillMd) withSkill += 1;
    const data: any = { ...e, skillMd };
    await prisma.aiEmployee.upsert({
      where: { slug: e.slug },
      update: data,
      create: data,
    });
  }
  console.log("[seed] employees: " + EMPLOYEES.length);
  console.log("[seed] employees with skillMd: " + withSkill + "/" + EMPLOYEES.length);

  console.log("[seed] done");
}

main().finally(() => prisma.$disconnect());