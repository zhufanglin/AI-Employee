/**
 * 时间线剪辑的纯函数层（不碰 IO，方便单测）
 *  - buildSegments: 用字幕 cue 或固定节奏切分时间轴
 *  - buildShotPlan: 给每段挑素材 + 定入点 + 定变速/补帧
 *  - buildAss: 生成 ASS 字幕（中文粗体 + 黑描边 + 关键词高亮）
 *  - buildFilterComplex: 生成 ffmpeg filter_complex（切镜 → 拼接 → 调色 → 画中画 → 字幕 → 淡入淡出）
 */

export interface TimelineCue {
  start: number;
  end: number;
  text?: string;
  /** 需要黄色高亮的关键词（会从 text 中匹配并着色） */
  keyword?: string;
}

export interface TimelineClip {
  path: string;
  duration: number;
  label?: string;
}

export interface Segment {
  start: number;
  end: number;
}

export interface Shot {
  clipIndex: number;
  srcIn: number;
  duration: number;
  /** 1=原速；<1 表示放慢（素材不够长时用） */
  speed: number;
  /** 变速后仍不足的时长，用末帧补 */
  pad: number;
}

export interface StyleOptions {
  width: number;
  height: number;
  fps: number;
  /** 画中画：null 表示不放。frac=正方形裁切边长占源宽比例，topFrac=裁切框顶部位置占源高比例 */
  pip: null | { size: number; x: number; y: number; frac: number; topFrac: number };
  subtitles: boolean;
  assPath?: string;
  fontsDir?: string;
  contrast: number;
  saturation: number;
  sharpness: number;
  fadeIn: number;
  fadeOut: number;
  loudnorm: boolean;
}

export const DEFAULT_STYLE: StyleOptions = {
  width: 720,
  height: 1280,
  fps: 25,
  pip: { size: 240, x: 240, y: 70, frac: 0.35, topFrac: 0.55 },
  subtitles: true,
  contrast: 1.05,
  saturation: 1.07,
  sharpness: 0.3,
  fadeIn: 0.35,
  fadeOut: 0.55,
  loudnorm: true,
};

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

/** 用字幕 cue 切段；没 cue 就按 targetShot 秒一段均分 */
export function buildSegments(totalDuration: number, cues: TimelineCue[] = [], targetShot = 3.2, minShot = 1.6): Segment[] {
  const usable = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map((c) => ({ start: Math.max(0, c.start), end: Math.min(totalDuration, c.end) }))
    .filter((c) => c.end - c.start >= 0.2)
    .sort((a, b) => a.start - b.start);
  if (!usable.length) {
    const count = Math.max(1, Math.round(totalDuration / targetShot));
    const step = totalDuration / count;
    return Array.from({ length: count }, (_, i) => ({ start: round(i * step), end: round((i + 1) * step) }));
  }
  // 合并过短的段，保证每个镜头不会短于 minShot
  const merged: Segment[] = [];
  for (const cue of usable) {
    const last = merged[merged.length - 1];
    if (last && cue.start - last.end < 0.15) last.end = Math.max(last.end, cue.end);
    else merged.push({ ...cue });
  }
  const out: Segment[] = [];
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    const prevEnd = i === 0 ? 0 : merged[i - 1].end;
    const nextStart = i + 1 < merged.length ? merged[i + 1].start : totalDuration;
    out.push({ start: round(i === 0 ? 0 : Math.min(seg.start, prevEnd)), end: round(Math.max(seg.end, Math.min(nextStart, seg.end + 0.4))) });
  }
  // 头尾对齐到整段，避免出现空隙（concat 不能有空洞）
  for (let i = 0; i < out.length; i++) {
    out[i].start = i === 0 ? 0 : out[i - 1].end;
    out[i].end = i === out.length - 1 ? round(totalDuration) : out[i].end;
  }
  // 再按 targetShot 细分：一句话太久也只切一个镜头会很闷，长段等分成多个镜头
  const split: Segment[] = [];
  for (const seg of out) {
    const len = seg.end - seg.start;
    if (len <= 0.15) continue;
    const n = Math.max(1, Math.round(len / targetShot));
    if (n === 1) {
      split.push(seg);
      continue;
    }
    for (let k = 0; k < n; k++) {
      const a = round(seg.start + (len * k) / n);
      const b = k === n - 1 ? seg.end : round(seg.start + (len * (k + 1)) / n);
      if (b - a > 0.15) split.push({ start: a, end: b });
    }
  }
  return split.filter((s) => s.end - s.start > 0.15);
}

/** 确定性伪随机，同一份 EDL 反复跑结果一致 */
function hash(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * 给每段分配镜头：
 *  - 优先选“还没用过 / 用得少”的素材，次选够长的；
 *  - 素材不够长时放慢（最多 1.55x），仍不够再补末帧，绝不留空洞。
 */
export function buildShotPlan(segments: Segment[], clips: TimelineClip[], seed = 7): Shot[] {
  if (!clips.length) throw new Error("没有可用素材");
  const minSpeed = 0.65;
  const used = new Map<number, number>();
  const shots: Shot[] = [];
  let prev: number | null = null;
  for (let i = 0; i < segments.length; i++) {
    const need = round(segments[i].end - segments[i].start, 3);
    if (need <= 0) continue;
    const candidates = clips
      .map((clip, idx) => ({ idx, usable: Math.max(0, clip.duration - 0.2), used: used.get(idx) ?? 0 }))
      .filter((c) => c.usable >= need * minSpeed);
    let pool = candidates.length ? candidates : clips.map((clip, idx) => ({ idx, usable: Math.max(0, clip.duration - 0.2), used: used.get(idx) ?? 0 }));
    // 不连着用同一支素材（除非只剩它可用）
    if (pool.length > 1 && prev !== null) {
      const filtered = pool.filter((c) => c.idx !== prev);
      if (filtered.length) pool = filtered;
    }
    // 先用得最少的优先（保证镜头分散），同样次数时用种子洗牌，避免总是挑「最长的三支」
    pool.sort((a, b) => a.used - b.used || hash(seed * 31 + i * 977 + a.idx) - hash(seed * 31 + i * 977 + b.idx));
    const best = pool.slice(0, Math.min(4, pool.length));
    const pick = best[Math.floor(hash(seed * 1000 + i) * best.length) % best.length];
    prev = pick.idx;
    const clip = clips[pick.idx];
    used.set(pick.idx, (used.get(pick.idx) ?? 0) + 1);
    const usable = Math.max(0.4, clip.duration - 0.2);
    const speed = usable >= need ? 1 : Math.max(minSpeed, round(usable / need, 3));
    const stretched = speed === 1 ? need : round(usable / speed, 3);
    const pad = speed === 1 ? 0 : round(Math.max(0, need - stretched), 3);
    const maxIn = Math.max(0, clip.duration - Math.min(usable, need * speed) - 0.05);
    const srcIn = round(0.05 + hash(seed * 7919 + i * 131) * Math.max(0, maxIn), 3);
    shots.push({ clipIndex: pick.idx, srcIn, duration: round(Math.min(usable, need * speed), 3), speed, pad });
  }
  return shots;
}

/** ASS 时间：0:00:00.00 */
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

const assEscape = (t: string) => t.replace(/\\/g, "＼").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");

const PUNCT = "，。？！；：、,.?!;:";

/** 按字数切句：优先切在标点后，避免字幕以「，。」开头或把一个词切成两半 */
function splitByLength(text: string, max: number): string[] {
  const chars = [...text];
  if (chars.length <= max) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let end = Math.min(chars.length, i + max);
    if (end < chars.length) {
      for (let k = end; k > i + Math.floor(max * 0.5); k--) {
        if (PUNCT.includes(chars[k - 1])) {
          end = k;
          break;
        }
      }
      while (end < chars.length && PUNCT.includes(chars[end]) && end - i < max + 2) end++;
    }
    out.push(chars.slice(i, end).join(""));
    i = end;
  }
  return out;
}

/** 中文粗体白字 + 黑描边 + 关键词黄，跟对标视频同一套视觉 */
export function buildAss(cues: TimelineCue[], opts: { width: number; height: number; fontName?: string; fontSize?: number; marginV?: number; highlight?: string; maxChars?: number } = { width: 720, height: 1280 }): string {
  const fontName = opts.fontName || "Microsoft YaHei";
  const fontSize = opts.fontSize || Math.round(opts.width / 12);
  const marginV = opts.marginV ?? Math.round(opts.height * 0.137);
  const highlight = opts.highlight || "&H0000D4FF&";
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(4, Math.round(fontSize / 10))},${Math.max(2, Math.round(fontSize / 24))},2,40,40,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  // 一条 cue 太长会让字幕糊在屏幕上一整句：按字数均分成几条短句（每行 ≤ maxChars 字，时间按比例切）
  // 中文字宽≈fontSize，按可用宽度（扣掉左右 margin 与描边）反推每行能放几个字
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : Math.max(6, Math.floor((opts.width - 100) / fontSize));
  const events = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && (c.text || "").trim())
    .sort((a, b) => a.start - b.start)
    .flatMap((c) => {
      const parts = splitByLength(String(c.text).trim(), maxChars);
      const span = (c.end - c.start) / parts.length;
      const out: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i].trim();
        if (!seg) continue;
        let text = assEscape(seg);
        const kw = (c.keyword || "").trim();
        if (kw && text.includes(kw)) text = text.replace(kw, `{\\c${highlight}}${kw}{\\c&H00FFFFFF&}`);
        const from = i === parts.length - 1 ? c.end : c.start + span * (i + 1);
        out.push(`Dialogue: 0,${assTime(c.start + span * i)},${assTime(from)},Default,,0,0,0,,${text}`);
      }
      return out;
    });
  return [...head, ...events, ""].join("\n");
}

/** 拼 ffmpeg 的 -filter_complex：输入顺序 = clips（按唯一化后的下标） + [配音] + [可选画中画] */
export function buildFilterComplex(shots: Shot[], clipInputIndex: number[], style: StyleOptions, opts: { totalDuration: number; hasVoice: boolean; hasPip: boolean }): { filter: string; videoLabel: string; audioLabel: string | null } {
  const { width, height, fps } = style;
  const parts: string[] = [];
  const labels: string[] = [];
  shots.forEach((shot, i) => {
    const input = clipInputIndex[shot.clipIndex];
    const chain = [
      `trim=start=${shot.srcIn}:duration=${shot.duration}`,
      `setpts=(PTS-STARTPTS)/${shot.speed}`,
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      "setsar=1",
      `fps=${fps}`,
      "format=yuv420p",
    ];
    if (shot.pad > 0.01) chain.push(`tpad=stop_mode=clone:stop_duration=${shot.pad}`);
    parts.push(`[${input}:v]${chain.join(",")}[s${i}]`);
    labels.push(`[s${i}]`);
  });
  const n = shots.length;
  parts.push(`${labels.join("")}concat=n=${n}:v=1:a=0[cut]`);
  const grade = [`eq=contrast=${style.contrast}:saturation=${style.saturation}`];
  if (style.sharpness > 0) grade.push(`unsharp=5:5:${style.sharpness}`);
  parts.push(`[cut]${grade.join(",")}[graded]`);

  let videoLabel = "graded";
  if (style.pip && opts.hasPip) {
    const pipInput = clipInputIndex.length + (opts.hasVoice ? 1 : 0);
    const p = style.pip;
    const frac = p.frac > 0 ? p.frac : 0.35;
    const center = p.topFrac >= 0 ? p.topFrac : 0.55;
    const r = Math.round(p.size / 2) - 3;
    const inner = Math.round(p.size / 2) - 8;
    // 边长用 iw 表达 → 无论源素材多大都是正方形；水平居中，纵向以 center 为圆心落在人脸高度
    parts.push(`[${pipInput}:v]crop=iw*${frac}:iw*${frac}:(iw-iw*${frac})/2:ih*${center}-iw*${frac}/2,scale=${p.size}:${p.size},format=rgba,` +
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt((X-${p.size / 2})*(X-${p.size / 2})+(Y-${p.size / 2})*(Y-${p.size / 2}),${inner * inner}),255,0)'[pip]`);
    parts.push(`color=c=white@1.0:s=${p.size}x${p.size},format=rgba,` +
      `geq=r='255':g='255':b='255':a='if(between((X-${p.size / 2})*(X-${p.size / 2})+(Y-${p.size / 2})*(Y-${p.size / 2}),${(r - 3) * (r - 3)},${r * r}),255,0)'[ring]`);
    parts.push(`[graded][pip]overlay=${p.x}:${p.y}:eof_action=repeat[withpip]`);
    parts.push(`[withpip][ring]overlay=${p.x}:${p.y}[piped]`);
    videoLabel = "piped";
  }

  const tail: string[] = [];
  if (style.subtitles && style.assPath) {
    const path = style.assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    const fonts = style.fontsDir ? `:fontsdir='${style.fontsDir.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
    tail.push(`subtitles='${path}'${fonts}`);
  }
  if (style.fadeIn > 0) tail.push(`fade=t=in:st=0:d=${style.fadeIn}`);
  if (style.fadeOut > 0) tail.push(`fade=t=out:st=${Math.max(0, opts.totalDuration - style.fadeOut)}:d=${style.fadeOut}`);
  tail.push("format=yuv420p");
  parts.push(`[${videoLabel}]${tail.join(",")}[vout]`);

  let audioLabel: string | null = null;
  if (opts.hasVoice) {
    const voiceInput = clipInputIndex.length;
    const afx = style.loudnorm ? "loudnorm=I=-15:TP=-1.5:LRA=11" : "anull";
    parts.push(`[${voiceInput}:a]${afx},aresample=48000[aout]`);
    audioLabel = "aout";
  }
  return { filter: parts.join(";"), videoLabel: "vout", audioLabel };
}
