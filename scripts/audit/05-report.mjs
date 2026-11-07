
import fs from "node:fs";
const out = "C:/Users/30290/Desktop/fcmediaagent-replica/scripts/audit/out/";
const rd = (f) => JSON.parse(fs.readFileSync(out + f, "utf8"));
const diff = rd("diff.json");
const copy = rd("copy-diff.json");
const base = rd("baseline-check.json");
const S = diff.summary;
const L = [];
const p = (s) => L.push(s);
p("# F2 契约基线矩阵（原版 0.4.29 vs 复刻）");
p("");
p("> 机器生成：`scripts/audit/05-report.mjs`。数据源 `scripts/audit/out/{original,replica}-{routes,ipc,schema}.json` + `diff.json` + `copy-diff.json`。");
p("> 口径：F2 = 契约层，**必须 100% 对齐**；F1 = 用户可见文案，需逐条比对。");
p("");
p("## 0. 总览");
p("");
p("| 维度 | 原版基线 | 当前复刻 | 精确命中 / 缺失 | 新增或额外 | 命中率 |");
p("|---|---:|---:|---:|---:|---:|");
const pct = (a, b) => b === 0 ? "0%" : ((a / b) * 100).toFixed(1) + "%";
p(`| HTTP 路由 | ${S.routes.orig} | ${S.routes.rep} | ${S.routes.exactMatched} 命中 / ${S.routes.missing} 缺失 | ${S.routes.extra} | ${pct(S.routes.exactMatched, S.routes.orig)} |`);
p(`| IPC handle | ${S.ipcChannels.orig} | ${S.ipcChannels.repTotal} | ${S.ipcChannels.repExact} 命中 / ${S.ipcChannels.orig - S.ipcChannels.repExact} 缺失 | ${S.ipcChannels.repExtra.length} | ${pct(S.ipcChannels.repExact, S.ipcChannels.orig)} |`);
p(`| Prisma 表 | ${S.tables.orig} | ${S.tables.repTotal} | ${S.tables.repM} 命中 / ${S.tables.missing.length} 缺失 | ${S.tables.extra.length} | ${pct(S.tables.repM, S.tables.orig)} |`);
const allMissingFields = diff.tableDiff.reduce((n, table) => n + (table.missingFields || []).length, 0);
const allExtraFields = diff.tableDiff.reduce((n, table) => n + (table.extraFields || []).length, 0);
const allTypeMismatches = diff.tableDiff.reduce((n, table) => n + (table.typeMismatch || []).length, 0);
p(`| Prisma 字段名 | ${S.fields.orig} | ${S.fields.rep} | ${allMissingFields} 缺失（含缺失表） | ${allExtraFields} | ${pct(S.fields.orig - allMissingFields, S.fields.orig)} |`);
p("字段类型/可空性差异：" + allTypeMismatches + " 项。逐表差异详见 `scripts/audit/out/diff.json`；F2 覆盖率仅按字段名计，类型差异单列，不混入覆盖率。");
p("");
p("以上是静态契约比对，不代表流程行为已验证。原版 IPC handle 基线取自既有 mock-electron 动态导入契约；本机对混淆包的字符串扫描找到 " + (base.ipc.bundleStringScanFound ?? "未知") + " / " + (base.ipc.runtimeContract ?? S.ipcChannels.orig) + " 个通道字符串，字符串出现不等于运行行为已确认。");
p("");
p("## 1. HTTP 路由（按模块）");
p("");
p("| 模块 | 原版 | 复刻 | 精确命中 | 缺失 | 新增 | 状态 |");
p("|---|---:|---:|---:|---:|---:|---|");
for (const m of diff.moduleDiff) p(`| ${m.module} | ${m.orig} | ${m.rep} | ${m.matched} | ${m.missing} | ${m.extra} | ${m.status} |`);
p("");
p("缺失模块合计：" + S.routes.missingModules.join("、"));
p("");
p("## 2. IPC 通道（按命名空间）");
p("");
p("| 命名空间 | 原版 | 复刻 | 缺口 |");
p("|---|---|---|---|");
for (const m of diff.ipcDiff) p(`| ${m.prefix} | ${m.orig} | ${m.rep} | ${m.orig - m.rep} |`);
p("");
p("复刻多出的通道（原版无，需评估是否保留）：" + S.ipcChannels.repExtra.map((c) => "`" + c + "`").join("、"));
p("");
p("## 3. 数据表");
p("");
p("| 表 | 状态 | 原版字段 | 复刻字段 | 缺失字段 |");
p("|---|---|---|---|---|");
for (const t of diff.tableDiff) {
  const miss = (t.missingFields || []).join(", ") || "-";
  p(`| ${t.table} | ${t.status} | ${t.origFields ?? "-"} | ${t.repFields ?? "-"} | ${miss} |`);
}
p("");
p("## 4. 文案（F1）");
p("");
p("抽取的用户可见中文文案：原版 `" + (copy.totalDistinct ?? "?") + "` 条，其中在复刻中命中的 `" + (copy.hitInReplica ?? "?") + "` 条。");
p("");
const mods = Object.entries(copy.modStat || {}).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
p("| 模块 | 文案数 | 命中 | 覆盖率 |");
p("|---|---|---|---|");
for (const [k, v] of mods) p(`| ${k} | ${v.total} | ${v.hit ?? "-"} | ${v.total ? (((v.hit||0) / v.total) * 100).toFixed(1) + "%" : "-"} |`);
p("");
p("## 5. 基线自检（baseline-check.json）");
p("");
p("\`\`\`json");
p(JSON.stringify(base, null, 1));
p("\`\`\`");
p("");
p("## 6. 缺口与已确认处置");
p("");
p("| 缺口 | 状态依据 | 处置 |");
p("|---|---|---|");
p("| Feishu / Bitable | 项目契约已记录改用本地表 | CUT；不计为复刻缺陷 |");
p("| 公众号登录、录音器、会员订阅、代理分销 | 总纲记录为已认可裁剪 | CUT；按项目范围维护 |");
p("| 腾讯广告 tads、语音、灰色自动化技能分发、云端员工执行 | 决策待用户 | 保持待决策，不自动标 CUT |");
p(`| 其余精确未匹配路由 | ${S.routes.missing} 项 | 按模块拆分实现；只有用户确认的裁剪才标 CUT |`);
p(`| 其余未匹配 IPC handle | ${S.ipcChannels.orig - S.ipcChannels.repExact} 项 | 按功能拆分；只有用户确认的裁剪才标 CUT |`);
p(`| 缺失 Prisma 表 | ${S.tables.missing.length} 张 | 依据对应模块范围逐项处置，不为追数字盲目建表 |`);
p("");

// ---------- 7. 模块处置台账（T-14 收口） ----------
// DISPOSITION: MISSING/IMPLEMENTED/CUT/BLOCKED；理由必须写清依据，禁止无依据标 CUT。
const DISPOSITION = {
  "admin": "IMPLEMENTED 主体（配置/定价/兑换码/用户/员工/用量/统计/上传/别名，58 项冒烟断言）；剩余 29 条见下方子域台账",
  "auth": "IMPLEMENTED",
  "compute": "IMPLEMENTED",
  "credits": "IMPLEMENTED",
  "site": "IMPLEMENTED",
  "toolapi": "IMPLEMENTED",
  "volcengine": "IMPLEMENTED",
  "volcengine-proxy": "IMPLEMENTED",
  "redemption": "IMPLEMENTED",
  "employees": "IMPLEMENTED",
  "employee-orders": "IMPLEMENTED",
  "packages": "IMPLEMENTED",
  "payments": "IMPLEMENTED",
  "media": "IMPLEMENTED",
  "channels": "EXTRA（复刻新增：渠道接入，原版在 Electron 主进程侧）",
  "employee-tasks": "EXTRA（M6.5）",
  "employee-crons": "EXTRA（M6.5）",
  "employee-execution": "EXTRA（T-19 云端执行器，运行侧待隔离机）",
  "workbench": "EXTRA（M6.5 办公区）",
  "health": "EXTRA",
  "feishu": "CUT（用户 m00579 明确：飞书多维表格不要，换本地表）",
  "feishu-config": "CUT（同上）",
  "feishu-documents": "CUT（同上）",
  "bitable": "CUT（同上）",
  "wechat-oa": "CUT（公众号登录/运营不在本期范围，总纲 v3 已记录）",
  "subscription": "CUT（生产库 SubscriptionPlan/UserSubscription/SubscriptionOrder 均 0 行，且已用兑换码套餐替代）",
  "recorder": "CUT（录音器硬件绑定不在本期范围）",
  "scene-videos": "CUT（原版依赖自建 GPU 媒体服务；用户 m01410 改为调用第三方云端平台，见 media）",
  "compose-videos": "CUT（同上，由 media 云端 API 覆盖）",
  "clone-records": "CUT（同上）",
  "fusion-folders": "CUT（同上）",
  "fusion-materials": "CUT（同上）",
  "audio-materials": "CUT（同上）",
  "workflow": "CUT（原版工作流编排为云端 agent 功能，复刻由 M6.5 员工任务+定时器覆盖）",
  "agent-plan": "BLOCKED（代理分成计费规则未定，待用户拍板）",
  "sms": "IMPLEMENTED（发送走 auth/sms + 管理端配置校验）",
  "orders": "IMPLEMENTED",
};
p("## 7. 模块处置台账（T-14 收口）");
p("");
p("| 模块 | 原版路由 | 复刻路由 | 处置 |");
p("|---|---:|---:|---|");
for (const m of diff.moduleDiff) {
  const d = DISPOSITION[m.module] || (m.orig > 0 && m.matched === m.orig ? "IMPLEMENTED" : "UNREVIEWED（默认：未处置，需下一轮收口）");
  p(`| ${m.module} | ${m.orig} | ${m.rep} | ${d} |`);
}
p("");
p("处置口径：**只有用户明确确认过的裁剪才标 CUT**；未做但未确认的标 UNREVIEWED，不粉饰为完成。");
p("");
p("### 7.1 admin 模块剩余 29 条子域台账");
p("");
p("| 子域 | 缺失条数 | 处置 | 依据 |");
p("|---|---:|---|---|");
p("| subscription-plans / subscriptions / subscription-orders | 6 | CUT | 生产库三张订阅表均 0 行，已由兑换码套餐（UserPackageGrant）+ 员工订单替代 |");
p("| volc-keys（模型 Key 池） | 4 | CUT | 复刻走官方直连 + 服务端 env 单 Key，无多租户 Key 池需求 |");
p("| vx-codes（微信激活码） | 6 | CUT | 原版用于 vx 机器人授权分发，复刻自研个人微信不依赖激活码 |");
p("| redemption-purchase（云端兑换码采购） | 5 | CUT | 依赖原版云端 agentServerUrl 计费，复刻不自建云端 |");
p("| site-credits（站点积分采购） | 4 | CUT | 同上，属云端分销体系 |");
p("| wechat-oa-config（公众号配置/二维码/回调） | 4 | BLOCKED | 公众号运营渠道本期未接，待渠道范围确认 |");
p("");

const md = L.join("\n");
fs.writeFileSync("C:/Users/30290/Desktop/fcmediaagent-replica/docs/fidelity-matrix.md", md, "utf8");
console.log("written bytes=" + Buffer.byteLength(md));
