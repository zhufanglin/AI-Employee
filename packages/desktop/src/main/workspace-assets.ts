import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type SkillManifest = { version?: string; skills?: Array<{ name?: string }> }

/** 首次启动时把随应用发布的员工 Skill 和工作区规则装入用户目录；不覆盖用户已有内容。 */
export function installWorkspaceAssets(home: string, enabledSlugs: string[]) {
  const sourceRoot = join(app.getAppPath(), 'resources')
  const sourceSkills = join(sourceRoot, 'skills')
  const manifestPath = join(sourceSkills, 'skill-manifest.json')
  if (!existsSync(manifestPath)) throw new Error('员工技能清单不存在：' + manifestPath)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as SkillManifest
  if (!Array.isArray(manifest.skills)) throw new Error('员工技能清单格式不正确')

  const targetSkills = join(home, 'skills')
  const disabledSkills = join(home, 'skills-disabled')
  mkdirSync(targetSkills, { recursive: true })
  mkdirSync(disabledSkills, { recursive: true })
  const lockPath = join(home, '.workspace-assets.json')
  let lock: any = {}
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, '')) } catch {}
  const managed = new Set<string>(Array.isArray(lock.managedSkills) ? lock.managedSkills : [])
  const enabled = new Set(enabledSlugs)
  const installed: string[] = []
  for (const item of manifest.skills) {
    const name = item.name
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) continue
    const source = join(sourceSkills, name)
    const target = join(targetSkills, name)
    const disabled = join(disabledSkills, name)
    if (enabled.has(name)) {
      if (managed.has(name) && !existsSync(target)) {
        const saved = readdirSync(disabledSkills)
          .filter((entry) => entry === name || entry.startsWith(name + '.revoked-'))
          .sort()
          .at(-1)
        if (saved) renameSync(join(disabledSkills, saved), target)
      }
      if (!existsSync(source) || existsSync(target)) continue
      if (!managed.has(name) && readdirSync(disabledSkills).some((entry) => entry === name || entry.startsWith(name + '.revoked-'))) continue
      cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
      managed.add(name)
      installed.push(name)
    } else if (managed.has(name) && existsSync(target)) {
      // Preserve customer edits and files while removing the skill from OpenClaw's active scan path.
      const destination = existsSync(disabled) ? disabled + '.revoked-' + Date.now() : disabled
      renameSync(target, destination)
    }
  }

  const contextSource = join(sourceRoot, 'context')
  for (const file of ['AGENTS.md', 'TOOLS.md']) {
    const source = join(contextSource, file)
    const target = join(home, file)
    if (existsSync(source) && !existsSync(target)) cpSync(source, target)
  }

  lock.manifestVersion = manifest.version || 'unknown'
  lock.installedAt = lock.installedAt || new Date().toISOString()
  lock.managedSkills = [...managed]
  lock.skills = [...new Set([...(Array.isArray(lock.skills) ? lock.skills : []), ...installed])]
  lock.enabledSkills = manifest.skills.map((item) => item.name).filter((name): name is string => !!name && enabled.has(name))
  writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8')
  return { installed, total: manifest.skills.length }
}
