import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCanonicalManifest } from '@tenon/automation'
import { parseUpstreamSkillLock, UpstreamSkillError, type UpstreamSkillLock } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { installUpstreamSkills, type UpstreamSkillInstallInput } from './install.js'
import { createFixtureHub, snapshotTree, type FixtureHub } from './test-support.js'

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n'
const DIGEST = `sha256:${'a'.repeat(64)}`
const REGISTRY = [
  'version: 3',
  'hash_algorithm: tree-sha256-v1',
  'skills:',
  `  tenon: { tool: bundled, source: tenon, content_skill: tenon, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/tenon, content_hash: ${DIGEST}, coordinate: tenon:skills/tenon@${DIGEST} }`,
  '',
].join('\n')
const ALPHA = '  alpha: { repo: owner-a/skills, path: skills/alpha, ref: default-branch, license_expected: MIT }'
const BETA = '  beta: { repo: owner-a/skills, path: skills/beta, ref: default-branch, license_expected: MIT }'
const SOLO = '  solo: { repo: owner-b/solo, path: ., ref: default-branch, license_expected: MIT }'

const hubs: FixtureHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.cleanup()
})

let tick = 0
const clock = (): string => new Date(Date.UTC(2026, 8, 15, 8, 0, tick++)).toISOString()
const skillMd = (name: string, body = 'body'): string => `---\nname: ${name}\ndescription: fixture\n---\n# ${name}\n${body}\n`

function seededHub(): { hub: FixtureHub; alphaCommit: string; soloCommit: string } {
  const hub = createFixtureHub()
  hubs.push(hub)
  const alphaCommit = hub.commit('owner-a/skills', {
    'skills/alpha/SKILL.md': skillMd('alpha'),
    'skills/alpha/scripts/run.sh': { text: '#!/bin/sh\necho alpha\n', executable: true },
    'skills/beta/SKILL.md': skillMd('beta'),
    'other/notes.md': 'notes\n',
    LICENSE: MIT,
  })
  const soloCommit = hub.commit('owner-b/solo', {
    'SKILL.md': skillMd('solo'),
    'references/guide.md': 'guide\n',
    '.github/workflows/ci.yml': 'on: push\n',
    LICENSE: MIT,
  })
  return { hub, alphaCommit, soloCommit }
}

function pluginRoot(hub: FixtureHub, name: string, lines: readonly string[] | null): string {
  const root = join(hub.root, name)
  mkdirSync(join(root, 'skills', 'tenon'), { recursive: true })
  writeFileSync(join(root, 'skills', 'tenon', 'SKILL.md'), skillMd('tenon'), 'utf8')
  mkdirSync(join(root, 'templates'), { recursive: true })
  writeFileSync(join(root, 'templates', 'skill-sources.yaml'), REGISTRY, 'utf8')
  if (lines !== null) writeFileSync(join(root, 'skills', 'sources.yaml'), ['version: 1', 'skills:', ...lines, ''].join('\n'), 'utf8')
  return root
}

function install(hub: FixtureHub, plugin: string, overrides: Partial<UpstreamSkillInstallInput> = {}): ReturnType<typeof installUpstreamSkills> {
  return installUpstreamSkills({
    env: hub.env, pluginRoot: plugin, previousRoot: plugin, host: 'codex', workRoot: join(hub.root, 'work'),
    now: clock, log: () => undefined, ...overrides,
  })
}

function readLock(plugin: string): UpstreamSkillLock {
  return parseUpstreamSkillLock(readFileSync(join(plugin, 'skills', 'skills.lock.json'), 'utf8'))
}

function filesOf(dir: string, skipTop: readonly string[] = []): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshotTree(dir))
    .filter(([path]) => !path.endsWith('/') && !skipTop.some((top) => path === top || path.startsWith(`${top}/`))))
}

describe('installUpstreamSkills', () => {
  it('(1) installs full upstream content with a lock and the root license copied into the skill', async () => {
    const { hub, alphaCommit, soloCommit } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA, BETA, SOLO])
    const result = await install(hub, plugin, { previousRoot: null })

    expect(result.lockWritten).toBe(true)
    expect(result.report.results).toEqual([
      { id: 'alpha', outcome: 'updated' }, { id: 'beta', outcome: 'updated' }, { id: 'solo', outcome: 'updated' },
    ])
    const upstreamAlpha = join(hub.hub, 'owner-a/skills.git', 'skills', 'alpha')
    expect(filesOf(join(plugin, 'skills', 'alpha'))).toEqual({ ...filesOf(upstreamAlpha), LICENSE: `644:${MIT}` })
    expect(filesOf(join(plugin, 'skills', 'alpha'))['scripts/run.sh']).toMatch(/^755:/)
    expect(filesOf(join(plugin, 'skills', 'solo'))).toEqual(filesOf(join(hub.hub, 'owner-b/solo.git'), ['.git', '.github']))

    const lock = readLock(plugin)
    const alpha = lock.skills.find((entry) => entry.id === 'alpha')
    expect(alpha?.commit).toBe(alphaCommit)
    expect(lock.skills.find((entry) => entry.id === 'solo')?.commit).toBe(soloCommit)
    expect(alpha?.treeSha256).toBe(`sha256:${(await buildCanonicalManifest('alpha', join(plugin, 'skills', 'alpha'))).treeSha256}`)
    expect(lock.skills.every((entry) => entry.previousCommit === null && entry.fetchedAt === lock.updatedAt)).toBe(true)
    expect(readdirSync(plugin).some((name) => name.startsWith('.tenon-skills-staging-'))).toBe(false)
    expect(existsSync(join(plugin, 'skills', 'tenon', 'SKILL.md'))).toBe(true)
  })

  it('(2) keeps lock bytes and mtime and makes no clone call when nothing changed', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA, BETA, SOLO])
    await install(hub, plugin, { previousRoot: null })
    const lockPath = join(plugin, 'skills', 'skills.lock.json')
    const bytes = readFileSync(lockPath, 'utf8')
    const mtime = statSync(lockPath).mtimeMs
    hub.calls.length = 0

    const second = await install(hub, plugin)
    expect(second.lockWritten).toBe(false)
    expect(second.report.results.map((result) => result.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes)
    expect(statSync(lockPath).mtimeMs).toBe(mtime)
    expect(hub.calls.some((args) => args[0] === 'clone')).toBe(false)
  })

  it('(2b) reuses a verified previous release into a fresh host root without cloning', async () => {
    const { hub } = seededHub()
    const previous = pluginRoot(hub, 'previous', [ALPHA, BETA, SOLO])
    await install(hub, previous, { previousRoot: null })
    const fresh = pluginRoot(hub, 'fresh', [ALPHA, BETA, SOLO])
    hub.calls.length = 0

    const result = await install(hub, fresh, { previousRoot: previous })
    expect(result.report.results.every((item) => item.outcome === 'unchanged')).toBe(true)
    expect(hub.calls.some((args) => args[0] === 'clone')).toBe(false)
    expect(readFileSync(join(fresh, 'skills', 'skills.lock.json'), 'utf8')).toBe(readFileSync(join(previous, 'skills', 'skills.lock.json'), 'utf8'))
    expect(snapshotTree(join(fresh, 'skills', 'solo'))).toEqual(snapshotTree(join(previous, 'skills', 'solo')))
  })

  it('(3) updates only the skill touched by a new commit', async () => {
    const { hub, alphaCommit } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA, BETA, SOLO])
    await install(hub, plugin, { previousRoot: null })
    const before = readLock(plugin)
    const next = hub.commit('owner-a/skills', { 'skills/alpha/SKILL.md': skillMd('alpha', 'v2') })

    const result = await install(hub, plugin)
    expect(result.report.results.map((item) => item.outcome)).toEqual(['updated', 'unchanged', 'unchanged'])
    const after = readLock(plugin)
    const alpha = after.skills.find((entry) => entry.id === 'alpha')
    expect(alpha).toMatchObject({ commit: next, previousCommit: alphaCommit, fetchedAt: after.updatedAt })
    expect(after.updatedAt).not.toBe(before.updatedAt)
    for (const id of ['beta', 'solo']) {
      expect(after.skills.find((entry) => entry.id === id)).toEqual(before.skills.find((entry) => entry.id === id))
    }
    expect(readFileSync(join(plugin, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('v2')
  })

  it('(4) keeps the old commit when a new commit touches only another path', async () => {
    const { hub, alphaCommit } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA, BETA, SOLO])
    await install(hub, plugin, { previousRoot: null })
    const bytes = readFileSync(join(plugin, 'skills', 'skills.lock.json'), 'utf8')
    hub.commit('owner-a/skills', { 'other/notes.md': 'changed\n' })

    const result = await install(hub, plugin)
    expect(result.report.results.map((item) => item.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(result.lockWritten).toBe(false)
    expect(readLock(plugin).skills.find((entry) => entry.id === 'alpha')?.commit).toBe(alphaCommit)
    expect(readFileSync(join(plugin, 'skills', 'skills.lock.json'), 'utf8')).toBe(bytes)
  })

  it('(5) keeps the previous content of an unreachable repository and still updates the others', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA, BETA, SOLO])
    await install(hub, plugin, { previousRoot: null })
    const soloBefore = snapshotTree(join(plugin, 'skills', 'solo'))
    const soloEntry = readLock(plugin).skills.find((entry) => entry.id === 'solo')
    hub.commit('owner-a/skills', { 'skills/alpha/SKILL.md': skillMd('alpha', 'v2') })
    hub.redirect('https://github.com/owner-b/', `file://${join(hub.root, 'nowhere')}/`)
    const lines: string[] = []

    const result = await install(hub, plugin, { log: (line) => lines.push(line) })
    expect(result.report.results).toEqual([
      { id: 'alpha', outcome: 'updated' },
      { id: 'beta', outcome: 'unchanged' },
      { id: 'solo', outcome: 'kept', reason: 'unreachable', detail: expect.any(String) },
    ])
    expect(snapshotTree(join(plugin, 'skills', 'solo'))).toEqual(soloBefore)
    expect(readLock(plugin).skills.find((entry) => entry.id === 'solo')).toEqual(soloEntry)
    expect(lines).toContain(`[skills] 失败 solo unreachable（保留 ${soloEntry?.commit.slice(0, 7)}）`)

    const fresh = pluginRoot(hub, 'fresh', [SOLO])
    const missing = await install(hub, fresh, { previousRoot: null })
    expect(missing.report.results).toEqual([{ id: 'solo', outcome: 'missing', reason: 'unreachable', detail: expect.any(String) }])
    expect(existsSync(join(fresh, 'skills', 'solo'))).toBe(false)
    expect(existsSync(join(fresh, 'skills', 'skills.lock.json'))).toBe(false)
  })

  it('(9) never installs a skill above the byte limit', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA])
    const result = await install(hub, plugin, { previousRoot: null, limits: { skillBytes: 10 } })
    expect(result.report.results).toEqual([
      { id: 'alpha', outcome: 'missing', reason: 'too-large', detail: expect.stringMatching(/bytes$/) },
    ])
    expect(existsSync(join(plugin, 'skills', 'alpha'))).toBe(false)
  })

  it('(6-8) never installs skills without a license, with a renamed name or a symlink', async () => {
    const { hub } = seededHub()
    hub.commit('owner-d/nolicense', { 'skills/nolic/SKILL.md': skillMd('nolic') })
    hub.commit('owner-c/mixed', {
      'skills/wrong/SKILL.md': skillMd('other'),
      'skills/linky/SKILL.md': skillMd('linky'),
      LICENSE: MIT,
    }, { 'skills/linky/shortcut.md': '../wrong/SKILL.md' })
    const plugin = pluginRoot(hub, 'plugin', [
      '  nolic: { repo: owner-d/nolicense, path: skills/nolic, ref: default-branch, license_expected: MIT }',
      '  wrong: { repo: owner-c/mixed, path: skills/wrong, ref: default-branch, license_expected: MIT }',
      '  linky: { repo: owner-c/mixed, path: skills/linky, ref: default-branch, license_expected: MIT }',
    ])

    const result = await install(hub, plugin, { previousRoot: null })
    expect(result.report.results).toEqual([
      { id: 'nolic', outcome: 'missing', reason: 'license-missing' },
      { id: 'wrong', outcome: 'missing', reason: 'renamed', detail: 'upstream name other' },
      { id: 'linky', outcome: 'missing', reason: 'invalid-content', detail: 'symlink skills/linky/shortcut.md' },
    ])
    for (const id of ['nolic', 'wrong', 'linky']) expect(existsSync(join(plugin, 'skills', id))).toBe(false)
    expect(existsSync(join(plugin, 'skills', 'skills.lock.json'))).toBe(false)
  })

  it('(10-11) removes stale skill directories and crash leftovers', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', [ALPHA])
    mkdirSync(join(plugin, 'skills', 'stale'), { recursive: true })
    writeFileSync(join(plugin, 'skills', 'stale', 'SKILL.md'), skillMd('stale'), 'utf8')
    mkdirSync(join(plugin, '.tenon-skills-staging-old', 'alpha'), { recursive: true })

    await install(hub, plugin, { previousRoot: null })
    expect(existsSync(join(plugin, 'skills', 'stale'))).toBe(false)
    expect(existsSync(join(plugin, '.tenon-skills-staging-old'))).toBe(false)
    expect(existsSync(join(plugin, 'skills', 'tenon'))).toBe(true)
    expect(existsSync(join(plugin, 'skills', 'alpha', 'SKILL.md'))).toBe(true)
  })

  it('keeps unregistered work-in-progress directories in a development checkout', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'checkout', [ALPHA])
    mkdirSync(join(plugin, 'skills', 'draft'), { recursive: true })
    await install(hub, plugin, { host: 'dev' })
    expect(existsSync(join(plugin, 'skills', 'draft'))).toBe(true)
  })

  it('(12) rejects a source id that collides with a bundled token without touching the plugin root', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', ['  tenon: { repo: owner-a/skills, path: skills/alpha, ref: default-branch, license_expected: MIT }'])
    const before = snapshotTree(plugin)
    const error = await install(hub, plugin, { previousRoot: null }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UpstreamSkillError)
    expect((error as UpstreamSkillError).category).toBe('invalid-skill-sources')
    expect(snapshotTree(plugin)).toEqual(before)
    expect(hub.calls).toEqual([])
  })

  it('(13) does nothing without skills/sources.yaml', async () => {
    const { hub } = seededHub()
    const plugin = pluginRoot(hub, 'plugin', null)
    const before = snapshotTree(plugin)
    const result = await install(hub, plugin, { previousRoot: null })
    expect(result).toEqual({ report: { version: 1, at: expect.any(String), host: 'codex', results: [] }, lockWritten: false })
    expect(snapshotTree(plugin)).toEqual(before)
    expect(hub.calls).toEqual([])
  })
})
