/**
 * skillSources.test —— registry 载入器（批 2 Wave A · S1）。
 * 真 fs：解析 inline fixture + 真读 templates/skill-sources.yaml / manifest.yaml（只读，不碰全局）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadCanonicalSkillSources, loadSkillSources, parseSkillSources, readSkillSources, SkillSourcesError } from './skillSources.js'

// src 与 dist 同深度：三级上溯 → 仓根（对齐 loader / cli main.ts pluginRoot）
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REGISTRY = join(REPO_ROOT, 'templates', 'skill-sources.yaml')
const MANIFEST = join(REPO_ROOT, 'templates', 'manifest.yaml')

const GOOD_FIXTURE = `
version: 1
skills:
  # 注释行应被跳过
  browser-qa: { tool: skills-cli, source: affaan-m/ECC, skill: browser-qa, tier: mandatory, official: false, engine: "playwright@claude-plugins-official" }
  huashu-design: { tool: skills-cli, source: alchaincyf/huashu-design, tier: mandatory, official: false, alt: prototype }
  web-artifacts-builder: { tool: skills-cli, source: anthropics/skills, skill: web-artifacts-builder, tier: optional, official: true }
  opsx: { tool: npm, source: "@fission-ai/openspec", bin: openspec, tier: mandatory, official: false }
  verify: { tool: builtin, source: claude-code, content_skill: verification-before-completion, tier: mandatory, official: true }
  zoom-out: { tool: skills-cli, source: mattpocock/skills, skill: zoom-out, unavailable: true, tier: optional, official: false }
  commit-commands:commit-push-pr: { tool: claude-plugin, source: claude-plugins-official, skill: commit-commands, tier: mandatory, official: true, note: "命令非技能，冒号 token 与含逗号 note 都要解析对" }
`

describe('① parseSkillSources —— 结构化字段', () => {
  const by = new Map(parseSkillSources(GOOD_FIXTURE).map((r) => [r.token, r]))

  it('tool/source/skill/tier/official/engine 逐字段', () => {
    const bq = by.get('browser-qa')!
    expect(bq).toMatchObject({
      token: 'browser-qa', tool: 'skills-cli', source: 'affaan-m/ECC',
      skill: 'browser-qa', tier: 'mandatory', official: false,
      engine: 'playwright@claude-plugins-official',
    })
  })

  it('单技能仓省略 skill → undefined；alt 保留', () => {
    const hs = by.get('huashu-design')!
    expect(hs.skill).toBeUndefined()
    expect(hs.alt).toBe('prototype')
  })

  it('official: true 布尔化（非字符串）', () => {
    expect(by.get('web-artifacts-builder')!.official).toBe(true)
  })

  it('npm bin 与上游 unavailable 状态结构化保留', () => {
    expect(by.get('opsx')).toMatchObject({ bin: 'openspec' })
    expect(by.get('verify')).toMatchObject({ contentSkill: 'verification-before-completion' })
    expect(by.get('zoom-out')).toMatchObject({ unavailable: true })
  })

  it('含冒号 token 正确切分 + 含逗号引号 note 完整保留', () => {
    const cc = by.get('commit-commands:commit-push-pr')!
    expect(cc.token).toBe('commit-commands:commit-push-pr')
    expect(cc.skill).toBe('commit-commands')
    expect(cc.note).toBe('命令非技能，冒号 token 与含逗号 note 都要解析对')
  })
})

describe('② / ③ readSkillSources —— 容错兜底（fail-open）', () => {
  it('② 缺文件 → []', () => {
    expect(readSkillSources(join(tmpdir(), 'no-such-skill-sources-xyz.yaml'))).toEqual([])
  })

  it('③ 坏 yaml → []（不抛）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skillsrc-'))
    try {
      const bad = join(dir, 'bad.yaml')
      await writeFile(bad, 'skills:\n  broken: { tool: not-a-real-tool, source: x, tier: mandatory, official: false }\n', 'utf8')
      expect(readSkillSources(bad)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('③b parseSkillSources 对坏内容 fail-loud（SkillSourcesError，消息带 token）', () => {
    expect(() => parseSkillSources('skills:\n  broken: { tool: not-a-real-tool, source: x, tier: mandatory, official: false }\n'))
      .toThrow(SkillSourcesError)
    expect(() => parseSkillSources('skills:\n  nobrace: tool skills-cli\n')).toThrow(/token/)
    expect(() => parseSkillSources('skills:\n  dup: { tool: npm, source: a, tier: optional, official: false }\n  dup: { tool: npm, source: b, tier: optional, official: false }\n'))
      .toThrow(/重复/)
  })
})

describe('③c loadSkillSources —— 区分 读失败/解析失败 与 合法空 registry（fail-loud，供 setup 装机）', () => {
  it('缺文件 → { ok:false }（读失败，不当空 registry）', () => {
    const r = loadSkillSources(join(tmpdir(), 'no-such-skill-sources-zzz.yaml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('读取 registry 失败')
  })

  it('坏 yaml → { ok:false }（解析失败，携 token 原因，不当空 registry）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skillsrc-'))
    try {
      const bad = join(dir, 'bad.yaml')
      await writeFile(bad, 'skills:\n  broken: { tool: not-a-real-tool, source: x, tier: mandatory, official: false }\n', 'utf8')
      const r = loadSkillSources(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('broken')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('合法但无条目 → { ok:true, sources:[] }（真空 registry，与失败区分）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skillsrc-'))
    try {
      const empty = join(dir, 'empty.yaml')
      await writeFile(empty, 'version: 1\nskills:\n', 'utf8')
      const r = loadSkillSources(empty)
      expect(r).toEqual({ ok: true, sources: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('真 registry → { ok:true } 且条目数 > 30', () => {
    const r = loadSkillSources(REGISTRY)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sources.length).toBeGreaterThan(0)
  })
})

describe('④ 真读 templates/skill-sources.yaml', () => {
  const rows = readSkillSources(REGISTRY)
  const by = new Map(rows.map((r) => [r.token, r]))

  it('④a registry 只登记本插件 bundled Tenon 技能，不请求第三方 marketplace/npm（第三方技能见 skills/sources.yaml）', () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const entry of rows) {
      expect(entry.tool, `${entry.token} tool`).toBe('bundled')
      expect(entry.source, `${entry.token} source`).toBe('tenon')
      const physical = entry.contentSkill ?? entry.token
      expect(existsSync(join(REPO_ROOT, 'skills', physical, 'SKILL.md')), `${entry.token} physical skill`).toBe(true)
    }
  })

  it('④b2 tenon 是新用户安装清单中唯一的 mandatory 包内能力', () => {
    expect(by.get('tenon')).toMatchObject({
      tool: 'bundled',
      source: 'tenon',
      contentSkill: 'tenon',
      tier: 'mandatory',
    })
    expect(rows.map((row) => row.token)).toEqual(['tenon'])
    expect(existsSync(join(REPO_ROOT, 'skills', 'tenon', 'SKILL.md'))).toBe(true)
  })

  it('④b3 Tenon 根 Skill 固定 custom exec 完整结果转发契约', () => {
    const tenonSkill = readFileSync(join(REPO_ROOT, 'skills', 'tenon', 'SKILL.md'), 'utf8')
    expect(tenonSkill).toContain('text(result);')
    expect(tenonSkill).toContain('不要用 `text(result.output)`')
    expect(tenonSkill).toContain('`exit_code` 可审计')
  })

  it('④d uiforge 不进 registry（无 uiforge 条目；头注可保留“已删”说明）', () => {
    expect(by.get('uiforge')).toBeUndefined()
    // 无 `uiforge: {…}` 条目行（`#` 说明注释不受影响）
    expect(readFileSync(REGISTRY, 'utf8')).not.toMatch(/^\s*uiforge\s*:/m)
  })

  it('④e 全表字段完整、tier/official 合法，且无外部安装工具', () => {
    for (const r of rows) {
      expect(['mandatory', 'recommended', 'conditional', 'optional'], `${r.token} tier`).toContain(r.tier)
      expect(typeof r.official, `${r.token} official`).toBe('boolean')
      expect(r.tool, `${r.token} tool`).toBe('bundled')
      expect(r.source, `${r.token} source`).toBe('tenon')
    }
  })
})

describe('⑥ canonical provenance loader', () => {
  it('does not turn a malformed v3 registry into an empty successful list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skillsrc-canonical-'))
    try {
      const path = join(dir, 'skill-sources.yaml')
      await writeFile(path, 'version: 2\nskills:\n', 'utf8')
      const result = loadCanonicalSkillSources(path)
      expect(result.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('⑤ manifest 改名落地（templates/manifest.yaml）', () => {
  const manifest = readFileSync(MANIFEST, 'utf8')

  it('技能表无 to-prd / to-issues / uiforge', () => {
    expect(manifest).not.toContain('to-prd')
    expect(manifest).not.toContain('to-issues')
    expect(manifest).not.toContain('uiforge')
  })

  // to-spec / to-tickets 都带 disable-model-invocation（宿主拒绝代模型调用），强制表里不能有它们。
  // ship.pm 的把关改由工作流数据承担：applied-spec 文档槽 + spec-migration-applied guard。
  it('ship.pm 不声明任何强制技能；durable spec 由 applied-spec 文档与 spec-migration-applied guard 把关', () => {
    expect(manifest).toMatch(/ship\.pm:\s*\[\]/)
    expect(manifest).not.toMatch(/^\s*[a-z]+\.[a-z_]+:.*\bto-spec\b/mu)
    expect(manifest).not.toMatch(/^\s*[a-z]+\.[a-z_]+:.*\bto-tickets\b/mu)
  })
})
