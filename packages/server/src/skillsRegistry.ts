// List packaged skills first, then retain best-effort detection for legacy/custom integrations.
//
// The default workflow must be completely runnable from this plugin's `skills/` tree. Host-wide
// skill folders and plugin caches are observed only to describe optional legacy/custom entries;
// they are never an installation prerequisite for the packaged default flow. Every probe is
// fail-open: missing or malformed host data merely yields "not detected", never a registry 500.
import { parseSkillSources, type SkillSourceDefinition, type SkillTier } from '@tenon/kernel'
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'

export type SkillSource = 'local-plugin' | 'external-marketplace' | 'builtin' | 'user'

export interface SkillEntry {
  name: string
  installed: boolean
  source: SkillSource
  /** 从真实 SKILL.md 提取的原始一句话用途；读取不到时省略，客户端保持向后兼容。 */
  description?: string
  /** Registry readiness tier; entries outside the registry remain optional. */
  tier: SkillTier
  /** false means the upstream was deliberately retired, not a broken local machine. */
  available: boolean
  installCmd?: string
}

/** Host builtins remain a fallback only when a package does not ship the same skill name. */
const BUILTIN_SKILLS = new Set(['verify', 'run', 'code-review', 'security-review'])

function skillDescriptionFrom(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8')
    const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1]
    if (frontmatter) {
      const line = frontmatter.split('\n').find((candidate) => /^description\s*:/.test(candidate.trim()))
      const value = line?.replace(/^\s*description\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
      if (value) return value.replace(/\s+/g, ' ').slice(0, 240)
    }
    const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*/, '')
    const paragraph = body
      .split(/\n\s*\n/)
      .map((candidate) => candidate.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim())
      .find(Boolean)
    return paragraph ? paragraph.slice(0, 240) : undefined
  } catch {
    return undefined
  }
}

function installedPluginRoots(claudeDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    const plugins = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'plugins') : undefined
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return []
    return Object.values(plugins)
      .flat()
      .map((entry) => typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'installPath') : undefined)
      .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
  } catch {
    return []
  }
}

function descriptionForSkill(name: string, repoRoot: string, claudeDir: string, meta?: SkillSourceDefinition): string | undefined {
  const home = dirname(claudeDir)
  const candidates = [...new Set([
    meta?.contentSkill,
    meta?.skill,
    name,
    name.includes(':') ? name.split(':').at(-1) : undefined,
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== ''))]
  const roots = [
    join(repoRoot, 'skills'),
    join(claudeDir, 'skills'),
    join(home, '.agents', 'skills'),
    ...installedPluginRoots(claudeDir).map((root) => join(root, 'skills')),
  ]
  for (const root of roots) {
    for (const candidate of candidates) {
      const description = skillDescriptionFrom(join(root, candidate, 'SKILL.md'))
      if (description) return description
    }
  }

  if (meta?.tool === 'claude-plugin') {
    const plugin = meta.skill ?? name.split(':')[0] ?? name
    const cache = join(home, '.codex', 'plugins', 'cache')
    for (const marketplace of childDirsIn(cache)) {
      const pluginRoot = join(cache, marketplace, plugin)
      for (const version of childDirsIn(pluginRoot)) {
        for (const candidate of candidates) {
          const description = skillDescriptionFrom(join(pluginRoot, version, 'skills', candidate, 'SKILL.md'))
            ?? skillDescriptionFrom(join(pluginRoot, version, 'skills', 'SKILL.md'))
          if (description) return description
        }
      }
    }
  }
  return undefined
}

export interface SkillFiles {
  name: string
  /** 来源分类（与 SkillEntry.source 同枚举）。 */
  source: SkillSource
  /** 来源目录（插件名 / skills 根），给页面做溯源展示。 */
  origin: string
  /** 技能目录下全部普通文件（相对技能根、posix 分隔、稳定序）；跳过隐藏项与 >1MB 的文件。 */
  files: Array<{ path: string; bytes: number }>
}

const MAX_SKILL_FILE_BYTES = 256 * 1024
const MAX_LISTED_FILE_BYTES = 1024 * 1024

function skillRoots(repoRoot: string, claudeDir: string): Array<{ dir: string; source: SkillSource; origin: string }> {
  const home = dirname(claudeDir)
  const roots: Array<{ dir: string; source: SkillSource; origin: string }> = [
    { dir: join(repoRoot, 'skills'), source: 'local-plugin', origin: 'tenon' },
    { dir: join(claudeDir, 'skills'), source: 'user', origin: '~/.claude/skills' },
    { dir: join(home, '.agents', 'skills'), source: 'user', origin: '~/.agents/skills' },
    ...installedPluginRoots(claudeDir).map((root) => ({ dir: join(root, 'skills'), source: 'external-marketplace' as SkillSource, origin: root.split('/').filter(Boolean).at(-1) ?? root })),
  ]
  const cache = join(home, '.codex', 'plugins', 'cache')
  for (const marketplace of childDirsIn(cache)) {
    for (const plugin of childDirsIn(join(cache, marketplace))) {
      for (const version of childDirsIn(join(cache, marketplace, plugin))) {
        roots.push({ dir: join(cache, marketplace, plugin, version, 'skills'), source: 'external-marketplace', origin: `${marketplace}/${plugin}@${version}` })
      }
    }
  }
  return roots
}

/** 第一个含 SKILL.md 的技能目录（与 descriptionForSkill 同探测顺序）。 */
function locateSkillDir(name: string, repoRoot: string, claudeDir: string): { dir: string; source: SkillSource; origin: string } | undefined {
  const candidates = [...new Set([name, name.includes(':') ? name.split(':').at(-1) : undefined]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== ''))]
  for (const root of skillRoots(repoRoot, claudeDir)) {
    for (const candidate of candidates) {
      const dir = join(root.dir, candidate)
      try {
        if (statSync(join(dir, 'SKILL.md')).isFile()) return { dir, source: root.source, origin: root.origin }
      } catch {
        continue
      }
    }
  }
  return undefined
}

function walkFiles(root: string, rel = ''): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = []
  let entries: string[]
  try {
    entries = readdirSync(join(root, rel)).sort()
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const relPath = rel === '' ? entry : `${rel}/${entry}`
    let info
    try {
      info = statSync(join(root, relPath))
    } catch {
      continue
    }
    if (info.isDirectory()) out.push(...walkFiles(root, relPath))
    else if (info.isFile() && info.size <= MAX_LISTED_FILE_BYTES) out.push({ path: relPath, bytes: info.size })
  }
  return out
}

/** 某技能目录的文件清单（SKILL.md 恒排首位）；技能不存在 → undefined。 */
export function listSkillFiles(name: string, repoRoot: string, claudeDir: string): SkillFiles | undefined {
  const located = locateSkillDir(name, repoRoot, claudeDir)
  if (located === undefined) return undefined
  const files = walkFiles(located.dir).sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))
  return { name, source: located.source, origin: located.origin, files }
}

export type SkillFileRead =
  | { kind: 'ok'; path: string; text: string }
  | { kind: 'not-found' }
  | { kind: 'invalid-path' }
  | { kind: 'too-large' }
  | { kind: 'binary' }

/** 读技能目录内一个文本文件：路径必须在清单内（拒 `..` / 绝对路径 / 越界符号链接），≤256KB，无 NUL。 */
export function readSkillFile(name: string, relPath: string, repoRoot: string, claudeDir: string): SkillFileRead {
  if (relPath === '' || relPath.startsWith('/') || relPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return { kind: 'invalid-path' }
  }
  const listed = listSkillFiles(name, repoRoot, claudeDir)
  if (listed === undefined) return { kind: 'not-found' }
  const located = locateSkillDir(name, repoRoot, claudeDir)
  const entry = listed.files.find((file) => file.path === relPath)
  if (located === undefined || entry === undefined) return { kind: 'not-found' }
  if (entry.bytes > MAX_SKILL_FILE_BYTES) return { kind: 'too-large' }
  const absolute = join(located.dir, relPath)
  try {
    const realRoot = realpathSync(located.dir)
    const realFile = realpathSync(absolute)
    if (!realFile.startsWith(realRoot + sep) && realFile !== realRoot) return { kind: 'invalid-path' }
    const text = readFileSync(realFile, 'utf8')
    if (text.includes('\u0000')) return { kind: 'binary' }
    return { kind: 'ok', path: relPath, text }
  } catch {
    return { kind: 'not-found' }
  }
}

function skillDirsIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((name) => {
      const p = join(dir, name)
      try {
        return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'))
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function childDirsIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function localSkillDirs(repoRoot: string): string[] {
  return skillDirsIn(join(repoRoot, 'skills'))
}

/** EXTERNAL-SKILLS.md 声明行 → { name → 所属小节标题 }(小节 = `**…**` 行,用于来源分类)。 */
function externalSkillSections(repoRoot: string): Map<string, string> {
  const p = join(repoRoot, 'skills', 'EXTERNAL-SKILLS.md')
  const out = new Map<string, string>()
  if (!existsSync(p)) return out
  let section = ''
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim()
    const h = /^\*\*(.+)\*\*$/.exec(line)
    if (h?.[1]) {
      section = h[1]
      continue
    }
    const m = /^-\s+(\S+)/.exec(line)
    if (m?.[1]) out.set(m[1], section)
  }
  return out
}

/** 三源探测结果:已检出技能名集合 + 已启用插件的名字前缀集合(命名空间 token 匹配用)。 */
export function detectInstalled(claudeDir: string): { skills: Set<string>; pluginBases: Set<string>; codexPluginBases: Set<string> } {
  const skills = new Set<string>(skillDirsIn(join(claudeDir, 'skills')))
  // `npx skills add -g -y` installs for Codex and other agents under ~/.agents/skills.
  // Derive the home from the injected claudeDir so server tests and custom homes remain hermetic.
  for (const name of skillDirsIn(join(dirname(claudeDir), '.agents', 'skills'))) skills.add(name)
  const pluginBases = new Set<string>()
  const codexPluginBases = new Set<string>()

  const codexCache = join(dirname(claudeDir), '.codex', 'plugins', 'cache')
  for (const marketplace of childDirsIn(codexCache)) {
    for (const plugin of childDirsIn(join(codexCache, marketplace))) codexPluginBases.add(plugin)
  }

  // 源②:installed_plugins.json(v2:{version, plugins: {"name@mkt": [{installPath,…}]}})
  try {
    const raw = readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    let disabled: Record<string, unknown> = {}
    try {
      const settings: unknown = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
      if (typeof settings === 'object' && settings !== null) {
        const candidate = Reflect.get(settings, 'enabledPlugins')
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
          disabled = candidate as Record<string, unknown>
        }
      }
    } catch {
      /* settings 缺失/损坏 → 视为无禁用项(fail-open) */
    }
    const plugins = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'plugins') : undefined
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return { skills, pluginBases, codexPluginBases }
    for (const [key, entries] of Object.entries(plugins)) {
      if (disabled[key] === false) continue // 装了但被关掉 ≠ 已装
      const pluginBase = key.split('@')[0]
      if (pluginBase !== undefined) pluginBases.add(pluginBase)
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue
        const installPath = Reflect.get(entry, 'installPath')
        if (typeof installPath !== 'string') continue
        for (const name of skillDirsIn(join(installPath, 'skills'))) skills.add(name)
      }
    }
  } catch {
    /* installed_plugins.json 缺失/损坏 → 无插件源(fail-open) */
  }

  return { skills, pluginBases, codexPluginBases }
}

function sourceRegistry(repoRoot: string): Map<string, SkillSourceDefinition> {
  try {
    const rows = parseSkillSources(readFileSync(join(repoRoot, 'templates', 'skill-sources.yaml'), 'utf8'))
    return new Map(rows.map((row) => [row.token, row]))
  } catch {
    return new Map()
  }
}

function metadataFor(registry: ReadonlyMap<string, SkillSourceDefinition>, name: string): SkillSourceDefinition | undefined {
  const plugin = name.split(':')[0]
  return registry.get(name) ?? (name.includes(':') && plugin !== undefined ? registry.get(plugin) : undefined)
}

function executableOnPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    try {
      accessSync(join(dir, bin), constants.X_OK)
      return true
    } catch {
      // Continue through PATH; one inaccessible entry does not erase later real matches.
    }
  }
  return false
}

/** installCmd 只给 registry 能证明真实可执行的命令。 */
function installCmdFor(source: SkillSource, name: string, repoRoot: string, meta?: SkillSourceDefinition): string | undefined {
  if (meta?.unavailable) return undefined
  if (meta?.tool === 'skills-cli') {
    const select = meta.skill ? ` --skill ${meta.skill}` : ''
    return `npx skills add ${meta.source} -g -y${select}`
  }
  if (meta?.tool === 'npm') return `npm install -g ${meta.source}`
  if (meta?.tool === 'claude-plugin') return `claude plugin install ${meta.skill ?? meta.source}`
  if (meta?.tool === 'builtin' || meta?.tool === 'bundled') return undefined
  if (source === 'local-plugin') return `claude --plugin-dir ${repoRoot}`
  if (source === 'external-marketplace') return `claude plugin install ${name.split(':')[0]}`
  return undefined
}

export function listAllSkillsDetailed(repoRoot: string, claudeDir: string): SkillEntry[] {
  const detected = detectInstalled(claudeDir)
  const locals = new Set(localSkillDirs(repoRoot))
  const external = externalSkillSections(repoRoot)
  const registry = sourceRegistry(repoRoot)

  const names = new Set<string>([...locals, ...external.keys(), ...registry.keys()])
  const entries: SkillEntry[] = []
  for (const name of [...names].sort()) {
    const meta = metadataFor(registry, name)
    let source: SkillSource
    if (locals.has(name)) {
      source = 'local-plugin'
    } else if (BUILTIN_SKILLS.has(name)) {
      source = 'builtin'
    } else {
      const section = external.get(name) ?? ''
      source = /superpowers 系|commit-commands 系/.test(section) ? 'external-marketplace' : 'user'
    }

    const available = meta?.unavailable !== true
    let installed: boolean
    if (!available) {
      installed = false
    } else if (source === 'builtin' || meta?.tool === 'builtin' || meta?.tool === 'bundled' || locals.has(name)) {
      installed = true
    } else if (meta?.tool === 'npm') {
      installed = meta.bin !== undefined && executableOnPath(meta.bin)
    } else if (meta?.tool === 'claude-plugin') {
      const plugin = meta.skill ?? name.split(':')[0] ?? name
      installed = detected.codexPluginBases.has(plugin) || detected.skills.has(plugin) || detected.skills.has(name)
    } else if (name.includes(':')) {
      const plugin = name.split(':')[0] ?? name
      installed = detected.codexPluginBases.has(plugin) || detected.skills.has(meta?.skill ?? name)
    } else {
      installed = detected.skills.has(meta?.skill ?? name)
    }

    const description = descriptionForSkill(name, repoRoot, claudeDir, meta)
    entries.push({
      name,
      installed,
      source,
      ...(description ? { description } : {}),
      tier: meta?.tier ?? 'optional',
      available,
      ...(installed ? {} : { installCmd: installCmdFor(source, name, repoRoot, meta) }),
    })
  }
  return entries
}

export function listAllSkills(repoRoot: string): string[] {
  const merged = new Set([
    ...localSkillDirs(repoRoot),
    ...externalSkillSections(repoRoot).keys(),
    ...sourceRegistry(repoRoot).keys(),
  ])
  return [...merged].sort()
}
