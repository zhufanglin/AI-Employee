import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { userDir } from "../capabilities/capabilities/files";

/**
 * P42 战略表 + 人设表（服务端）：
 * - 战略正文落工作区文件 <workspace>/<phone>/企业战略.md（front-matter + markdown），Prisma 只存索引与版本记录；
 * - 人设存 PersonaProfile（一账号一行）；
 * - resolveForEmployee 供 worker 按 SKILL.md front-matter 的 needs 按需注入。
 */

export const STRATEGY_FILE = "企业战略.md";
export const STRATEGY_MAX_CHARS = 6000;
export const PERSONA_MAX_CHARS = 1500;

/** 内置战略模板：10 个板块，每节 2 行填写提示（标题必须保持这 10 个）。 */
export const STRATEGY_TEMPLATE = [
  "# 企业战略",
  "",
  "> 这是公司的战略方向文档，员工会按岗位需要读取其中的相关板块。",
  "> 不确定的地方可以留空，但填得越具体，员工产出越贴合。",
  "",
  "## 1. 企业愿景与使命",
  "- 我们想成为什么样的公司：",
  "- 我们为客户解决的核心问题：",
  "",
  "## 2. 产品体系",
  "- 主营产品/服务与价格带：",
  "- 当前主推的产品与明确不做的产品：",
  "",
  "## 3. 服务客户人群",
  "- 目标客户画像（行业/规模/角色）：",
  "- 客户最常见的需求与顾虑：",
  "",
  "## 4. 竞争与优势",
  "- 主要同行与我们的差异点：",
  "- 客户选择我们的真实理由（有数据更好）：",
  "",
  "## 5. 获客渠道",
  "- 当前主要获客渠道与大致占比：",
  "- 下一步要测试或放大的渠道：",
  "",
  "## 6. 内容策略",
  "- 内容平台、形式与发布频率：",
  "- 内容主题与必须避免的表达：",
  "",
  "## 7. 销售与转化",
  "- 线索到成交的关键步骤：",
  "- 报价、优惠与升级老板处理的边界：",
  "",
  "## 8. 私域运营",
  "- 私域承接方式与触达频率：",
  "- 社群/朋友圈/1v1 的内容节奏：",
  "",
  "## 9. 团队与资源",
  "- 当前团队与各自负责的事：",
  "- 可调用的预算、工具与外部资源：",
  "",
  "## 10. 本季度目标",
  "- 本季度最重要的 3 个数字目标：",
  "- 达成目标的关键动作与检查节点：",
  "",
].join("\n");

/** 从 SKILL.md front-matter 里解析 needs 数组；解析不到一律返回 []。 */
export function parseNeeds(skillMd: string | null | undefined): string[] {
  const text = typeof skillMd === "string" ? skillMd : "";
  if (!text) return [];
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return [];
  for (const line of block[1].split(/\r?\n/)) {
    const hit = /^needs\s*:\s*(.*)$/.exec(line.trim());
    if (!hit) continue;
    const raw = hit[1].trim();
    if (!raw) return [];
    // 支持 [a, b] / ["a", "b"] / a, b 三种写法
    const list = raw.replace(/^\[/, "").replace(/\]$/, "").split(",");
    return list.map((item) => item.trim().replace(/^["']|["']$/g, "").trim()).filter(Boolean);
  }
  return [];
}

function splitFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const hit = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw);
  if (!hit) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of hit[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: raw.slice(hit[0].length) };
}

function frontMatter(version: string, updated: string, owner: string): string {
  return "---\nversion: " + version + "\nupdated: " + updated + "\nowner: " + owner + "\n---\n";
}

/** V1.0 -> V1.1；非法版本从 V1.1 起算。 */
function bumpVersion(version: any): string {
  const hit = /^V(\d+)\.(\d+)$/i.exec(String(version ?? "").trim());
  if (!hit) return "V1.1";
  return "V" + hit[1] + "." + (Number(hit[2]) + 1);
}

function iso(value: any): any {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function optionalText(value: any): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function requiredName(value: any): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new BadRequestException("name 必填");
  if (name.length > 80) throw new BadRequestException("name 过长（最多 80 字）");
  return name;
}

function parseDate(value: any, fallback: Date): Date {
  if (value === undefined || value === null || value === "") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function cell(value: any): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

@Injectable()
export class StrategyService {
  constructor(private readonly prisma: PrismaService) {}

  private phoneOf(user: any): string {
    const phone = typeof user?.phone === "string" ? user.phone.trim() : "";
    if (!phone) throw new BadRequestException("当前账户没有绑定手机号");
    return phone;
  }

  /**
   * 战略文件必须落在该账号的工作区目录里（与 file_list/file_read 看到的是同一个目录，
   * 能力层的工作区 key 是 userId 而不是手机号），否则员工读不到。
   */
  private async filePath(user: any): Promise<string> {
    const key = await this.workspaceKeyOf(user);
    return join(userDir(key), STRATEGY_FILE);
  }

  private async workspaceKeyOf(user: any): Promise<string> {
    const phone = this.phoneOf(user);
    const id = typeof user?.id === "string" && user.id.trim() ? user.id.trim() : "";
    if (id) return id;
    const row = await (this.prisma as any).user.findUnique({ where: { phone }, select: { id: true } });
    return row?.id || phone;
  }

  /** 首次访问落模板 + 建 StrategyDoc 行；返回文件原文（含 front-matter）。 */
  private async ensureDoc(phone: string, path: string): Promise<{ raw: string; row: any }> {
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch {
      const now = new Date();
      raw = frontMatter("V1.0", now.toISOString(), phone) + STRATEGY_TEMPLATE;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw, "utf8");
    }
    const meta = splitFrontMatter(raw).meta;
    const row = await (this.prisma as any).strategyDoc.upsert({
      where: { phone },
      create: { phone, version: meta.version || "V1.0", filePath: path },
      update: {},
    });
    return { raw, row };
  }

  async get(user: any) {
    const phone = this.phoneOf(user);
    const { raw, row } = await this.ensureDoc(phone, await this.filePath(user));
    return {
      version: row?.version || "V1.0",
      updatedAt: iso(row?.updatedAt),
      updatedBy: row?.updatedBy ?? null,
      content: splitFrontMatter(raw).body,
    };
  }

  async save(user: any, body: any = {}) {
    const phone = this.phoneOf(user);
    const content = typeof body?.content === "string" ? body.content : "";
    if (!body || typeof body.content !== "string") throw new BadRequestException("content 必填");
    const path = await this.filePath(user);
    const { row } = await this.ensureDoc(phone, path);
    const now = new Date();
    const version = bumpVersion(row?.version);
    const updatedAt = now.toISOString();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, frontMatter(version, updatedAt, phone) + content, "utf8");
    await (this.prisma as any).strategyDoc.upsert({
      where: { phone },
      create: { phone, version, filePath: path, updatedBy: phone, updatedAt: now },
      update: { version, filePath: path, updatedBy: phone, updatedAt: now },
    });

    const sectionsRaw = body?.sections;
    const sections = Array.isArray(sectionsRaw)
      ? JSON.stringify(sectionsRaw)
      : typeof sectionsRaw === "string"
        ? sectionsRaw
        : null;
    const summary =
      typeof body?.summary === "string" && body.summary.trim()
        ? body.summary.trim()
        : content.slice(0, 60);
    await (this.prisma as any).strategyIteration.create({
      data: {
        phone,
        versionNo: version,
        versionType: typeof body?.versionType === "string" && body.versionType.trim() ? body.versionType.trim() : "微调",
        iteratedAt: now,
        trigger: typeof body?.trigger === "string" && body.trigger.trim() ? body.trigger.trim() : "手动编辑",
        sections,
        summary,
        author: optionalText(body?.author) ?? phone,
        docUrl: optionalText(body?.docUrl),
      },
    });
    return { version, updatedAt };
  }

  async iterations(user: any) {
    const phone = this.phoneOf(user);
    const rows = await (this.prisma as any).strategyIteration.findMany({
      where: { phone },
      orderBy: [{ iteratedAt: "desc" }, { createdAt: "desc" }],
      take: 20,
    });
    return { items: rows };
  }

  private shapePersona(row: any) {
    return {
      id: row.id,
      name: row.name,
      positioning: row.positioning ?? null,
      plan: row.plan ?? null,
      accountId: row.accountId ?? null,
      followers: row.followers ?? null,
      homepage: row.homepage ?? null,
      effectiveAt: iso(row.effectiveAt),
    };
  }

  async personas(user: any) {
    const phone = this.phoneOf(user);
    const rows = await (this.prisma as any).personaProfile.findMany({
      where: { phone },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
    });
    return { items: rows.map((row: any) => this.shapePersona(row)) };
  }

  /** 按 (phone, name) upsert；已存在则只覆盖本次传入的字段。 */
  async upsertPersona(user: any, body: any = {}) {
    const phone = this.phoneOf(user);
    const name = requiredName(body?.name);
    const found = await (this.prisma as any).personaProfile.findFirst({ where: { phone, name } });

    let row: any;
    if (found) {
      // 只覆盖本次传入的字段；显式传空串表示清空（置 null）
      const data: any = {};
      for (const key of ["positioning", "accountId", "followers", "homepage"]) {
        if (body?.[key] !== undefined) data[key] = optionalText(body[key]);
      }
      if (body?.plan !== undefined) data.plan = typeof body.plan === "string" ? body.plan : String(body.plan ?? "");
      if (body?.effectiveAt !== undefined && body?.effectiveAt !== null && body?.effectiveAt !== "") {
        data.effectiveAt = parseDate(body.effectiveAt, new Date());
      }
      row = await (this.prisma as any).personaProfile.update({ where: { id: found.id }, data });
    } else {
      row = await (this.prisma as any).personaProfile.create({
        data: {
          phone,
          name,
          positioning: optionalText(body?.positioning),
          plan: typeof body?.plan === "string" ? body.plan : String(body?.plan ?? ""),
          accountId: optionalText(body?.accountId),
          followers: optionalText(body?.followers),
          homepage: optionalText(body?.homepage),
          effectiveAt: parseDate(body?.effectiveAt, new Date()),
        },
      });
    }
    return { item: this.shapePersona(row) };
  }

  async removePersona(user: any, id: string) {
    const phone = this.phoneOf(user);
    const value = typeof id === "string" ? id.trim() : "";
    if (!value) throw new BadRequestException("id 必填");
    const found = await (this.prisma as any).personaProfile.findFirst({ where: { id: value, phone } });
    if (!found) throw new NotFoundException("人设不存在或不属于你");
    await (this.prisma as any).personaProfile.delete({ where: { id: value } });
    return { ok: true };
  }

  /**
   * worker 注入用：读战略文件并按 needs 切片（≤6000 字）；needs 含 persona 时渲染人设表（≤1500 字）。
   * 文件/表缺失一律静默返回空串。
   */
  async resolveForEmployee(userId: string, phone: string, needs: string[]): Promise<{ strategyText: string; personaText: string; strategyVersion: string; strategyUpdatedAt: string | null }> {
    const out = { strategyText: "", personaText: "", strategyVersion: "", strategyUpdatedAt: null as string | null };
    const owner = typeof phone === "string" ? phone.trim() : "";
    if (!owner) return out;
    const key = typeof userId === "string" && userId.trim() ? userId.trim() : owner;
    const list = Array.isArray(needs) ? needs.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];

    try {
      const raw = await readFile(join(userDir(key), STRATEGY_FILE), "utf8");
      let body = splitFrontMatter(raw).body.trim();
      const hasSectionNeed = list.some((item) => item.startsWith("strategy.sections:"));
      // 兼容 needs: [strategy.sections:a,b] 被按逗号拆成多项的情况
      const sections = hasSectionNeed
        ? list
            .flatMap((item) =>
              item.startsWith("strategy.sections:")
                ? item.slice("strategy.sections:".length).split(/[,，]/)
                : [item],
            )
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
      if (sections.length) {
        const heads: Array<{ title: string; start: number }> = [];
        const re = /^##[ \t]+(.+)$/gm;
        let hit: RegExpExecArray | null;
        while ((hit = re.exec(body))) heads.push({ title: hit[1].trim(), start: hit.index });
        const picked: string[] = [];
        for (let i = 0; i < heads.length; i++) {
          if (!sections.some((name) => heads[i].title.includes(name))) continue;
          const end = i + 1 < heads.length ? heads[i + 1].start : body.length;
          picked.push(body.slice(heads[i].start, end).trim());
        }
        body = picked.join("\n\n");
      }
      out.strategyText = body.slice(0, STRATEGY_MAX_CHARS);
      const doc = await (this.prisma as any).strategyDoc.findUnique({ where: { phone: owner } });
      out.strategyVersion = doc?.version || "V1.0";
      out.strategyUpdatedAt = iso(doc?.updatedAt);
    } catch {
      // 文件不存在或不可读 → 空串
    }

    if (list.some((item) => item === "persona" || item.startsWith("persona."))) {
      try {
        const rows = await (this.prisma as any).personaProfile.findMany({
          where: { phone: owner },
          orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
        });
        if (rows.length) {
          const lines = [
            "| 名称 | 定位 | 人设规划 | 所属账号 | 粉丝量 | 主页链接 |",
            "| --- | --- | --- | --- | --- | --- |",
            ...rows.map((row: any) =>
              "| " + [row.name, row.positioning, row.plan, row.accountId, row.followers, row.homepage].map(cell).join(" | ") + " |",
            ),
          ];
          out.personaText = lines.join("\n").slice(0, PERSONA_MAX_CHARS);
        }
      } catch {
        // 表缺失 → 空串
      }
    }
    return out;
  }
}
