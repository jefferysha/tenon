import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectInstalled, listAllSkills, listAllSkillsDetailed } from './skillsRegistry.js'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skills-reg-'))
  await mkdir(join(root, 'skills', 'tenon-open'), { recursive: true })
  await writeFile(join(root, 'skills', 'tenon-open', 'SKILL.md'), '# tenon-open\n', 'utf8')
  await mkdir(join(root, 'skills', 'tenon-build'), { recursive: true })
  await writeFile(join(root, 'skills', 'tenon-build', 'SKILL.md'), '# tenon-build\n', 'utf8')
  return root
}

describe('listAllSkills', () => {
  it('本地 skills/*/SKILL.md 目录名去重排序', async () => {
    const root = await makeRepo()
    expect(listAllSkills(root)).toEqual(['tenon-build', 'tenon-open'])
  })
})

// ── T6(v6 计划):skills「已装」探测 + registry 明细化 ──
// 真 fs 测试(mkdtemp 临时目录,零 mock)。口径抄老仓 pipeline-doctor.sh:121-149
// (研究报告 §4.1):① ~/.claude/skills/<name>/SKILL.md(跟随 symlink);
// ② installed_plugins.json 各插件 installPath 下 skills/*/SKILL.md,排除 settings.json
//   enabledPlugins=false 的插件(「装了但被关掉」不算已装)。

let base: string
let repoRoot: string
let claudeDir: string

function seedRepoSync(): void {
  for (const name of ['tenon-open', 'openspec-propose']) {
    mkdirSync(join(repoRoot, 'skills', name), { recursive: true })
    writeFileSync(join(repoRoot, 'skills', name, 'SKILL.md'), '# skill\n')
  }
}

function seedClaudeDir(): void {
  // 源①:用户自备技能目录(真目录一个 + symlink 一个——本机 17 条全是 symlink,必须跟随)
  mkdirSync(join(claudeDir, 'skills', 'grill-with-docs'), { recursive: true })
  writeFileSync(join(claudeDir, 'skills', 'grill-with-docs', 'SKILL.md'), '# g\n')
  const linkTarget = join(base, 'elsewhere', 'linked-skill')
  mkdirSync(linkTarget, { recursive: true })
  writeFileSync(join(linkTarget, 'SKILL.md'), '# l\n')
  symlinkSync(linkTarget, join(claudeDir, 'skills', 'linked-skill'))

  // 源②:installed_plugins.json(v2 形状对齐本机真实文件)+ enabledPlugins=false 排除
  const spPath = join(base, 'cache', 'superpowers')
  mkdirSync(join(spPath, 'skills', 'handoff'), { recursive: true })
  writeFileSync(join(spPath, 'skills', 'handoff', 'SKILL.md'), '# h\n')
  const ghostPath = join(base, 'cache', 'ghostplug')
  mkdirSync(join(ghostPath, 'skills', 'ghost-skill'), { recursive: true })
  writeFileSync(join(ghostPath, 'skills', 'ghost-skill', 'SKILL.md'), '# x\n')
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@claude-plugins-official': [{ scope: 'user', installPath: spPath, version: '6.1.1' }],
        'ghostplug@somewhere': [{ scope: 'user', installPath: ghostPath, version: '1.0.0' }],
      },
    }),
  )
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true, 'ghostplug@somewhere': false } }),
  )

  // Codex-first readiness 只把 Codex cache 视为 plugin 可用；Claude cache 仍单独保留兼容探测。
  mkdirSync(join(base, 'home', '.codex', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '6.1.1'), { recursive: true })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skreg-t6-'))
  repoRoot = join(base, 'repo')
  claudeDir = join(base, 'home', '.claude')
  mkdirSync(repoRoot, { recursive: true })
  mkdirSync(claudeDir, { recursive: true })
  seedRepoSync()
  seedClaudeDir()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('detectInstalled —— 三源探测', () => {
  it('源①:~/.claude/skills 目录含 SKILL.md 即已装,symlink 跟随', () => {
    const d = detectInstalled(claudeDir)
    expect(d.skills.has('grill-with-docs')).toBe(true)
    expect(d.skills.has('linked-skill')).toBe(true)
  })

  it('源②:已装且启用的插件 installPath 下技能计入;enabledPlugins=false 的插件整体排除', () => {
    const d = detectInstalled(claudeDir)
    expect(d.skills.has('handoff')).toBe(true)
    expect(d.skills.has('ghost-skill')).toBe(false)
    expect(d.pluginBases.has('superpowers')).toBe(true)
    expect(d.pluginBases.has('ghostplug')).toBe(false)
  })

  it('claudeDir 不存在时 fail-open 返回空集,不抛错', () => {
    const d = detectInstalled(join(base, 'no-such-dir'))
    expect(d.skills.size).toBe(0)
    expect(d.pluginBases.size).toBe(0)
  })

  it('Codex-first：同时扫描同一 home 下 ~/.agents/skills，不把 npx skills -g 的真实安装漏报', () => {
    const agentsSkill = join(base, 'home', '.agents', 'skills', 'browser-qa')
    mkdirSync(agentsSkill, { recursive: true })
    writeFileSync(join(agentsSkill, 'SKILL.md'), '# browser qa\n')

    const d = detectInstalled(claudeDir)
    expect(d.skills.has('browser-qa')).toBe(true)
  })
})

describe('listAllSkillsDetailed —— SkillEntry 明细', () => {
  it('本仓 skills/ 目录 → local-plugin 且随当前 pluginRoot 直接可用，不要求重复安装', () => {
    writeFileSync(join(repoRoot, 'skills', 'tenon-open', 'SKILL.md'), [
      '---',
      'name: tenon-open',
      'description: Open a pipeline change and prepare its execution context.',
      '---',
      '',
      '# Pipeline Open',
    ].join('\n'))
    const entries = listAllSkillsDetailed(repoRoot, claudeDir)
    const e = entries.find((x) => x.name === 'tenon-open')!
    expect(e.source).toBe('local-plugin')
    expect(e.installed).toBe(true)
    expect(e.description).toBe('Open a pipeline change and prepare its execution context.')
    expect(e.installCmd).toBeUndefined()
  })

  it('上游技能目录在 payload skills/ 下 → local-plugin 且已装', () => {
    mkdirSync(join(repoRoot, 'skills', 'hue'), { recursive: true })
    writeFileSync(join(repoRoot, 'skills', 'hue', 'SKILL.md'), '---\nname: hue\n---\n# hue\n')

    const entry = listAllSkillsDetailed(repoRoot, claudeDir).find((item) => item.name === 'hue')!
    expect(entry).toMatchObject({ source: 'local-plugin', installed: true })
    expect(entry.installCmd).toBeUndefined()
  })

  it('按 name 排序且去重;claudeDir 缺失时本仓目录可用，其余探测项 fail-open 为未装', () => {
    const entries = listAllSkillsDetailed(repoRoot, join(base, 'no-such-dir'))
    const names = entries.map((x) => x.name)
    expect(names).toEqual([...new Set(names)].sort())
    for (const e of entries) {
      expect(e.installed).toBe(e.source === 'local-plugin')
    }
  })

  it('listAllSkills 保持薄封装兼容:返回与明细同集合的纯名字排序数组', () => {
    const names = listAllSkills(repoRoot)
    const detailed = listAllSkillsDetailed(repoRoot, claudeDir).map((x) => x.name)
    expect(names).toEqual(detailed)
  })

  it('Codex-first registry：真实安装 id 改名、bundled、tier 与 unavailable 都来自唯一 skill-sources.yaml', () => {
    mkdirSync(join(repoRoot, 'templates'), { recursive: true })
    writeFileSync(join(repoRoot, 'templates', 'skill-sources.yaml'), [
      'version: 1',
      'skills:',
      '  browser-qa: { tool: skills-cli, source: affaan-m/ECC, skill: browser-qa, tier: mandatory, official: false }',
      '  taste-skill: { tool: skills-cli, source: Leonxlnx/taste-skill, skill: design-taste-frontend, tier: mandatory, official: false }',
      '  tenon-open: { tool: bundled, source: tenon, tier: mandatory, official: false }',
      '  zoom-out: { tool: skills-cli, source: mattpocock/skills, skill: zoom-out, unavailable: true, tier: optional, official: false }',
      '',
    ].join('\n'))
    for (const name of ['browser-qa', 'design-taste-frontend']) {
      const dir = join(base, 'home', '.agents', 'skills', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`)
    }

    const entries = listAllSkillsDetailed(repoRoot, claudeDir)
    expect(entries.find((x) => x.name === 'browser-qa')).toMatchObject({ installed: true, tier: 'mandatory', available: true })
    expect(entries.find((x) => x.name === 'taste-skill')).toMatchObject({ installed: true, tier: 'mandatory', available: true })
    expect(entries.find((x) => x.name === 'tenon-open')).toMatchObject({ installed: true, tier: 'mandatory', available: true })
    expect(entries.find((x) => x.name === 'zoom-out')).toMatchObject({ installed: false, tier: 'optional', available: false })
  })

  it('plugin 类以 Codex cache 为 readiness 真相：Claude-only 不算就绪，Codex cache 命中才算', () => {
    mkdirSync(join(repoRoot, 'templates'), { recursive: true })
    writeFileSync(join(repoRoot, 'templates', 'skill-sources.yaml'), [
      'version: 1',
      'skills:',
      '  shadcn-ui: { tool: claude-plugin, source: agents-inc, skill: web-ui-shadcn-ui, tier: recommended, official: false }',
      '  tailwind-css-patterns: { tool: claude-plugin, source: agents-inc, skill: web-styling-tailwind, tier: recommended, official: false }',
      '',
    ].join('\n'))
    mkdirSync(join(claudeDir, 'plugins', 'cache', 'agents-inc', 'web-ui-shadcn-ui'), { recursive: true })
    mkdirSync(join(base, 'home', '.codex', 'plugins', 'cache', 'agents-inc', 'web-styling-tailwind', '5.0.0'), { recursive: true })

    const entries = listAllSkillsDetailed(repoRoot, claudeDir)

    expect(entries.find((x) => x.name === 'shadcn-ui')).toMatchObject({ installed: false, tier: 'recommended' })
    expect(entries.find((x) => x.name === 'tailwind-css-patterns')).toMatchObject({ installed: true, tier: 'recommended' })
  })
})
