import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userDir } from "../capabilities/capabilities/files";

/**
 * 工作区规则（P43）：原版每会话把工作区的 AGENTS.md / TOOLS.md 注入上下文。
 * 云端执行器的任务由服务端组装，所以这里从服务端工作区（userDir(userId)）读同名文件；
 * 读不到就返回空串（不影响任务执行）。
 */
export const WORKSPACE_RULE_FILES = ["AGENTS.md", "TOOLS.md"] as const;
const MAX_CHARS = 20000;

export function readWorkspaceRules(userId: string): string {
  if (!userId) return "";
  const base = userDir(userId);
  const parts: string[] = [];
  for (const name of WORKSPACE_RULE_FILES) {
    const file = join(base, name);
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8").trim();
      if (text) parts.push("### " + name + "\n" + text);
    } catch {
      /* 读不到就跳过 */
    }
  }
  return parts.join("\n\n").slice(0, MAX_CHARS);
}
