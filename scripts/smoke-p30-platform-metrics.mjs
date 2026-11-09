#!/usr/bin/env node
/**
 * P30 平台数据快照结构化 —— 零依赖单测。
 * 直接 require 服务端编译产物（与 P11/P16/P24 的 smoke 一致：先 build 再 smoke）。
 * 不连数据库、不启动服务、不发网络请求。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const mod = require("../packages/server/dist/capabilities/platform-metrics.js");
const { parsePlatformMetrics, parseCnNumber, descriptor, handler } = mod;

let pass = 0;
let fail = 0;
function ok(name) { pass += 1; console.log("[PASS] " + name); }
function bad(name, detail) { fail += 1; console.log("[FAIL] " + name + " :: " + detail); }
async function check(name, fn) {
  try { const v = await fn(); ok(name); return v; }
  catch (e) { bad(name, e && e.message ? e.message : String(e)); return undefined; }
}
function fixture(lines) { return lines.join("\n"); }
function metric(result, label) { return result.metrics.find((m) => m.label === label); }

// ============ 一、三种平台的真实排版 fixture ============

const DOUYIN = fixture([
  "抖音创作者中心",
  "数据概览",
  "播放量",
  "128.6万",
  "主页访问量 3.2万",
  "新增粉丝 1,234",
  "点赞量 8.9万",
  "评论数 4,567",
  "分享 890",
  "作品数",
  "36",
  "近7天播放量 45.6万",
  "周末去露营 播放12.3万 点赞4567 评论123",
  "春日vlog 8.8万 2,345 88 2026-01-02",
]);

const XIAOHONGSHU = fixture([
  "小红书创作中心",
  "笔记数据",
  "曝光数 1,234,567",
  "观看数 12.3万",
  "点赞数 8,765",
  "收藏数 4,321",
  "评论数 321",
  "粉丝数 5.6万",
  "笔记列表",
  "周末探店 2.3万 456 78 3天前",
]);

const SHIPINHAO = fixture([
  "视频号助手",
  "视频播放量 2亿",
  "点赞 12.3W",
  "评论 45",
  "分享 67",
  "粉丝 890",
  "收益(元) 1,234.56",
  "完播率 45.2%",
  "前天 播放量 8.8万",
]);

const douyin = parsePlatformMetrics("douyin", DOUYIN);
const xhs = parsePlatformMetrics("xiaohongshu", XIAOHONGSHU);
const sph = parsePlatformMetrics("shipinhao", SHIPINHAO);

await check("抖音 fixture：ok=true 且 platform=douyin", () => {
  assert.equal(douyin.ok, true);
  assert.equal(douyin.platform, "douyin");
});

await check("抖音 fixture：竖向「播放量 / 128.6万」解析为 1286000", () => {
  const m = metric(douyin, "播放量");
  assert.ok(m, "缺播放量");
  assert.equal(m.value, 1286000);
  assert.equal(m.raw, "128.6万");
});

await check("抖音 fixture：横向「主页访问量 3.2万」= 32000", () => {
  assert.equal(metric(douyin, "主页访问").value, 32000);
});

await check("抖音 fixture：千分位「新增粉丝 1,234」= 1234", () => {
  assert.equal(metric(douyin, "新增粉丝").value, 1234);
});

await check("抖音 fixture：点赞/评论/分享 全部命中", () => {
  assert.equal(metric(douyin, "点赞").value, 89000);
  assert.equal(metric(douyin, "评论").value, 4567);
  assert.equal(metric(douyin, "分享").value, 890);
});

await check("抖音 fixture：竖向「作品数 / 36」= 36", () => {
  assert.equal(metric(douyin, "作品数").value, 36);
});

await check("抖音 fixture：近7天播放量被去重，只保留第一次的 1286000", () => {
  const plays = douyin.metrics.filter((m) => m.label === "播放量");
  assert.equal(plays.length, 1);
  assert.equal(plays[0].value, 1286000);
});

await check("抖音 fixture：识别出 2 条作品", () => {
  assert.equal(douyin.works.length, 2, JSON.stringify(douyin.works));
});

await check("抖音作品1：标题 + 带标签的播放/点赞/评论", () => {
  const w = douyin.works[0];
  assert.equal(w.title, "周末去露营");
  assert.equal(w.playCount, 123000);
  assert.equal(w.likeCount, 4567);
  assert.equal(w.commentCount, 123);
  assert.equal(w.publishedAt, null);
});

await check("抖音作品2：裸数字按播放/点赞/评论顺序补位 + 日期原样保留", () => {
  const w = douyin.works[1];
  assert.equal(w.title, "春日vlog");
  assert.equal(w.playCount, 88000);
  assert.equal(w.likeCount, 2345);
  assert.equal(w.commentCount, 88);
  assert.equal(w.publishedAt, "2026-01-02");
  assert.ok(w.raw.indexOf("春日vlog") >= 0);
});

await check("小红书 fixture：ok=true 且指标齐全", () => {
  assert.equal(xhs.ok, true);
  assert.equal(metric(xhs, "曝光量").value, 1234567);
  assert.equal(metric(xhs, "播放量").value, 123000); // 观看数 归一为播放量
  assert.equal(metric(xhs, "点赞").value, 8765);
  assert.equal(metric(xhs, "收藏").value, 4321);
  assert.equal(metric(xhs, "评论").value, 321);
  assert.equal(metric(xhs, "粉丝").value, 56000);
});

await check("小红书作品：裸数字 + 相对时间「3天前」", () => {
  assert.equal(xhs.works.length, 1);
  const w = xhs.works[0];
  assert.equal(w.title, "周末探店");
  assert.equal(w.playCount, 23000);
  assert.equal(w.likeCount, 456);
  assert.equal(w.commentCount, 78);
  assert.equal(w.publishedAt, "3天前");
});

await check("视频号 fixture：复合标签「视频播放量 2亿」= 200000000", () => {
  assert.equal(sph.ok, true);
  assert.equal(metric(sph, "播放量").value, 200000000);
});

await check("视频号 fixture：大写 W「12.3W」= 123000", () => {
  assert.equal(metric(sph, "点赞").value, 123000);
});

await check("视频号 fixture：带括号单位「收益(元) 1,234.56」= 1234.56", () => {
  assert.equal(metric(sph, "收益").value, 1234.56);
});

await check("视频号 fixture：百分比按字面记录 45.2（不是 0.452）", () => {
  const m = metric(sph, "完播率");
  assert.ok(m);
  assert.equal(m.value, 45.2);
  assert.equal(m.raw, "45.2%");
});

await check("视频号 fixture：百分比会写进 notes 提醒不猜基数", () => {
  assert.ok(sph.notes.some((n) => n.indexOf("百分比") >= 0), JSON.stringify(sph.notes));
});

await check("视频号 fixture：「前天 播放量 8.8万」不覆盖已解析的 2亿", () => {
  assert.equal(metric(sph, "播放量").value, 200000000);
});

// ============ 二、parseCnNumber 单位/符号/空值 ============

await check("parseCnNumber：1.2万 = 12000", () => assert.equal(parseCnNumber("1.2万"), 12000));
await check("parseCnNumber：3.4w = 34000", () => assert.equal(parseCnNumber("3.4w"), 34000));
await check("parseCnNumber：12.3W = 123000", () => assert.equal(parseCnNumber("12.3W"), 123000));
await check("parseCnNumber：1,234 = 1234（千分位）", () => assert.equal(parseCnNumber("1,234"), 1234));
await check("parseCnNumber：2亿 = 200000000", () => assert.equal(parseCnNumber("2亿"), 200000000));
await check("parseCnNumber：1.5k = 1500", () => assert.equal(parseCnNumber("1.5k"), 1500));
await check("parseCnNumber：10万+ = 100000（去掉尾部加号）", () => assert.equal(parseCnNumber("10万+"), 100000));
await check("parseCnNumber：￥1,234.5 = 1234.5（去掉货币符号）", () => assert.equal(parseCnNumber("￥1,234.5"), 1234.5));
await check("parseCnNumber：全角「１.２万」= 12000", () => assert.equal(parseCnNumber("１.２万"), 12000));
await check("parseCnNumber：45.2% = 45.2（按字面）", () => assert.equal(parseCnNumber("45.2%"), 45.2));
await check("parseCnNumber：-- / — / 暂无 / 暂无数据 全部 null", () => {
  for (const raw of ["--", "—", "暂无", "暂无数据", "无数据"]) assert.equal(parseCnNumber(raw), null, raw);
});
await check("parseCnNumber：空串 / null / undefined / abc 全部 null", () => {
  assert.equal(parseCnNumber(""), null);
  assert.equal(parseCnNumber("   "), null);
  assert.equal(parseCnNumber(null), null);
  assert.equal(parseCnNumber(undefined), null);
  assert.equal(parseCnNumber("abc"), null);
});
await check("parseCnNumber：1e13 截到上限 1e12", () => assert.equal(parseCnNumber("10000000000000"), 1e12));

// ============ 三、去重 / 空值 / 英文标签 ============

await check("同 label 只保留第一次（播放量 100 / 播放 200 / 播放量 300）", () => {
  const r = parsePlatformMetrics("douyin", fixture(["播放量 100", "播放 200", "播放量 300"]));
  const plays = r.metrics.filter((m) => m.label === "播放量");
  assert.equal(plays.length, 1);
  assert.equal(plays[0].value, 100);
});

await check("空值横向行：粉丝 -- / 收藏：暂无 / 收益(元) -- 都是 value:null", () => {
  const r = parsePlatformMetrics("douyin", fixture(["粉丝 --", "收藏：暂无", "收益(元) --"]));
  assert.equal(metric(r, "粉丝").value, null);
  assert.equal(metric(r, "收藏").value, null);
  assert.equal(metric(r, "收益").value, null);
});

await check("英文标签：play/views/likes/comments/fans/followers 都能认且按 key 去重", () => {
  const r = parsePlatformMetrics("douyin", fixture(["play 12345", "views 6.7万", "likes 890", "comments 12", "fans 3.4k", "followers 2,000"]));
  assert.equal(metric(r, "播放量").value, 12345);
  assert.equal(metric(r, "点赞").value, 890);
  assert.equal(metric(r, "评论").value, 12);
  assert.equal(metric(r, "粉丝").value, 3400);
  assert.equal(r.metrics.filter((m) => m.label === "播放量").length, 1);
});

await check("同一作品行重复出现只保留一条", () => {
  const line = "春日vlog 8.8万 2,345 88 2026-01-02";
  const r = parsePlatformMetrics("douyin", fixture([line, line]));
  assert.equal(r.works.length, 1);
});

// ============ 四、脏文本 / 不崩 / 边界 ============

await check("脏文本（emoji、符号、制表符）不崩且能取到数字", () => {
  const r = parsePlatformMetrics("douyin", fixture(["🔥🔥 播放量 12.3亿", "@#￥%……&*（）——+ 点赞 --", "\t\t粉丝：暂无"]));
  assert.equal(r.ok, true);
  assert.equal(metric(r, "播放量").value, 1.23e9);
  assert.equal(metric(r, "点赞").value, null);
  assert.equal(metric(r, "粉丝").value, null);
});

await check("日期里的数字不会被当成指标：发布时间 2026-01-02 播放量 100", () => {
  const r = parsePlatformMetrics("douyin", fixture(["发布时间 2026-01-02 播放量 100"]));
  assert.equal(metric(r, "播放量").value, 100);
  assert.equal(r.works.length, 0);
});

await check("百分比涨幅行（较上周 +2.1%）不会被当成作品", () => {
  const r = parsePlatformMetrics("douyin", fixture(["较上周 +2.1%"]));
  assert.equal(r.works.length, 0);
});

await check("中文平台名也接受：抖音 -> douyin", () => {
  const r = parsePlatformMetrics("抖音", "播放量 100");
  assert.equal(r.platform, "douyin");
  assert.equal(r.ok, true);
});

// ============ 五、ok:false 分支（不 throw） ============

await check("平台非法：ok=false + 中文 notes + 空结果", () => {
  const r = parsePlatformMetrics("weibo", "播放量 100");
  assert.equal(r.ok, false);
  assert.equal(r.metrics.length, 0);
  assert.equal(r.works.length, 0);
  assert.ok(r.notes.some((n) => n.indexOf("不支持的平台") >= 0), JSON.stringify(r.notes));
});

await check("text 为空：ok=false + 「文本为空」", () => {
  const r = parsePlatformMetrics("douyin", "   \n\t ");
  assert.equal(r.ok, false);
  assert.ok(r.notes.some((n) => n.indexOf("文本为空") >= 0), JSON.stringify(r.notes));
});

await check("文本无任何数据：ok=false 且给出排查提示", () => {
  const r = parsePlatformMetrics("douyin", "今天天气不错，出去走走");
  assert.equal(r.ok, false);
  assert.ok(r.notes.some((n) => n.indexOf("未从文本中解析到") >= 0), JSON.stringify(r.notes));
});

await check("登录页文本：ok=false 且提示先扫码登录", () => {
  const r = parsePlatformMetrics("xiaohongshu", "请先登录\n扫码登录后查看数据");
  assert.equal(r.ok, false);
  assert.ok(r.notes.some((n) => n.indexOf("未登录") >= 0), JSON.stringify(r.notes));
});

await check("异常入参（null/undefined）不 throw，只回 ok=false", () => {
  const a = parsePlatformMetrics(null, null);
  const b = parsePlatformMetrics(undefined, undefined);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.ok(Array.isArray(a.notes) && a.notes.length > 0);
});

// ============ 六、能力描述符与注册 ============

await check("descriptor：name/category/params 契约", () => {
  assert.equal(descriptor.name, "platform_metrics_parse");
  assert.equal(descriptor.category, "platform");
  assert.deepEqual(Object.keys(descriptor.params).sort(), ["platform", "text"]);
  assert.ok(descriptor.description.indexOf("纯函数") >= 0);
});

await check("handler：合法参数返回结构化结果", async () => {
  const r = await handler({ userId: "u1", phone: null, params: { platform: "douyin", text: "播放量 100" } });
  assert.equal(r.ok, true);
  assert.equal(metric(r, "播放量").value, 100);
});

await check("handler：非法参数不抛异常，返回 ok=false", async () => {
  const r = await handler({ userId: "u1", phone: null, params: {} });
  assert.equal(r.ok, false);
  assert.ok(r.notes.length > 0);
});

await check("capability.service.ts 已注册 platform_metrics_parse", () => {
  const src = readFileSync(new URL("../packages/server/src/capabilities/capability.service.ts", import.meta.url), "utf8");
  assert.ok(src.indexOf("platform-metrics") >= 0, "缺 import");
  assert.ok(src.indexOf("platformMetricsDescriptor") >= 0, "缺描述符注册");
  assert.ok(src.indexOf("platform_metrics_parse: platformMetricsHandler") >= 0, "缺 handler 注册");
});

await check("worker 的 CAPABILITIES 没有加入 platform_metrics_parse（桌面/运维侧工具）", () => {
  const src = readFileSync(new URL("../packages/worker/tool-loop.mjs", import.meta.url), "utf8");
  assert.equal(src.indexOf("platform_metrics_parse"), -1);
});

console.log("");
if (fail > 0) {
  console.log("P30 platform-metrics SMOKE FAILED (" + fail + " failed, " + pass + " passed)");
  process.exit(1);
}
console.log("P30 platform-metrics SMOKE OK (" + pass + " checks)");
