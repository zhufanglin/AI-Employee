#!/usr/bin/env node
/**
 * 媒体任务取消冒烟：只测服务端取消 + 退款账本，不触网。
 * 运行：node scripts/smoke-media-cancel.mjs
 */
import { createRequire } from "node:module";

process.env.RUNNINGHUB_API_KEY = ""; // 先钉住，避免 ensureEnv 从 .env 读入真实 key 后真的去请求上游
const require = createRequire(import.meta.url);
const { MediaService } = require("../packages/server/dist/media/media.service.js");

let failures = 0;
let checks = 0;
const check = (label, ok, detail) => {
  checks += 1;
  if (ok) console.log("  [PASS] " + label);
  else { failures += 1; console.log("  [FAIL] " + label + (detail === undefined ? "" : " => " + JSON.stringify(detail))); }
};

function makePrisma(initial) {
  const state = { record: { ...initial }, refunds: [], userUpdates: [] };
  const match = (where) => {
    if (!state.record || status_of(state.record) === "deleted") return false;
    if (where.id && state.record.id !== where.id) return false;
    if (where.taskId && state.record.taskId !== where.taskId) return false;
    if (where.userId && state.record.userId !== where.userId) return false;
    if (where.status?.notIn && where.status.notIn.includes(status_of(state.record))) return false;
    return true;
  };
  const mediaTaskRecord = {
    findFirst: async ({ where }) => (match(where) ? { ...state.record } : null),
    findUnique: async ({ where }) => (match(where) ? { ...state.record } : null),
    findUniqueOrThrow: async () => ({ ...state.record }),
    updateMany: async ({ where, data }) => {
      if (!match(where)) return { count: 0 };
      state.record = { ...state.record, ...data };
      return { count: 1 };
    },
  };
  const tx = {
    mediaTaskRecord,
    $queryRaw: async () => [{ credits: 500 }],
    user: { update: async (args) => { state.userUpdates.push(args); return {}; } },
    creditTransaction: { create: async ({ data }) => { state.refunds.push(data); return data; } },
  };
  return { state, prisma: { mediaTaskRecord, $transaction: async (cb) => cb(tx) } };
}

const status_of = (record) => String(record?.status || "").toUpperCase();

const base = () => ({ id: "rec_1", taskId: "2118000000000001", userId: "u1", taskType: "image_gen", estimatedAmount: 157, settledAmount: null, status: "RUNNING", inputSeconds: 0, resultMeta: { note: "keep" }, createdAt: new Date() });

// 1) 正常取消：上游未配置时仍应本地退款并记账
{
  const { state, prisma } = makePrisma(base());
  const service = new MediaService(prisma, {});
  const result = await service.cancelTask("u1", "2118000000000001");
  check("取消后状态为 CANCELLED", status_of(result) === "CANCELLED", status_of(result));
  check("取消后 settledAmount 归零", result.settledAmount === 0, result.settledAmount);
  check("取消后保留原有 resultMeta 并记录 cancel", result.resultMeta?.note === "keep" && Boolean(result.resultMeta?.cancel), result.resultMeta);
  check("上游未配置时记录原因", result.resultMeta?.cancel?.ok === false && result.resultMeta?.cancel?.reason === "RUNNINGHUB_NOT_CONFIGURED", result.resultMeta?.cancel);
  check("退回全部预扣积分", state.userUpdates.length === 1 && state.userUpdates[0].data.credits.increment === 157, state.userUpdates[0]?.data);
  check("写入退款流水且金额一致", state.refunds.length === 1 && state.refunds[0].type === "refund" && state.refunds[0].amount === 157, state.refunds[0]);
  check("流水描述标明取消退款", String(state.refunds[0]?.description || "").includes("取消退款"), state.refunds[0]?.description);
}

// 2) 重复取消：状态已是 CANCELLED，应拒绝且不重复退款
{
  const { state, prisma } = makePrisma({ ...base(), status: "CANCELLED" });
  const service = new MediaService(prisma, {});
  let code = 0;
  try { await service.cancelTask("u1", "2118000000000001"); } catch (error) { code = error?.getStatus?.() ?? 0; }
  check("已取消任务再次取消返回 409", code === 409, code);
  check("已取消任务不再退款", state.refunds.length === 0, state.refunds.length);
}

// 3) 已完成任务不可取消
{
  const { state, prisma } = makePrisma({ ...base(), status: "SUCCESS", resultUrl: "https://x/y.jpg" });
  const service = new MediaService(prisma, {});
  let code = 0;
  try { await service.cancelTask("u1", "2118000000000001"); } catch (error) { code = error?.getStatus?.() ?? 0; }
  check("成功任务取消返回 409", code === 409, code);
  check("成功任务不退款", state.refunds.length === 0, state.refunds.length);
}

// 4) 越权取消：别人的任务返回 404
{
  const { prisma } = makePrisma(base());
  const service = new MediaService(prisma, {});
  let code = 0;
  try { await service.cancelTask("u2", "2118000000000001"); } catch (error) { code = error?.getStatus?.() ?? 0; }
  check("跨用户取消返回 404", code === 404, code);
}

// 5) 上游可用时记录上游结果（不打真网，替换 fetch）
{
  const { prisma } = makePrisma(base());
  const service = new MediaService(prisma, {});
  process.env.RUNNINGHUB_API_KEY = "test-key";
  process.env.RUNNINGHUB_BASE_URL = "https://runninghub.invalid";
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ code: 0, msg: "SUCCESS", data: null }) };
  };
  try {
    const result = await service.cancelTask("u1", "2118000000000001");
    check("取消请求打到 /task/openapi/cancel", calledUrl.endsWith("/task/openapi/cancel"), calledUrl);
    check("上游成功时记录 ok=true", result.resultMeta?.cancel?.ok === true, result.resultMeta?.cancel);
    check("上游成功时状态仍为 CANCELLED", status_of(result) === "CANCELLED", status_of(result));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.RUNNINGHUB_API_KEY = "";
  }
}

// 6) 已取消任务回查：不再请求上游，状态不会被顶回运行中
{
  const { prisma } = makePrisma({ ...base(), status: "CANCELLED", providerStatus: "CANCELLED" });
  const service = new MediaService(prisma, {});
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error("不应该回查上游"); };
  try {
    const task = await service.getTask("u1", "2118000000000001");
    check("已取消任务回查不请求上游", called === 0, called);
    check("已取消任务回查状态仍为 CANCELLED", status_of(task) === "CANCELLED", status_of(task));
  } finally { globalThis.fetch = originalFetch; }
}

console.log("");
if (failures) { console.log("MEDIA CANCEL SMOKE FAILED (" + failures + "/" + checks + ")"); process.exit(1); }
console.log("MEDIA CANCEL SMOKE OK (" + checks + " checks)");