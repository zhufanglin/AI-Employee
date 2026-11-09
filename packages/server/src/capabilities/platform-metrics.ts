/**
 * P30：平台作品数据快照（纯文本）结构化。
 *
 * 输入是桌面端 platform.ts 里 stats() 抓回来的 document.body.innerText —— 抖音/小红书/视频号
 * 三个数据页都是动态组件，DOM 结构和字段名经常变，所以这里刻意不依赖任何选择器：
 * 只按「行」做宽容解析，识别「标签 + 数字」对，以及「标题 + 一组数字」的作品行。
 *
 * 三条原则：
 * 1) 不猜：百分比按字面数值记录（45.2% -> 45.2），不换算小数、不猜基数；
 *    页面写 -- / 暂无 就返回 value:null，绝不拿 0 冒充。
 * 2) 不 throw：平台非法、文本为空、脏文本，一律回 ok:false + 中文 notes，由上层决定怎么展示。
 * 3) 可解释：每条指标/作品都带 raw（页面上命中的原始片段），对不上时能人工核对。
 */
import type { CapabilityDescriptor, CapabilityHandler } from "./capability.types";

export interface PlatformMetricItem {
  /** 中文指标名（已归一，例如「播放量」）；未知标签保留页面原文 */
  label: string;
  /** 数值：万=1e4、亿=1e8、w/W=1e4、k/K=1e3；千分位逗号会去掉；--/暂无 为 null */
  value: number | null;
  /** 页面上命中的原始片段，例如 "12.3万"、"--" */
  raw: string;
}

export interface PlatformWork {
  title: string;
  playCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  /** 页面上原样的日期/相对时间，例如 "2026-01-02"、"3天前"；没有就是 null */
  publishedAt: string | null;
  /** 整行原文，便于人工核对 */
  raw: string;
}

export interface PlatformMetrics {
  /** 归一后的平台 id；平台非法时保留调用方传入的原文 */
  platform: string;
  ok: boolean;
  metrics: PlatformMetricItem[];
  works: PlatformWork[];
  notes: string[];
}

/** 三个平台的展示名（只用于中文 notes）。 */
const PLATFORM_NAMES: Record<string, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  shipinhao: "视频号",
};

/** 平台别名：桌面端传 id，人工调用可能传中文名。 */
const PLATFORM_ALIASES: Record<string, string> = {
  douyin: "douyin",
  dy: "douyin",
  "抖音": "douyin",
  xiaohongshu: "xiaohongshu",
  xhs: "xiaohongshu",
  xiaohongshucom: "xiaohongshu",
  "小红书": "xiaohongshu",
  shipinhao: "shipinhao",
  sph: "shipinhao",
  wechatvideo: "shipinhao",
  "视频号": "shipinhao",
  "微信视频号": "shipinhao",
};

/** 数字上限：超过 1e12 一律截到 1e12，避免脏文本里的超长数字把展示撑爆。 */
const MAX_VALUE = 1e12;
/** 作品标题上限（页面一般更短，这里只防脏文本）。 */
const MAX_TITLE_CHARS = 120;
/** 单次最多解析 5000 行，防止把整页 DOM 文本拖进来。 */
const MAX_LINES = 5000;

interface LabelDef {
  /** 归一键：同一 key 的别名只保留第一次出现的值 */
  key: string;
  /** 归一后的中文指标名 */
  label: string;
  /** 其它写法（中文别名 / 英文单词），全部小写、不含空格 */
  aliases: string[];
}

/**
 * 指标词典：中文别名 + 英文单字（innerText 里英文标签通常单独成词）。
 * 顺序不重要，使用时按别名长度倒序匹配，保证「播放量」优先于「播放」。
 */
const LABEL_DEFS: LabelDef[] = [
  { key: "play", label: "播放量", aliases: ["播放次数", "视频播放量", "总播放量", "作品播放", "观看量", "观看数", "阅读量", "阅读数", "播放数", "播放", "观看", "阅读", "playcount", "plays", "views", "view", "play"] },
  { key: "like", label: "点赞", aliases: ["点赞量", "点赞数", "获赞数", "获赞", "点赞", "likes", "like"] },
  { key: "comment", label: "评论", aliases: ["评论量", "评论数", "comments", "comment"] },
  { key: "share", label: "分享", aliases: ["分享量", "分享数", "转发量", "转发数", "reposts", "repost", "shares", "share"] },
  { key: "collect", label: "收藏", aliases: ["收藏量", "收藏数", "favorites", "collects", "collect", "saves", "save"] },
  { key: "fans", label: "粉丝", aliases: ["粉丝总数", "粉丝数", "粉丝量", "关注者", "followers", "follower", "fans", "fan"] },
  { key: "following", label: "关注", aliases: ["关注数", "关注量", "following"] },
  { key: "works", label: "作品数", aliases: ["作品数", "作品量", "笔记数", "视频数", "作品", "notes", "posts", "works"] },
  { key: "impression", label: "曝光量", aliases: ["曝光量", "曝光数", "展现量", "impressions", "impression", "exposure"] },
  { key: "completion", label: "完播率", aliases: ["完播率", "完播", "completionrate"] },
  { key: "interaction", label: "互动率", aliases: ["互动率", "engagementrate"] },
  { key: "click", label: "点击率", aliases: ["点击率", "主页访问率", "clickrate", "ctr"] },
  { key: "homepage", label: "主页访问", aliases: ["主页访问量", "主页访问", "profilevisits"] },
  { key: "revenue", label: "收益", aliases: ["预估收益", "昨日收益", "累计收益", "总收益", "收益", "收入", "earnings", "revenue", "income"] },
  { key: "fansGrowth", label: "新增粉丝", aliases: ["新增粉丝", "涨粉数", "涨粉", "newfollowers"] },
];

/** 别名 -> 定义。键为小写且去掉空格后的形式。 */
const ALIAS_TO_DEF = new Map<string, LabelDef>();
/** 全部别名，按长度倒序；用于「后缀/前缀」匹配。 */
const ALIASES_DESC: string[] = [];

function normalizeAlias(raw: string): string {
  return String(raw || "").toLowerCase().replace(/\s+/g, "");
}

for (const def of LABEL_DEFS) {
  const names = [def.label].concat(def.aliases);
  for (const name of names) {
    const key = normalizeAlias(name);
    if (!key) continue;
    if (!ALIAS_TO_DEF.has(key)) {
      ALIAS_TO_DEF.set(key, def);
      ALIASES_DESC.push(key);
    }
  }
}
ALIASES_DESC.sort((a, b) => b.length - a.length || a.localeCompare(b));

/** 空值标记：这些文本一律解析成 null，不用 0 顶替。 */
const EMPTY_MARKERS = ["-", "--", "---", "—", "——", "暂无", "暂无数据", "无", "无数据", "n/a", "na", "null", "undefined"];

/**
 * 把页面上的数字文本解析成 number。
 * 支持：1.2万 / 3.4w / 12.3W / 2亿 / 1,234 / 1.5k / 45.2% / 10万+ / 全角数字；
 * --/—/暂无/暂无数据/无数据/空串 -> null；超过 1e12 截到 1e12。
 */
export function parseCnNumber(raw: string): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .replace(/[，,\s\u00a0]/g, "")
    .replace(/^[¥￥$]/, "")
    .replace(/^\+/, "");
  if (!s) return null;
  const lower = s.toLowerCase();
  if (EMPTY_MARKERS.indexOf(lower) >= 0) return null;
  if (/^[-—]+$/.test(lower)) return null;
  if (/[%％]$/.test(s)) s = s.slice(0, -1);
  if (/[+＋]$/.test(s)) s = s.slice(0, -1);
  if (!s) return null;
  const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(万|亿|[wWkK])?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  let mult = 1;
  if (unit === "万" || unit === "w" || unit === "W") mult = 1e4;
  else if (unit === "亿") mult = 1e8;
  else if (unit === "k" || unit === "K") mult = 1e3;
  let value = n * mult;
  if (!Number.isFinite(value)) return null;
  value = Number(value.toFixed(6));
  if (value > MAX_VALUE) value = MAX_VALUE;
  if (value < -MAX_VALUE) value = -MAX_VALUE;
  return value;
}

/** 归一平台名；不认识返回 null。 */
function normalizePlatform(input: string): string | null {
  const t = String(input || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  if (PLATFORM_NAMES[t]) return t;
  const alias = PLATFORM_ALIASES[t];
  return alias || null;
}

/** 把一段文本归一成词典键（小写、去空格、去首尾冒号）。 */
function resolveLabel(raw: string): LabelDef | null {
  const t = String(raw || "").trim().replace(/^[\s:：]+/, "").replace(/[\s:：]+$/, "");
  const key = normalizeAlias(t).replace(/[%％]/g, "");
  if (!key) return null;
  return ALIAS_TO_DEF.get(key) || null;
}

/** 通用「像标签」判断：给竖向排版（标签一行、数字一行）兜底用。 */
const LABEL_SUFFIXES = ["量", "数", "率", "额", "值", "占比", "人数", "次数", "时长", "粉丝", "关注", "作品", "笔记", "视频", "播放", "点赞", "评论", "收藏", "分享", "收益", "收入"];

function isLabelLike(text: string): boolean {
  const t = String(text || "").replace(/[\s:：]+/g, "");
  if (t.length < 2 || t.length > 8) return false;
  if (/\d/.test(t)) return false;
  if (/[，。！？、,.!?；;（）()]/.test(t)) return false;
  return LABEL_SUFFIXES.some((suffix) => t.endsWith(suffix));
}

/** 页面分区标题：这些词开头的残留文本不算作品标题。 */
const SECTION_WORDS = ["概览", "统计", "看板", "总览", "汇总", "概况", "详情", "趋势", "分析", "合计", "总计", "全部", "更多", "账号", "主页", "发布时间"];

function isSectionLike(text: string): boolean {
  return SECTION_WORDS.some((word) => text.indexOf(word) >= 0);
}

/** 日期/相对时间；命中后从分析文本里挖空，避免日期里的数字被当成指标。 */
function dateRegExp(): RegExp {
  return /(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)|(\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2})?)|(\d{1,2}\s*(?:天|小时|分钟)前)|(昨天|前天|今天|刚刚)/g;
}

/** 时间范围 / 分区标题噪音：从分析文本里挖空，避免「近7天」里的 7 被当成作品数字。 */
function noiseRegExp(): RegExp {
  return /(数据概览|数据看板|数据总览|数据统计|数据详情|创作数据|账号数据|内容数据|核心数据|近\s*\d+\s*(?:天|日|周|个月)|最近\s*\d+\s*(?:天|日)|过去\s*\d+\s*(?:天|日)|昨天|昨日|今天|今日|本周|上周|本月|上月|全部时间)/g;
}

interface NumberToken {
  raw: string;
  value: number | null;
  start: number;
  end: number;
  percent: boolean;
}

/** 扫一行里的数字片段（含单位/百分号/千分位/¥）。 */
function scanNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const re = /[¥￥$]?\d[\d,]*(?:\.\d+)?\s*(?:万|亿|[wWkK])?\s*[%％]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let raw = m[0];
    let end = m.index + raw.length;
    const trimmed = raw.replace(/\s+$/, "");
    end -= raw.length - trimmed.length;
    raw = trimmed;
    if (!raw) continue;
    out.push({ raw, value: parseCnNumber(raw), start: m.index, end, percent: /[%％]/.test(raw) });
  }
  return out;
}

interface LabelHit {
  alias: string;
  start: number;
  end: number;
  def: LabelDef;
}

/** 找数字前面的标签（支持「视频播放量 12.3万」这种复合词）。 */
function findLabelBefore(text: string, index: number): LabelHit | null {
  const from = Math.max(0, index - 24);
  const window = text.slice(from, index);
  const trimmed = window.replace(/[\s:：;；·•|、,，]+$/, "");
  if (!trimmed) return null;
  const endPos = from + trimmed.length;
  const parts = trimmed.split(/[\s:：;；·•|、,，]+/);
  const lastPart = parts[parts.length - 1] || "";
  const whole = resolveLabel(lastPart);
  if (whole) return { alias: lastPart, start: endPos - lastPart.length, end: endPos, def: whole };
  const lower = trimmed.toLowerCase();
  for (const alias of ALIASES_DESC) {
    if (lower.endsWith(alias)) return { alias, start: endPos - alias.length, end: endPos, def: ALIAS_TO_DEF.get(alias) as LabelDef };
  }
  return null;
}

/** 找数字后面的标签（支持「12.3万播放」「12.3万次播放」）。 */
function findLabelAfter(text: string, index: number): LabelHit | null {
  const to = Math.min(text.length, index + 24);
  const window = text.slice(index, to);
  const trimmed = window.replace(/^[\s:：;；·•|、,，]*(?:个|次|条|人|位|篇|张)?[\s:：;；·•|、,，]*/, "");
  if (!trimmed) return null;
  const startPos = to - trimmed.length;
  const m = /^[^\s:：;；·•|、,，]+/.exec(trimmed);
  if (!m) return null;
  const first = m[0];
  const def = resolveLabel(first);
  if (!def) return null;
  return { alias: first, start: startPos, end: startPos + first.length, def };
}

interface PairHit {
  def: LabelDef;
  alias: string;
  value: number | null;
  raw: string;
  numStart: number;
  numEnd: number;
  labelStart: number;
  labelEnd: number;
}

interface LineAnalysis {
  raw: string;
  pairs: PairHit[];
  bare: NumberToken[];
  title: string;
  date: string | null;
}

/** 去掉首尾分隔符、压缩空白，得到「疑似标题」的残留文本。 */
function cleanRemainder(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:：;；·•|、,，\-–—>»_]+/, "")
    .replace(/[\s:：;；·•|、,，\-–—_]+$/, "")
    .trim();
}

/**
 * 一行文本 → { 标签数字对、无标签数字、残留标题、日期 }。
 * 先把日期、时间范围、括号单位挖空（保持字符下标，便于计算标签相对位置）。
 */
function analyzeLine(rawLine: string): LineAnalysis {
  let text = rawLine.replace(/\u00a0/g, " ").replace(/[ \t]{2,}/g, " ");
  let date: string | null = null;
  text = text.replace(dateRegExp(), (matched) => {
    if (!date) date = matched.trim();
    return " ".repeat(matched.length);
  });
  text = text.replace(noiseRegExp(), (matched) => " ".repeat(matched.length));
  // 括号里的单位（如「收益(元)」）不参与标签匹配，避免把整个标签判成裸文本
  text = text.replace(/[（(][^（）()]{0,10}[）)]/g, (matched) => " ".repeat(matched.length));

  const tokens = scanNumbers(text);
  const pairs: PairHit[] = [];
  const bare: NumberToken[] = [];
  const consumed: Array<[number, number]> = [];

  for (const token of tokens) {
    const before = findLabelBefore(text, token.start);
    const after = before ? null : findLabelAfter(text, token.end);
    const hit = before || after;
    if (!hit) {
      bare.push(token);
      continue;
    }
    pairs.push({
      def: hit.def,
      alias: hit.alias,
      value: token.value,
      raw: token.raw,
      numStart: token.start,
      numEnd: token.end,
      labelStart: hit.start,
      labelEnd: hit.end,
    });
    consumed.push([hit.start, hit.end]);
  }
  // 未命中标签的裸数字也要从残留文本里挖掉，否则标题会带上「8.8万 2,345 88」
  for (const token of tokens) consumed.push([token.start, token.end]);

  const chars = text.split("");
  for (const span of consumed) {
    for (let i = span[0]; i < span[1]; i += 1) chars[i] = " ";
  }
  return { raw: rawLine, pairs, bare, title: cleanRemainder(chars.join("")), date };
}

/** 「播放量 --」这种横向空值行：没有数字也要能落到指标里。 */
function parseEmptyPairLine(line: string): { label: string; def: LabelDef | null; raw: string } | null {
  // 注意：这里不能用 cleanRemainder —— 它会把末尾的 -- / — 当分隔符删掉，空值标记就没了
  const cleaned = String(line || "").replace(/[（(][^（）()]{0,10}[）)]/g, " ").replace(/^[\s:：;；·•|、,，]+/, "").trim();
  const m = /^(.{1,20}?)\s*[:：]?\s*(--+|—+|暂无数据|暂无|无数据)\s*$/.exec(cleaned);
  if (!m) return null;
  const labelText = String(m[1]).replace(/[\s:：]+$/, "").trim();
  if (!labelText) return null;
  const def = resolveLabel(labelText);
  if (def) return { label: def.label, def, raw: m[2] };
  if (isLabelLike(labelText)) return { label: labelText, def: null, raw: m[2] };
  // 页面标签前常混图标/符号（如「@#￥… 点赞 --」）：取最后一段纯文字兜底
  const words = labelText.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const last = words.length ? words[words.length - 1] : "";
  const lastDef = resolveLabel(last);
  if (lastDef) return { label: lastDef.label, def: lastDef, raw: m[2] };
  if (isLabelLike(last)) return { label: last, def: null, raw: m[2] };
  return null;
}

/** 竖向排版的「数字行」：整行只有一个值（或空值标记）。 */
function parsePureValueLine(line: string): { value: number | null; raw: string } | null {
  const t = String(line || "").replace(/\u00a0/g, " ").trim();
  if (!t) return null;
  if (/^(--+|—+|暂无数据|暂无|无数据|N\/A)$/i.test(t)) return { value: null, raw: t };
  if (!/^[¥￥$]?\s*-?\d[\d,]*(?:\.\d+)?\s*(?:万|亿|[wWkK])?\s*[%％]?$/.test(t)) return null;
  return { value: parseCnNumber(t), raw: t };
}

/** 竖向排版的「标签行」：整行没有数字、像指标名。 */
function parseVerticalLabel(line: string): { label: string; def: LabelDef | null; raw: string } | null {
  // 带空值标记的行交给 parseEmptyPairLine，不能当成「标签行 + 下一行数字」的竖向排版
  if (/(--+|—+|暂无数据|暂无|无数据)\s*$/.test(String(line || "").trim())) return null;
  const t = cleanRemainder(line);
  if (!t || t.length > 12) return null;
  if (/\d/.test(t)) return null;
  if (/[，。！？、,.!?；;（）()]/.test(t)) return null;
  const def = resolveLabel(t);
  if (def) return { label: def.label, def, raw: t };
  if (isLabelLike(t)) return { label: t, def: null, raw: t };
  return null;
}

/**
 * 把平台数据页的可见文本解析成结构化指标。
 * 永不 throw：参数非法/文本为空只回 ok:false + 中文 notes。
 */
export function parsePlatformMetrics(platform: string, text: string): PlatformMetrics {
  const rawPlatform = platform === null || platform === undefined ? "" : String(platform).trim();
  const platformKey = normalizePlatform(rawPlatform);
  const rawText = text === null || text === undefined ? "" : String(text);
  const notes: string[] = [];

  if (!platformKey) {
    notes.push("不支持的平台「" + rawPlatform + "」：仅支持 douyin（抖音）/ xiaohongshu（小红书）/ shipinhao（视频号）");
  }
  if (!rawText.trim()) {
    notes.push("文本为空：请把平台数据页的可见文本（document.body.innerText）传进来");
  }
  if (!platformKey || !rawText.trim()) {
    return { platform: platformKey || rawPlatform, ok: false, metrics: [], works: [], notes };
  }

  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  let lineTruncated = false;
  if (lines.length > MAX_LINES) {
    lineTruncated = true;
    lines.length = MAX_LINES;
  }

  const metrics: PlatformMetricItem[] = [];
  const works: PlatformWork[] = [];
  const metricSeen = new Set<string>();
  const workSeen = new Set<string>();
  const consumedLine: boolean[] = new Array(lines.length).fill(false);
  let positionalUsed = false;

  const addMetric = (label: string, key: string | null, value: number | null, raw: string): void => {
    const dedupeKey = key ? "k:" + key : "l:" + label.replace(/\s+/g, "").toLowerCase();
    if (metricSeen.has(dedupeKey)) return;
    metricSeen.add(dedupeKey);
    metrics.push({ label, value, raw });
  };

  const addWork = (analysis: LineAnalysis): void => {
    const work: PlatformWork = {
      title: analysis.title.slice(0, MAX_TITLE_CHARS),
      playCount: null,
      likeCount: null,
      commentCount: null,
      publishedAt: analysis.date,
      raw: analysis.raw.trim(),
    };
    for (const pair of analysis.pairs) {
      if (pair.def.key === "play") work.playCount = pair.value;
      else if (pair.def.key === "like") work.likeCount = pair.value;
      else if (pair.def.key === "comment") work.commentCount = pair.value;
    }
    // 没有标签的数字按「播放、点赞、评论」顺序补位（页面常见顺序，见文档「已知限制」）
    const slots: Array<"playCount" | "likeCount" | "commentCount"> = ["playCount", "likeCount", "commentCount"];
    let slot = 0;
    for (const token of analysis.bare) {
      if (token.percent) continue;
      while (slot < slots.length && work[slots[slot]] !== null) slot += 1;
      if (slot >= slots.length) break;
      work[slots[slot]] = token.value;
      slot += 1;
      positionalUsed = true;
    }
    if (work.playCount === null && work.likeCount === null && work.commentCount === null) return;
    const key = work.title + "|" + work.playCount + "|" + work.likeCount + "|" + work.commentCount;
    if (workSeen.has(key)) return;
    workSeen.add(key);
    works.push(work);
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (consumedLine[i]) continue;
    const line = lines[i];
    if (!line || !line.trim()) continue;

    // ① 竖向排版：本行是标签，下一非空行是纯数字
    const vertical = parseVerticalLabel(line);
    if (vertical) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length) {
        const pure = parsePureValueLine(lines[next]);
        if (pure) {
          addMetric(vertical.label, vertical.def ? vertical.def.key : null, pure.value, pure.raw);
          consumedLine[next] = true;
          continue;
        }
      }
    }

    // ② 横向空值：播放量 -- / 粉丝：暂无
    const emptyPair = parseEmptyPairLine(line);
    if (emptyPair) {
      addMetric(emptyPair.label, emptyPair.def ? emptyPair.def.key : null, null, emptyPair.raw);
      continue;
    }

    // ③ 常规行
    const analysis = analyzeLine(line);
    if (!analysis.pairs.length && !analysis.bare.length) continue;
    // 纯百分比行（较上周 +2.1% 之类）没有标签时不当作作品
    if (!analysis.pairs.length && analysis.bare.every((token) => token.percent)) continue;

    const title = analysis.title;
    const hasTitle = title.length >= 2 && /[\u4e00-\u9fa5A-Za-z]/.test(title);
    const titleIsLabel = !!resolveLabel(title) || isLabelLike(title);
    const isWork = hasTitle && !titleIsLabel && !isSectionLike(title) && (analysis.bare.length > 0 || analysis.pairs.length > 0);

    if (isWork) {
      addWork(analysis);
    } else {
      for (const pair of analysis.pairs) addMetric(pair.def.label, pair.def.key, pair.value, pair.raw);
    }
  }

  if (metrics.length === 0 && works.length === 0) {
    notes.push("未从文本中解析到任何指标或作品：页面可能还没加载完、未登录，或排版超出当前解析规则");
    if (/扫码登录|请先登录|登录后查看|立即登录|未登录/.test(rawText)) {
      notes.push("文本中出现登录提示，数据页大概率未登录，请先在桌面端扫码登录");
    }
    return { platform: platformKey, ok: false, metrics, works, notes };
  }
  if (metrics.some((item) => /[%％]/.test(item.raw))) {
    notes.push("百分比按页面字面数值记录（45.2 表示 45.2%），未换算成小数，也不猜基数");
  }
  if (positionalUsed) {
    notes.push("部分作品行没有字段标签，数字按「播放、点赞、评论」顺序填充，可能与真实字段错位");
  }
  if (lineTruncated) {
    notes.push("文本超过 " + MAX_LINES + " 行，仅解析前 " + MAX_LINES + " 行");
  }
  return { platform: platformKey, ok: true, metrics, works, notes };
}

/** 能力目录描述符：供服务端 /capabilities 列表展示。 */
export const descriptor: CapabilityDescriptor = {
  name: "platform_metrics_parse",
  title: "平台数据快照结构化",
  category: "platform",
  description:
    "把桌面端抓回的抖音/小红书/视频号「作品数据」页可见文本解析成结构化指标（播放/点赞/评论/粉丝等 label+value+raw）与作品条目（标题、播放、点赞、评论、发布时间）；纯函数，不发网络请求、不读数据库",
  params: {
    platform: "必填，平台：douyin（抖音）| xiaohongshu（小红书）| shipinhao（视频号），也接受中文名",
    text: "必填，桌面端 platform_stats 快照里的整页可见文本（innerText）；按行宽容解析，不依赖 DOM 结构",
  },
};

/** 能力 handler：参数非法也走 ok:false，不抛异常（解析工具，失败要让调用方看到原因）。 */
export const handler: CapabilityHandler = async (ctx) => {
  const params = (ctx && ctx.params) || {};
  const platform = params.platform === null || params.platform === undefined ? "" : String(params.platform);
  const text = params.text === null || params.text === undefined ? "" : String(params.text);
  return parsePlatformMetrics(platform, text);
};
