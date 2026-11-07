#!/usr/bin/env node
/**
 * coord.mjs -- 跨 Agent 协作 + 故障接管总线（Codex / WorkBuddy / DeepSeek Harness 共用）
 *
 * 核心不是"分工"，是"接力"：任何一个 Agent 因额度不足、限流、崩溃、API 报错中途停下，
 * 另一个 Agent 都能用 takeover 从它停下的那一行继续，不需要重做、不需要问人。
 *
 * 磁盘即总线：
 *   docs/handoff/state.json                 单一事实源（任务/负责人/租约/阻塞原因）
 *   docs/handoff/checkpoints/<ID>.md        正在做的任务的实时断点（人+AI 可读）
 *   docs/handoff/checkpoints/<ID>.files.json 认领时的文件快照，用来算"失败后谁动过什么"
 *   docs/handoff/last-verify.json           最近一次 verify.ps1 的结果
 *   docs/handoff/JOURNAL.md                 追加流水账
 *   docs/handoff/inbox/<agent>.md           点对点留言
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const H = path.join(ROOT, "docs", "handoff");
const STATE = path.join(H, "state.json");
const JOURNAL = path.join(H, "JOURNAL.md");
const BOARD = path.join(H, "BOARD.md");
const INBOX = path.join(H, "inbox");
const CKPT = path.join(H, "checkpoints");
const MARKS = path.join(H, "marks");
const VERIFY = path.join(H, "last-verify.json");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : def; };
const flagAll = (name) => { const out = []; argv.forEach((a, i) => { if (a === "--" + name) out.push(argv[i + 1]); }); return out; };
const pos = argv.slice(1).filter((a, i) => !a.startsWith("--") && !(argv[i] && argv[i].startsWith("--")));
const now = () => new Date().toISOString();
const readState = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const writeState = (s) => { s.updatedAt = now(); fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n", "utf8"); };
const agents = ["dsh-lead", "codex", "workbuddy"];

function journal(line) {
  fs.mkdirSync(H, { recursive: true });
  if (!fs.existsSync(JOURNAL)) fs.writeFileSync(JOURNAL, "# 协作日志（追加式，最新在最下）\n\n", "utf8");
  fs.appendFileSync(JOURNAL, line + "\n", "utf8");
}
const jline = (agent, kind, text) => "- " + now() + " | " + agent + " | " + kind + " | " + text;

function syncBoard(s) {
  const L = [];
  L.push("# 任务看板（自动生成，勿手改）");
  L.push("");
  L.push("> 生成时间 " + now() + " · 单一事实源 `docs/handoff/state.json`");
  L.push("");
  L.push("**当前阶段**：" + s.phase + " —— " + (s.phaseGoal || ""));
  L.push("");
  L.push("| ID | 任务 | 状态 | 负责人 | 心跳 | 写作用域 |");
  L.push("|---|---|---|---|---|---|");
  for (const t of s.tasks) {
    const hb = t.lease && t.lease.heartbeat ? t.lease.heartbeat.slice(5, 16).replace("T", " ") : "-";
    L.push("| " + t.id + " | " + t.title + " | " + (t.status + (t.lease && t.lease.reason ? "(" + t.lease.reason + ")" : "")) + " | " + (t.owner || "-") + " | " + hb + " | " + ((t.scope || []).join(", ") || "-") + " |");
  }
  L.push("");
  const active = s.tasks.filter((t) => t.status !== "done");
  L.push("**未完成任务详情**");
  for (const t of active) {
    L.push("");
    L.push("### " + t.id + " · " + t.title);
    L.push("- 状态：" + t.status + (t.owner ? " · 负责人：" + t.owner : " · （未认领）"));
    L.push("- 验收：" + (t.accept || "-"));
    L.push("- 写作用域：" + ((t.scope || []).join(", ") || "-"));
    const cp = path.join(CKPT, t.id + ".md");
    if (fs.existsSync(cp)) L.push("- 断点：`docs/handoff/checkpoints/" + t.id + ".md`");
  }
  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(BOARD, L.join("\n") + "\n", "utf8");
}

/* ---------- 文件快照：用于"失败后谁动过什么" ---------- */
const IGNORE = ["node_modules", ".git", "out", "dist", "build", ".cache", "release", ".vite"];
function walk(dir, out, depth) {
  if (depth > 8 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile()) {
      try { const st = fs.statSync(p); out.push({ p: path.relative(ROOT, p).replaceAll("\\", "/"), size: st.size, mtime: Math.round(st.mtimeMs) }); } catch {}
    }
    if (out.length > 40000) return out;
  }
  return out;
}
function snapshotScopes(scope) {
  const files = [];
  for (const s of scope || []) {
    const target = path.join(ROOT, s);
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      files.push({ p: path.relative(ROOT, target).replaceAll("\\", "/"), size: stat.size, mtime: Math.round(stat.mtimeMs) });
    } else if (stat.isDirectory()) {
      walk(target, files, 0);
    }
  }
  return files;
}
function ckptJson(id) { return path.join(CKPT, id + ".files.json"); }
function ckptMd(id) { return path.join(CKPT, id + ".md"); }
function readFiles(id) { try { return JSON.parse(fs.readFileSync(ckptJson(id), "utf8")); } catch { return null; } }

function filesChanged(id, scope) {
  const old = readFiles(id);
  if (!old) return { note: "没有认领快照（可能是 legacy 任务）" };
  const before = new Map(old.map((f) => [f.p, f]));
  const cur = snapshotScopes(scope);
  const added = [], modified = [], removed = [];
  for (const f of cur) {
    const b = before.get(f.p);
    if (!b) added.push(f.p);
    else if (b.size !== f.size || b.mtime !== f.mtime) modified.push(f.p);
  }
  const curSet = new Set(cur.map((f) => f.p));
  for (const f of old) if (!curSet.has(f.p)) removed.push(f.p);
  return { added, modified, removed, totalBefore: old.length, totalNow: cur.length };
}

function readLastVerify() { try { return JSON.parse(fs.readFileSync(VERIFY, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } }

/* ---------- 断点 ---------- */
function writeCheckpoint(t, s) {
  fs.mkdirSync(CKPT, { recursive: true });
  const c = t.checkpoint || {};
  const L = [];
  L.push("# " + t.id + " · " + t.title);
  L.push("");
  L.push("| 字段 | 值 |");
  L.push("|---|---|");
  L.push("| 状态 | " + t.status + " |");
  L.push("| 负责人 | " + (t.owner || "-") + " |");
  L.push("| 认领时间 | " + ((t.lease && t.lease.at) || "-") + " |");
  L.push("| 最后心跳 | " + ((t.lease && t.lease.heartbeat) || "-") + " |");
  L.push("| 阻塞原因 | " + ((t.lease && t.lease.reason) || "-") + " |");
  L.push("| 验收标准 | " + (t.accept || "-") + " |");
  L.push("");
  L.push("## 进度（勾掉的是已完成）");
  L.push("");
  for (const x of c.progress || []) L.push("- [" + (x.done ? "x" : " ") + "] " + x.text);
  if (!(c.progress || []).length) L.push("（尚未登记，先跑 coord save ... --progress \"a;b;c\"）");
  L.push("");
  L.push("## 下一步：接手的人从这里开始");
  L.push("");
  L.push(c.next || "（未填写）");
  L.push("");
  L.push("## 已动过的文件");
  L.push("");
  for (const f of c.files || []) L.push("- " + f);
  if (!(c.files || []).length) L.push("（未登记）");
  L.push("");
  L.push("## 决策 / 坑");
  L.push("");
  for (const n of c.notes || []) L.push("- " + n);
  if (!(c.notes || []).length) L.push("（无）");
  L.push("");
  L.push("## 历史");
  L.push("");
  for (const hh of t.history || []) L.push("- " + hh.at + " | " + hh.by + " | " + hh.what);
  L.push("");
  fs.writeFileSync(ckptMd(t.id), L.join("\n"), "utf8");
  fs.writeFileSync(ckptJson(t.id), JSON.stringify(readFiles(t.id) || snapshotScopes(t.scope), null, 2), "utf8");
}

function touchLease(t) {
  t.lease = t.lease || {};
  t.lease.heartbeat = now();
  if (!t.lease.at) t.lease.at = now();
}

function takeBrief(t) {
  const out = [];
  out.push("### " + t.id + " · " + t.title);
  out.push("- 原负责人：" + (t.owner || "-") + " · 状态：" + t.status + (t.lease && t.lease.reason ? " · 原因：" + t.lease.reason : ""));
  out.push("- 验收：" + (t.accept || "-"));
  out.push("- 写作用域：" + ((t.scope || []).join(", ") || "-"));
  const cp = ckptMd(t.id);
  if (fs.existsSync(cp)) {
    out.push("- 断点文件：docs/handoff/checkpoints/" + t.id + ".md");
    const body = fs.readFileSync(cp, "utf8");
    const nextIdx = body.indexOf("## 下一步");
    if (nextIdx >= 0) out.push("  " + body.slice(nextIdx).split("\n").slice(0, 8).join("\n  "));
  } else out.push("- 断点文件：无（原负责人没来得及写，按验收标准从头做，但先看下面的文件改动）");
  const ch = filesChanged(t.id, t.scope);
  if (ch.note) out.push("- 文件改动：" + ch.note);
  else {
    out.push("- 认领后文件变动：新增 " + ch.added.length + " / 修改 " + ch.modified.length + " / 删除 " + ch.removed.length);
    for (const f of ch.modified.slice(0, 12)) out.push("    ~ " + f);
    for (const f of ch.added.slice(0, 12)) out.push("    + " + f);
    for (const f of ch.removed.slice(0, 6)) out.push("    - " + f);
  }
  const lv = readLastVerify();
  out.push("- 最近 verify：" + (lv ? (lv.ok ? "GREEN" : "RED (" + lv.failed + ")") + " @ " + lv.at : "从未跑过"));
  return out.join("\n");
}

/* ---------- 命令 ---------- */
function resume(agent) {
  const s = readState();
  const out = [];
  out.push("## 你是谁：" + agent + "（复刻工程协作总线）");
  out.push("");
  out.push("**阶段**：" + s.phase + " —— " + (s.phaseGoal || ""));
  out.push("");
  const mine = s.tasks.filter((t) => t.owner === agent && t.status !== "done");
  out.push("### 分给你的任务（" + mine.length + "）");
  if (!mine.length) out.push("- 无");
  for (const t of mine) out.push("- " + t.id + " " + t.title + " [" + t.status + "] 断点：docs/handoff/checkpoints/" + t.id + ".md");
  out.push("");
  const takeoverable = s.tasks.filter((t) => (t.status === "blocked" || t.status === "stalled") && t.owner !== agent);
  out.push("### 可以接手的任务（别人卡住了，你有余力就接）");
  if (!takeoverable.length) out.push("- 无");
  for (const t of takeoverable) out.push("- " + t.id + " " + t.title + " [原 " + t.owner + " / " + (t.lease && t.lease.reason) + "]  → coord takeover " + t.id + " --from " + t.owner + " --agent " + agent);
  out.push("");
  const free = s.tasks.filter((t) => !t.owner && t.status === "todo" && !(t.blockedBy || []).length);
  out.push("### 可认领任务（" + free.length + "）");
  for (const t of free) out.push("- " + t.id + " " + t.title + " ｜作用域 " + ((t.scope || []).join(",") || "-"));
  out.push("");
  const msgs = inboxMessages(agent);
  out.push("### 未读留言（" + msgs.length + "）");
  for (const m of msgs) out.push("  " + m);
  out.push("");
  const jl = journalLines();
  const mark = readMark(agent);
  const fresh = jl.slice(mark.journal || 0);
  out.push("### 你上次离开之后发生的事（" + fresh.length + " 条）");
  for (const l of fresh.slice(-25)) out.push("  " + l);
  if (!fresh.length) out.push("  （无新增）");
  out.push("");
  out.push("### 环境");
  for (const e of s.env || []) out.push("- " + e);
  out.push("");
  out.push("### 开工必读");
  for (const r of s.readFirst || []) out.push("- " + r);
  out.push("");
  out.push("### 铁律");
  for (const r of s.rules || []) out.push("- " + r);
  out.push("");
  out.push("### 你随时可能被额度/限流/崩溃打断 —— 每做一小步就 save 一次");
  out.push("   node scripts/coord.mjs save " + "<ID>" + " --agent " + agent + " --note \"这步做了什么\" --next \"下一步具体做什么\"");
  out.push("### 收工");
  out.push("   1) scripts/verify.ps1 绿灯  2) coord.mjs done <ID> --agent " + agent + " --note \"...\"  3) 有交接就 msg");
  console.log(out.join("\n"));
  writeMark(agent, { journal: jl.length, at: now() });
  syncBoard(s);
}

function journalLines() {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs.readFileSync(JOURNAL, "utf8").split("\n").filter((l) => l.startsWith("- "));
}
function readMark(agent) { try { return JSON.parse(fs.readFileSync(path.join(MARKS, agent + ".json"), "utf8")); } catch { return { journal: 0 }; } }
function writeMark(agent, m) { fs.mkdirSync(MARKS, { recursive: true }); fs.writeFileSync(path.join(MARKS, agent + ".json"), JSON.stringify(m, null, 2)); }

function inboxPath(agent) { return path.join(INBOX, agent + ".md"); }
function inboxMessages(agent) {
  const f = inboxPath(agent);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("- [ ] "));
}
function pushMsg(to, from, text) {
  fs.mkdirSync(INBOX, { recursive: true });
  const f = inboxPath(to);
  const head = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "# " + to + " 收件箱\n";
  fs.writeFileSync(f, head + "\n- [ ] " + now() + " | from " + from + " | " + text + "\n", "utf8");
}

if (cmd === "resume") resume(flag("agent", "dsh-lead"));
else if (cmd === "status") {
  const s = readState();
  console.log("phase: " + s.phase + " | done " + s.tasks.filter((t) => t.status === "done").length + "/" + s.tasks.length);
  for (const t of s.tasks) console.log("  " + t.id + " " + (t.status + (t.lease && t.lease.reason ? "(" + t.lease.reason + ")" : "")).padEnd(20) + " " + (t.owner || "-").padEnd(10) + " " + t.title);
} else if (cmd === "claim") {
  const id = pos[0], agent = flag("agent", "dsh-lead");
  const s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) { console.error("没有这个任务：" + id); process.exit(2); }
  if (t.owner && t.owner !== agent && t.status !== "blocked" && t.status !== "stalled") { console.error("已被 " + t.owner + " 认领（" + t.status + "）。要接手请用 takeover。"); process.exit(3); }
  t.owner = agent; t.status = "doing";
  t.lease = { at: now(), heartbeat: now(), reason: null };
  t.history = t.history || []; t.history.push({ at: now(), by: agent, what: "claim" });
  writeState(s); syncBoard(s);
  journal(jline(agent, "CLAIM", id + " " + t.title));
  writeCheckpoint(t, s);
  console.log("OK claimed " + id + " — 断点文件 docs/handoff/checkpoints/" + id + ".md");
} else if (cmd === "save") {
  const id = pos[0], agent = flag("agent", "dsh-lead");
  const note = flag("note", ""), next = flag("next", ""), progress = flag("progress", "");
  const files = flagAll("file");
  const s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) process.exit(2);
  if (t.owner && t.owner !== agent) { console.error("这个任务现在归 " + t.owner); process.exit(3); }
  t.checkpoint = t.checkpoint || { progress: [], notes: [], files: [] };
  if (progress) t.checkpoint.progress = progress.split(";").map((x) => { const d = x.startsWith("+"); return { text: d ? x.slice(1) : x, done: d }; });
  if (note) t.checkpoint.notes.push(now().slice(11, 16) + " " + note);
  if (next) t.checkpoint.next = next;
  if (files.length) t.checkpoint.files = files;
  touchLease(t);
  t.history = t.history || []; t.history.push({ at: now(), by: agent, what: "save: " + (note || "checkpoint") });
  writeState(s); syncBoard(s);
  journal(jline(agent, "SAVE", id + " " + (note || "(checkpoint)")));
  writeCheckpoint(t, s);
  console.log("saved " + id);
} else if (cmd === "heartbeat") {
  const id = pos[0], agent = flag("agent", "dsh-lead");
  const s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) process.exit(2);
  touchLease(t); writeState(s);
  console.log("beat " + id);
} else if (cmd === "block") {
  const id = pos[0], agent = flag("agent", "dsh-lead");
  const reason = flag("reason", "other"), note = flag("note", "");
  const s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) process.exit(2);
  t.status = "blocked";
  t.lease = t.lease || {}; t.lease.reason = reason; t.lease.blockedAt = now(); t.lease.heartbeat = now();
  if (note) { t.checkpoint = t.checkpoint || { progress: [], notes: [], files: [] }; t.checkpoint.notes.push("BLOCKED: " + note); }
  t.history = t.history || []; t.history.push({ at: now(), by: agent, what: "blocked: " + reason + " " + note });
  writeState(s); syncBoard(s);
  journal(jline(agent, "BLOCK", id + " reason=" + reason + " " + note));
  writeCheckpoint(t, s);
  console.log("blocked " + id + " (" + reason + ") — 其他 Agent 可以 takeover");
} else if (cmd === "takeover") {
  const id = pos[0], to = flag("agent", "dsh-lead"), from = flag("from", null);
  const s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) process.exit(2);
  console.log("## 接手简报 " + id);
  console.log(takeBrief(t));
  console.log("");
  if (t.status === "done") { console.log("该任务已完成，无需接手。"); process.exit(0); }
  t.owner = to; t.status = "doing";
  t.lease = { at: t.lease ? t.lease.at : now(), heartbeat: now(), reason: null };
  t.history = t.history || []; t.history.push({ at: now(), by: to, what: "takeover from " + (from || "?") });
  writeState(s); syncBoard(s);
  journal(jline(to, "TAKEOVER", id + " from " + (from || "?") + " (" + t.title + ")"));
  writeCheckpoint(t, s);
  console.log("→ 已转交给你（" + to + "）。开工前先跑 scripts/verify.ps1 看当前红绿，再按上面的「下一步」继续。");
} else if (cmd === "check") {
  const s = readState();
  const staleMin = Number(flag("stale-min", "25"));
  let changed = 0;
  const rows = [];
  for (const t of s.tasks) {
    if (t.status !== "doing" && t.status !== "todo") continue;
    if (t.status === "doing" && t.lease && t.lease.heartbeat) {
      const mins = (Date.now() - Date.parse(t.lease.heartbeat)) / 60000;
      if (mins > staleMin) {
        t.status = "stalled"; t.lease.reason = "no-heartbeat";
        t.history = t.history || []; t.history.push({ at: now(), by: "coord-check", what: "stalled: " + Math.round(mins) + "min 无心跳" });
        journal(jline("coord-check", "STALLED", t.id + " " + Math.round(mins) + "min 无心跳（原 " + t.owner + "）"));
        writeCheckpoint(t, s); changed++; rows.push(t.id + " → stalled");
      }
    }
  }
  if (changed) writeState(s);
  syncBoard(s);
  console.log("inspect done. newly stalled: " + (rows.join(", ") || "none"));
  for (const t of s.tasks.filter((x) => x.status === "blocked" || x.status === "stalled")) {
    console.log("  可接手: " + t.id + " (" + (t.lease && t.lease.reason) + ") 原 " + t.owner);
  }
} else if (cmd === "done") {
  const id = pos[0], agent = flag("agent", "dsh-lead"), note = flag("note", "完成");
  const s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) process.exit(2);
  const lv = readLastVerify();
  if (lv && lv.ok === false) console.log("⚠ 最近一次 verify 是 RED，理论上不该 done（继续记录）");
  t.status = "done"; t.owner = t.owner || agent; t.finishedAt = now(); t.result = note;
  t.lease = t.lease || {}; t.lease.reason = null;
  t.history = t.history || []; t.history.push({ at: now(), by: agent, what: "done: " + note });
  writeState(s); syncBoard(s);
  journal(jline(agent, "DONE", id + " " + t.title + " —— " + note));
  writeCheckpoint(t, s);
  console.log("OK done " + id);
} else if (cmd === "release") {
  const id = pos[0], s = readState(), t = s.tasks.find((x) => x.id === id);
  if (!t) process.exit(2);
  t.status = "todo"; t.owner = null; t.lease = null;
  writeState(s); syncBoard(s); console.log("released " + id);
} else if (cmd === "add") {
  const title = pos.join(" "), agent = flag("agent", "dsh-lead"), s = readState();
  const t = { id: "T-" + String(s.tasks.length + 1).padStart(2, "0"), title, status: "todo", owner: null, scope: flagAll("scope"), accept: flag("accept", ""), blockedBy: flagAll("blocked-by"), createdAt: now(), history: [] };
  s.tasks.push(t); writeState(s); syncBoard(s);
  journal(jline(agent, "ADD", t.id + " " + title));
  console.log("added " + t.id);
} else if (cmd === "note") {
  const agent = flag("agent", "dsh-lead"), text = pos.join(" ");
  journal(jline(agent, "NOTE", text)); console.log("noted");
} else if (cmd === "msg") {
  const to = pos[0];
  if (!agents.includes(to)) { console.error("收件人必须是：" + agents.join(", ")); process.exit(2); }
  const from = flag("from", "dsh-lead"), text = pos.slice(1).join(" ");
  pushMsg(to, from, text); journal(jline(from, "MSG->" + to, text)); console.log("sent to " + to);
} else if (cmd === "read") {
  const agent = pos[0] || flag("agent", "dsh-lead");
  const f = inboxPath(agent);
  if (fs.existsSync(f)) {} else { console.log("(空)"); process.exit(0); }
  const t = fs.readFileSync(f, "utf8"); const n = (t.match(/^- \[ \] /gm) || []).length;
  fs.writeFileSync(f, t.replace(/^- \[ \] /gm, "- [x] "), "utf8");
  console.log("marked " + n + " read");
} else if (cmd === "inbox") {
  const agent = pos[0] || flag("agent", "dsh-lead");
  console.log(inboxMessages(agent).join("\n") || "(空)");
} else if (cmd === "sync") { const s = readState(); syncBoard(s); console.log("board synced"); }
else {
  console.log("commands: resume status claim save heartbeat block takeover check done release add note msg read inbox sync");
  console.log("故障接管示例：");
  console.log("  codex 额度用完 → coord block T-07 --agent codex --reason quota --note \"...\"");
  console.log("  我接手       → coord takeover T-07 --from codex --agent dsh-lead");
}
