#!/usr/bin/env node
// P49 定价体系冒烟：成本驱动公式、配置校验、重算幂等、试用积分、变更留痕。
// 零依赖，直接 require 已编译的 dist/billing/pricing.service.js + 本地 Prisma。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const require = createRequire(path.join(repo, "packages", "server", "package.json"));

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const file = path.join(repo, "packages", "server", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
loadEnv();

const { PrismaClient } = require("@prisma/client");
const { PricingService } = require(path.join(repo, "packages", "server", "dist", "billing", "pricing.service.js"));
const prisma = new PrismaClient();
const svc = new PricingService(prisma);

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("返回 false");
    passed += 1;
  } catch (e) {
    failures.push(name + " — " + (e && e.message ? e.message : String(e)));
  }
}
function eq(name, actual, expected) {
  check(name + " (期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual) + ")", () => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("不相等");
    return true;
  });
}

async function main() {
  const cfg = { creditsPerYuan: 100, targetMarginPercent: 100, minCreditsPerRequest: 1, trialCredits: 200, mediaCoinCny: 0.01 };
  // 1) 模型建议价：0.6/2.4 元每百万 token，毛利 100%，1 元 = 100 积分 ⇒ 60 / 240 积分每百万 token
  const row = { modelId: "doubao-seed-2.0-lite", pricingMode: "per_request", pricePerInputToken: 0, pricePerOutputToken: 0, pricePerRequest: 1, upstreamCostInputPerMillionCny: 0.6, upstreamCostOutputPerMillionCny: 2.4 };
  const s = svc.suggestModelPricing(row, cfg, { count: 10, avgInputTokens: 12600, avgOutputTokens: 1080 });
  eq("建议价切换为每百万 token 口径", s.pricingMode, "per_token_million");
  eq("输入售价 = 成本×(1+100%)×100", s.pricePerInputToken, 120);
  eq("输出售价 = 成本×(1+100%)×100", s.pricePerOutputToken, 480);
  eq("按实测 token 折算的单次积分", s.pricePerRequest, 3);
  eq("单次上游成本（元）", s.costPerRequestCny, 0.0102);
  eq("单次实际毛利倍数", s.marginPerRequest, 2.94);

  // 2) 无实测用量时不能算出离谱的建议价（兜底最低 1 积分）
  const sNo = svc.suggestModelPricing(row, cfg, null);
  eq("没有实测用量时单次建议价兜底为最低值", sNo.pricePerRequest, 1);
  check("没有实测用量时毛利标记为 null", () => sNo.marginPerRequest === null);

  // 3) 未填成本要有提示
  const sZero = svc.suggestModelPricing({ modelId: "x", upstreamCostInputPerMillionCny: 0, upstreamCostOutputPerMillionCny: 0 }, cfg, null);
  check("未填成本时给出中文提示", () => /未填写/.test(sZero.note));

  // 4) 媒体建议价：157 币 × 0.01 元 = 1.57 元，毛利 100% ⇒ 314 积分
  const m1 = svc.suggestMediaPricing({ taskType: "image_gen", pricingMode: "per_request", pricePerRequest: 20, pricePerInputSecond: 0, upstreamUnit: "coins", upstreamCoinsPerUnit: 157, upstreamUnitCostCny: 0 }, cfg);
  eq("媒体单位成本折算", m1.unitCostCny, 1.57);
  eq("媒体按次建议价", m1.pricePerRequest, 314);
  const m2 = svc.suggestMediaPricing({ taskType: "lipsync", pricingMode: "per_input_second", pricePerRequest: 1, pricePerInputSecond: 1.2, upstreamUnit: "coins", upstreamCoinsPerUnit: 23, upstreamUnitCostCny: 0 }, cfg);
  eq("按秒计价媒体建议价", m2.pricePerInputSecond, 46);
  const m3 = svc.suggestMediaPricing({ taskType: "file_upload", pricingMode: "per_request", pricePerRequest: 2, pricePerInputSecond: 0, upstreamUnit: "cny", upstreamCoinsPerUnit: 0, upstreamUnitCostCny: 0 }, cfg);
  check("媒体未填成本时给出提示", () => /未填写/.test(m3.note));

  // 5) 全局参数单例存在且默认合理
  const live = await svc.getConfig(true);
  check("PricingConfig 单例存在", () => live && live.id === "global");
  check("1 元兑换积分为正整数", () => Number.isInteger(live.creditsPerYuan) && live.creditsPerYuan > 0);
  eq("试用赠送积分来自库内配置", await svc.trialCredits(), Math.max(0, Number(live.trialCredits)));

  // 6) 计费公式：按百万 token + 最低值兜底
  const modelId = "doubao-seed-2.0-lite";
  const original = await prisma.modelPricing.findUnique({ where: { modelId } });
  await prisma.modelPricing.update({ where: { modelId }, data: { pricingMode: "per_token_million", pricePerInputToken: 60, pricePerOutputToken: 240 } });
  eq("1.26 万输入 + 1080 输出 = 2 积分", await svc.calculatePrice(modelId, 12600, 1080), 2);
  eq("极小用量兜底最低 1 积分", await svc.calculatePrice(modelId, 10, 10), 1);
  await prisma.modelPricing.update({ where: { modelId }, data: { pricingMode: original.pricingMode, pricePerInputToken: original.pricePerInputToken, pricePerOutputToken: original.pricePerOutputToken, pricePerRequest: original.pricePerRequest } });
  check("未登记的模型回落到最低 1 积分", async () => (await svc.calculatePrice("no-such-model", 100, 100)) === 1);

  // 6b) 模型标识容错：别名 / 上游 id / 不同写法（点 vs 横线）都必须命中同一行定价
  const rowByAlias = await svc.findPricingRow("doubao-seed-2.0-lite");
  check("别名能命中定价行", () => !!rowByAlias && rowByAlias.modelId === "doubao-seed-2.0-lite");
  const upstreamOfLite = rowByAlias && rowByAlias.upstreamModelId;
  const rowByUpstream = upstreamOfLite ? await svc.findPricingRow(upstreamOfLite) : null;
  check("上游 model id 能命中同一行（" + upstreamOfLite + "）", () => !!rowByUpstream && rowByUpstream.modelId === "doubao-seed-2.0-lite");
  const rowByDashed = await svc.findPricingRow("doubao-seed-2-0-lite");
  check("横线写法能命中同一行", () => !!rowByDashed && rowByDashed.modelId === "doubao-seed-2.0-lite");
  const rowByDashedVersion = await svc.findPricingRow("doubao-seed-2-0-lite-260428");
  check("带版本号的上游 id 能命中同一行", () => !!rowByDashedVersion && rowByDashedVersion.modelId === "doubao-seed-2.0-lite");
  check("完全陌生的模型返回 null", async () => (await svc.findPricingRow("totally-unknown-model-x")) === null);
  // 计费必须按命中的定价行算：横线写法 1.26 万输入 + 1080 输出 = 2 积分（而非回落 1 积分）
  await prisma.modelPricing.update({ where: { modelId }, data: { pricingMode: "per_token_million", pricePerInputToken: 60, pricePerOutputToken: 240 } });
  svc.clearCache();
  eq("横线写法同样按百万 token 计费（2 积分）", await svc.calculatePrice("doubao-seed-2-0-lite", 12600, 1080), 2);
  await prisma.modelPricing.update({ where: { modelId }, data: { pricingMode: original.pricingMode, pricePerInputToken: original.pricePerInputToken, pricePerOutputToken: original.pricePerOutputToken, pricePerRequest: original.pricePerRequest } });
  svc.clearCache();

  // 7) 配置校验（非法值必须报中文 400）
  async function expectBad(patch, keyword) {
    try {
      await svc.updateConfig(patch, "smoke");
      throw new Error("没有报错");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (!msg.includes(keyword)) throw new Error("报错文案不符：" + msg);
    }
  }
  await expectBad({ mediaCoinCny: -1 }, "币价");
  await expectBad({ creditsPerYuan: 0 }, "兑换积分");
  await expectBad({ minCreditsPerRequest: 0 }, "最低积分");
  await expectBad({ trialCredits: -5 }, "试用积分");
  await expectBad({ targetMarginPercent: -1 }, "目标毛利");

  // 8) 重算幂等：apply 后再 preview 应无差异；配置改动要留痕
  const beforeCfg = { targetMarginPercent: live.targetMarginPercent, trialCredits: live.trialCredits, minCreditsPerRequest: live.minCreditsPerRequest, creditsPerYuan: live.creditsPerYuan, mediaCoinCny: live.mediaCoinCny };
  try {
    const applied = await svc.recalc({ mode: "apply", operator: "smoke", days: 30 });
    check("重算返回 applied 数量", () => typeof applied.applied === "number" && applied.applied >= 0);
    const again = await svc.recalc({ mode: "preview", operator: "smoke", days: 30 });
    eq("重算幂等（再次预览无差异）", again.changes.length, 0);
    const updated = await svc.updateConfig({ targetMarginPercent: beforeCfg.targetMarginPercent + 10 }, "smoke");
    eq("配置更新生效", updated.targetMarginPercent, beforeCfg.targetMarginPercent + 10);
    const logs = await svc.listChangeLog(5);
    check("变更留痕表有记录", () => Array.isArray(logs) && logs.length > 0);
    check("留痕含 config 作用域", () => logs.some((l) => l.scope === "config"));
    await svc.updateConfig(beforeCfg, "smoke");
  } finally {
    await svc.updateConfig(beforeCfg, "smoke-restore");
  }

  // 9) 后台总览结构
  const view = await svc.overview(30);
  check("总览返回 models/media/config", () => Array.isArray(view.models) && Array.isArray(view.media) && view.config && view.config.id === "global");
  check("总览每行都带成本与建议价", () => view.models.every((r) => r.cost && r.suggestion) && view.media.every((r) => r.suggestion));
  check("总览带 notes 数组", () => Array.isArray(view.notes));

  // 10) 新用户试用积分：注册即赠送（走真实 HTTP 登录链路，本地库）
  let base = String(process.env.FCM_API || "http://127.0.0.1:3000/api");
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (!base.endsWith("/api")) base += "/api";
  const phone = process.env.FCM_TRIAL_PHONE || "13700008881";
  async function postJson(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", connection: "close" }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  }
  try {
    // 清理上次残留
    const old = await prisma.user.findUnique({ where: { phone } });
    if (old) {
      await prisma.creditTransaction.deleteMany({ where: { userId: old.id } });
      await prisma.consentRecord.deleteMany({ where: { userId: old.id } });
      await prisma.verificationCode.deleteMany({ where: { phone } });
      await prisma.session.deleteMany({ where: { userId: old.id } });
      await prisma.user.delete({ where: { id: old.id } });
    }
    await postJson(base + "/auth/sms/send", { phone, scene: "login" });
    const codeRow = await prisma.verificationCode.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } });
    check("能拿到验证码（本地 dev）", () => !!(codeRow && codeRow.code));
    const login = await postJson(base + "/auth/sms/login", { phone, code: codeRow.code, consent: { version: "2026-11-12", crossBorder: true, source: "smoke" } });
    check("新手机号可注册登录", () => login.status < 400 && !!(login.json.accessToken || login.json.token));
    const user = await prisma.user.findUnique({ where: { phone } });
    const trial = Math.max(0, Number((await svc.getConfig(true)).trialCredits));
    eq("新用户余额 = 试用赠送积分", user ? user.credits : -1, trial);
    const gift = await prisma.creditTransaction.findFirst({ where: { userId: user.id, type: "gift" } });
    check("赠送有一条 gift 流水", () => !!gift && Number(gift.amount) === trial);
    check("赠送流水备注写明来源", () => !!gift && /试用/.test(gift.description || ""));
    // 清理
    await prisma.creditTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.consentRecord.deleteMany({ where: { userId: user.id } });
    await prisma.verificationCode.deleteMany({ where: { phone } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    const gone = await prisma.user.findUnique({ where: { phone } });
    check("测试账号已清理", () => gone === null);
  } catch (e) {
    check("试用积分链路（异常：" + (e && e.message ? e.message : e) + "）", () => { throw e; });
  }
  console.log((failures.length ? "PRICING SMOKE FAILED" : "PRICING SMOKE OK") + " (" + passed + " checks, " + failures.length + " failed)");
  for (const f of failures) console.log("  FAIL " + f);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("PRICING SMOKE ERROR", e && e.stack ? e.stack : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());