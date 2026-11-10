#!/usr/bin/env node
/**
 * P39 员工端到端审核：逐个员工投真实任务，记录耗时/步数/工具/产出/失败原因。
 * 用法（生产机）：FCM_API_BASE=http://127.0.0.1:3000/api FCM_PHONE=13900000002 node prod-audit-employees.mjs
 */
const BASE = process.env.FCM_API_BASE || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const OUT = process.env.FCM_AUDIT_OUT || "/tmp/audit-employees.json";
const ONLY = (process.env.FCM_AUDIT_ONLY || "").split(",").filter(Boolean);
const timeoutMs = Number(process.env.FCM_AUDIT_TIMEOUT_MS || 12 * 60 * 1000);
let token = "";

const COMMENTS = "评论1：多少钱一套？我们厂想做短视频但没人。\n评论2：广州能上门吗\n评论3：已关注，求报价\n评论4：这个效果不错\n评论5：我们是做门窗的，抖音号0粉，你们能代运营吗？预算不多";

const TASKS = [
  ["boss-lead-radar", "帮我找 5 家广州的跨境电商公司作为潜在客户，给出公司名、官网、匹配理由和触达建议。"],
  ["boss-industry-researcher", "研究中国宠物殡葬行业 2025 年的市场规模、主要玩家和进入门槛，写一份带来源的简报。"],
  ["boss-investment-researcher", "帮我分析一个咖啡连锁加盟项目的投资价值：输出支持观点、反对观点和继续尽调清单。"],
  ["boss-blogger-deconstructor", "拆解一个抖音企业账号的定位与选题体系，并给出可借鉴的原创增长方案。账号：某佛山门窗厂老板IP（请用公开信息补充）。"],
  ["boss-competitor-viral-radar", "研究小红书露营装备类目近期爆款笔记的共同结构，给 5 条可借鉴但不抄袭的选题。"],
  ["boss-daily-lead-topics", "我们是广州的企业短视频代运营公司，客单价 3 万/年，客户是传统工厂老板。给今天 10 条短视频选题，分流量型、获客型、信任型、成交型。"],
  ["boss-comment-opportunity", "分析下面这批抖音评论，挑出高意向商机并给回复建议：\n" + COMMENTS],
  ["boss-chat-deal-analyzer", "客户原话：'你们这个多少钱？我先看看，我们老板还在犹豫，而且要对比几家。'\n判断成交障碍并给我下一句可以直接发的话。"],
  ["boss-private-lead-manager", "下面是我微信里的 6 个客户记录，帮我清洗分层，输出今天该联系谁、为什么、说什么：\n1 张总 佛山门窗 上周问过价格 未回\n2 李姐 广州美业 三个月前咨询 沉默\n3 王工 东莞五金 昨天说要看案例\n4 陈总 深圳电子 已报价未签\n5 赵总 广州教培 新加微信\n6 刘经理 佛山陶瓷 上周说预算批了"],
  ["boss-sales-followup", "根据上面的聊天与客户情况，给出今天的销售跟进清单和每人的下一句话。\n记录：张总问价未回；王工要看案例；陈总报价两周未签。"],
  ["boss-export-sales-agent", "为佛山一家 LED 灯具工厂找 5 家美国进口商/经销商线索，给出线索和第一封英文开发邮件。"],
  ["boss-geo-auditor", "诊断'广州企业短视频代运营'这类问题在 AI 搜索里的品牌可见度，给出测试问题清单和 GEO 改进建议。"],
  ["boss-video-lead-script", "写一条 60 秒口播脚本，主题是'为什么工厂老板必须自己做 IP'，要有前三秒钩子、口播稿、字幕重点和标题。"],
  ["boss-video-auto-editor", "工作区里有素材片段 audit-clip.mp4，先用 media_info 看时长分辨率，再用 media_process 剪出前 3 秒，并告诉我成片文件名。"],
  ["boss-wechat-publisher", "把我们公司简介写成一篇公众号文章，给出标题、摘要、正文和封面建议。公司：广州某企业短视频代运营，服务传统工厂老板。"],
  ["boss-xhs-lead-agent", "围绕'广州 小红书 代运营'做搜索获客，给出关键词、5 条笔记标题和评论区承接话术。"],
  ["boss-ai-team-orchestrator", "我下周目标：给公司带来 20 条有效销售线索。请拆成 5 个员工任务，写清负责人、输入、产出、截止时间和验收标准。"],
];

async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  for (let i = 0; i < 4; i += 1) {
    const sent = await call("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone: PHONE }) });
    const code = sent.body && (sent.body.devCode || (sent.body.data && sent.body.data.devCode));
    if (code) {
      const res = await call("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone: PHONE, code }) });
      const access = res.body && (res.body.accessToken || res.body.token || (res.body.data && res.body.data.accessToken));
      if (access) { token = access; console.log("LOGIN OK"); return; }
    }
    console.log("login retry after 62s: " + JSON.stringify(sent.body).slice(0, 160));
    await sleep(62000);
  }
  throw new Error("login failed");
}

async function ensureInstalled(slug) {
  const mine = await call("/employees/mine");
  const raw = (mine.body && (mine.body.items || mine.body.data || mine.body)) || [];
  const list = Array.isArray(raw) ? raw : [];
  const has = list.some((it) => it && (it.slug === slug || it.employeeSlug === slug || (it.employee && it.employee.slug === slug)));
  if (has) return { installed: true, source: "mine" };
  const ins = await call("/employees/" + slug + "/install", { method: "POST", body: JSON.stringify({}) });
  return { installed: ins.status < 400, installStatus: ins.status, message: JSON.stringify(ins.body).slice(0, 160) };
}

async function waitTask(id, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const res = await call("/employee-tasks/" + encodeURIComponent(id));
    last = res.body;
    const status = last && last.status;
    if (["succeeded", "failed", "awaiting_approval", "needs_input"].includes(status)) return { task: last, ms: Date.now() - started };
    if (Date.now() - started > 30000 && ["queued"].includes(status)) {
      // 队列没人拉就早退，不要干等 12 分钟
      if (Date.now() - started > 120000) return { task: last, ms: Date.now() - started, stuck: "queued" };
    }
    await sleep(6000);
  }
  return { task: last, ms: Date.now() - started, stuck: "timeout" };
}

await login();

// 审计素材：上传一个 3 秒小视频，供剪辑师使用
try {
  const fs = await import("node:fs");
  const src = process.env.FCM_AUDIT_CLIP || "/tmp/audit-clip.mp4";
  if (fs.existsSync(src)) {
    const b64 = fs.readFileSync(src).toString("base64");
    const up = await call("/workspace/upload", { method: "POST", body: JSON.stringify({ name: "audit-clip.mp4", base64: b64 }) });
    console.log("UPLOAD clip status=" + up.status);
  }
} catch (e) { console.log("upload skip: " + e.message); }

const results = [];
for (let i = 0; i < TASKS.length; i += 1) {
  const [slug, input] = TASKS[i];
  if (ONLY.length && !ONLY.includes(slug)) continue;
  const entry = { slug, at: new Date().toISOString() };
  try {
    const inst = await ensureInstalled(slug);
    entry.install = inst;
    if (!inst.installed) { entry.grade = "BLOCKED"; results.push(entry); console.log((i + 1) + "/" + TASKS.length + " " + slug + " BLOCKED " + JSON.stringify(inst).slice(0, 160)); continue; }
    const created = await call("/employees/" + slug + "/run", { method: "POST", body: JSON.stringify({ input, executor: "cloud", title: "P39 审计 " + slug }) });
    if (created.status >= 400 || !created.body || !created.body.id) { entry.grade = "ERR_RUN"; entry.error = JSON.stringify(created.body).slice(0, 300); results.push(entry); console.log((i + 1) + "/" + TASKS.length + " " + slug + " ERR_RUN " + entry.error); continue; }
    entry.taskId = created.body.id;
    const { task, ms, stuck } = await waitTask(created.body.id, slug);
    entry.ms = ms;
    entry.status = task && task.status;
    entry.stuck = stuck || null;
    entry.error = (task && task.error) || null;
    entry.outputChars = (task && typeof task.outputText === "string") ? task.outputText.length : 0;
    entry.outputHead = (task && typeof task.outputText === "string") ? task.outputText.slice(0, 300) : null;
    const meta = (task && task.outputMeta) || {};
    entry.model = meta.model || null;
    entry.steps = Array.isArray(meta.steps) ? meta.steps.map((s) => ({ tool: s.tool, ms: s.durationMs, ok: s.success })) : [];
    entry.toolCount = entry.steps.filter((s) => s.tool !== "finish" && s.tool !== "invalid").length;
    entry.invalidCount = entry.steps.filter((s) => s.tool === "invalid").length;
    entry.artifacts = Array.isArray(task && task.artifacts) ? task.artifacts.map((a) => ({ kind: a.kind, path: a.path, chars: (a.text || "").length })) : [];
    entry.media = Array.isArray(meta.media) ? meta.media.length : 0;
    entry.grade = entry.status === "failed" ? "FAIL" : (entry.outputChars >= 400 && entry.toolCount >= 1 ? "OK" : "WEAK");
  } catch (e) {
    entry.grade = "EXC";
    entry.error = String(e && e.message || e).slice(0, 300);
  }
  results.push(entry);
  console.log((i + 1) + "/" + TASKS.length + " " + slug + " grade=" + entry.grade + " status=" + entry.status + " ms=" + entry.ms + " chars=" + entry.outputChars + " tools=" + entry.toolCount + " invalid=" + entry.invalidCount + " art=" + (entry.artifacts ? entry.artifacts.length : 0) + (entry.error ? " err=" + String(entry.error).slice(0, 160) : ""));
  try {
    const fs = await import("node:fs");
    fs.writeFileSync(OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  } catch {}
  await sleep(3000);
}

const fs = await import("node:fs");
fs.writeFileSync(OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
const count = (g) => results.filter((r) => r.grade === g).length;
console.log("AUDIT DONE total=" + results.length + " OK=" + count("OK") + " WEAK=" + count("WEAK") + " FAIL=" + count("FAIL") + " BLOCKED=" + count("BLOCKED") + " ERR=" + count("ERR_RUN") + " EXC=" + count("EXC") + " out=" + OUT);
