import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = "packages/desktop/resources/skills";
const out = {};
for (const d of readdirSync(dir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const p = dir + "/" + d.name + "/SKILL.md";
  try { const md = readFileSync(p, "utf8"); if (md.trim()) out[d.name] = md; } catch {}
}
writeFileSync("_deploy/t36/skills.json", JSON.stringify(out, null, 1), "utf8");
console.log("skills.json entries=" + Object.keys(out).length);
