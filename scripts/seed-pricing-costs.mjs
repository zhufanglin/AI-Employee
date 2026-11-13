#!/usr/bin/env node
// 按上游账单/公开价目给 ModelPricing / MediaPricing 填「上游成本」初始值（幂等，可用 --force 覆盖已有成本）。
// 用法：node scripts/seed-pricing-costs.mjs [--force] [--dry-run]
// 说明：这里的数字是「档位合理」的初始假设，运营应按火山方舟 / RunningHub 实际账单在后台改，代码与后续流程都不写死价格。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

function loadEnv() {
  const file = path.join(repo, "packages", "server", ".env");
  if (!process.env.DATABASE_URL && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const v = m[2].replace(/^"|"$/g, "");
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}
loadEnv();

// 兼容两种部署位置：仓库根（scripts/ 下）与生产 app 目录（脚本直接拷到 app/）
function findAppDir() {
  const cands = [here, path.join(repo, "packages", "server"), repo, path.join(here, "packages", "server")];
  for (const c of cands) {
    if (fs.existsSync(path.join(c, "node_modules", "@prisma", "client", "package.json"))) return c;
  }
  return path.join(repo, "packages", "server");
}
const require = createRequire(path.join(findAppDir(), "package.json"));
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const force = process.argv.includes("--force");
const dry = process.argv.includes("--dry-run");

// 元 / 百万 token（输入、输出）。来源：公开价目档位折算，待按账单校准。
const MODEL_COST = {
  "doubao-seed-2-0-lite-260428": [0.6, 2.4],
  "doubao-seed-2-1-turbo-260628": [1.2, 4.8],
  "doubao-seed-2-1-pro-260628": [4.0, 16.0],
  "doubao-seed-2-0-code-preview-260215": [3.0, 12.0],
  "glm-4-5-air-20250728": [0.8, 3.2],
};
const MODEL_NOTE = "按公开价目档位折算，待按火山方舟账单校准";

// 媒体：单位=币（RunningHub），币数按实测均值；1 币折元由 PricingConfig.mediaCoinCny 决定。
const MEDIA_COST = {
  image_gen: { unit: "coins", coins: 157, note: "实测文生图约 157 币/次（4 档尺寸）" },
  video_gen: { unit: "coins", coins: 150, note: "实测图生视频约 150 币/次" },
  lipsync: { unit: "coins", coins: 23, note: "实测对口型 3 秒约 69 币 ⇒ 约 23 币/秒" },
  indextts: { unit: "coins", coins: 0, note: "音色合成当前被禁用，成本待测" },
  smart_clip: { unit: "coins", coins: 0, note: "混剪按秒计费，币耗待按账单校准" },
  file_upload: { unit: "cny", coins: 0, note: "对象存储成本，按 OSS 账单校准" },
};

async function main() {
  const cfg = await prisma.pricingConfig.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  console.log("PricingConfig", JSON.stringify({ creditsPerYuan: cfg.creditsPerYuan, targetMarginPercent: cfg.targetMarginPercent, trialCredits: cfg.trialCredits, mediaCoinCny: cfg.mediaCoinCny }));
  const models = await prisma.modelPricing.findMany();
  let mCount = 0;
  for (const m of models) {
    const key = m.upstreamModelId ?? m.modelId;
    const cost = MODEL_COST[key];
    if (!cost) {
      console.log("SKIP", m.modelId, "no cost table entry for", key);
      continue;
    }
    const already = Number(m.upstreamCostInputPerMillionCny) > 0 && Number(m.upstreamCostOutputPerMillionCny) > 0 && m.costNote;
    if (already && !force) {
      console.log("KEEP", m.modelId, m.upstreamCostInputPerMillionCny + "/" + m.upstreamCostOutputPerMillionCny);
      continue;
    }
    mCount += 1;
    console.log((dry ? "DRY " : "SET ") + m.modelId, "=> " + cost[0] + " / " + cost[1] + " 元每百万 token");
    if (!dry) {
      await prisma.modelPricing.update({
        where: { id: m.id },
        data: { upstreamCostInputPerMillionCny: cost[0], upstreamCostOutputPerMillionCny: cost[1], costNote: MODEL_NOTE },
      });
    }
  }
  const media = await prisma.mediaPricing.findMany();
  let dCount = 0;
  for (const row of media) {
    const spec = MEDIA_COST[row.taskType];
    if (!spec) {
      console.log("SKIP", row.taskType, "no cost table entry");
      continue;
    }
    if (row.upstreamUnit === spec.unit && Number(row.upstreamCoinsPerUnit) === spec.coins && row.costNote && !force) {
      console.log("KEEP", row.taskType);
      continue;
    }
    dCount += 1;
    console.log((dry ? "DRY " : "SET ") + row.taskType, "=> unit=" + spec.unit + " coins=" + spec.coins);
    if (!dry) {
      await prisma.mediaPricing.update({
        where: { id: row.id },
        data: { upstreamUnit: spec.unit, upstreamCoinsPerUnit: spec.coins, upstreamUnitCostCny: 0, costNote: spec.note },
      });
    }
  }
  console.log("DONE models=" + mCount + " media=" + dCount + (dry ? " (dry-run)" : ""));
}

main().catch((e) => { console.error("FAILED", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());