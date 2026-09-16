import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalManifest } from '@tenon/automation'
import { makeDeps } from '../test-support.js'
import { cmdInternalSkillProvenance, syncSkillProvenanceRegistry } from './internal-skill-provenance.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cli-skill-provenance-'))
  roots.push(root)
  await mkdir(join(root, 'skills', 'demo'), { recursive: true })
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
  await writeFile(join(root, 'templates', 'skill-sources.yaml'), [
    'version: 2',
    'skills:',
    '  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true }',
    '',
  ].join('\n'), 'utf8')
  return root
}

describe('cmdInternalSkillProvenance', () => {
  it('syncs a root with upstream directories and a lock into bundled entries only', async () => {
    const root = await makeRoot()
    const hue = join(root, 'skills', 'hue')
    await mkdir(hue, { recursive: true })
    await writeFile(join(hue, 'SKILL.md'), '---\nname: hue\n---\n# hue\n', 'utf8')
    const tree = `sha256:${(await buildCanonicalManifest('hue', hue)).treeSha256}`
    await writeFile(join(root, 'skills', 'sources.yaml'), [
      'version: 1',
      'skills:',
      '  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }',
      '  brainstorming: { repo: obra/superpowers, path: skills/brainstorming, ref: default-branch, license_expected: MIT }',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'skills', 'skills.lock.json'), `${JSON.stringify({
      version: 1,
      updated_at: '2026-09-15T08:00:00.000Z',
      skills: [{
        id: 'hue', repo: 'dominikmartn/hue', path: '.', commit: 'a'.repeat(40), tree_sha256: tree,
        license: 'MIT', fetched_at: '2026-09-15T08:00:00.000Z', previous_commit: null,
      }],
    }, null, 2)}\n`, 'utf8')
    const deps = makeDeps()

    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(0)
    const registry = await readFile(join(root, 'templates', 'skill-sources.yaml'), 'utf8')
    expect(registry).toContain('  demo: {')
    expect(registry).not.toContain('hue')
    expect(await cmdInternalSkillProvenance(deps, 'verify', { root, quiet: true })).toBe(0)
  })

  it('syncs atomically then verifies clean root', async () => {
    const root = await makeRoot()
    const deps = makeDeps()
    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(0)
    expect(deps.outLines).toEqual([])
    const quietJsonDeps = makeDeps()
    expect(await cmdInternalSkillProvenance(quietJsonDeps, 'sync', { root, json: true, quiet: true })).toBe(0)
    expect(quietJsonDeps.outLines).toEqual([])
    const registry = await readFile(join(root, 'templates', 'skill-sources.yaml'), 'utf8')
    expect(registry).toContain('version: 3')
    expect(registry).toContain('content_hash: sha256:')
    expect(await cmdInternalSkillProvenance(deps, 'verify', { root, quiet: true })).toBe(0)
  })

  it('returns non-zero and actionable category on drift', async () => {
    const root = await makeRoot()
    const deps = makeDeps()
    await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })
    await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# drift\n', 'utf8')
    expect(await cmdInternalSkillProvenance(deps, 'verify', { root })).toBe(1)
    expect(deps.errLines.join('\n')).toContain('content-hash-mismatch')
  })

  it('rejects a registry path that escapes the explicit root through a symlink', async () => {
    const root = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'cli-skill-provenance-outside-'))
    roots.push(outside)
    const registry = await readFile(join(root, 'templates', 'skill-sources.yaml'), 'utf8')
    await rm(join(root, 'templates'), { recursive: true, force: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'skill-sources.yaml'), registry, 'utf8')
    await symlink(outside, join(root, 'templates'))

    const deps = makeDeps()
    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(1)
    expect(deps.errLines.join('\n')).toMatch(/root|symlink|registry/i)
  })

  it.each([
    ['trailing token', '  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true } trailing'],
    ['duplicate version', 'version: 2\nversion: 2\nskills:\n  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true }'],
  ])('rejects strict sync input with %s', async (_label, source) => {
    const root = await makeRoot()
    const path = join(root, 'templates', 'skill-sources.yaml')
    const before = await readFile(path, 'utf8')
    await writeFile(path, source, 'utf8')
    const deps = makeDeps()
    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(source)
    expect(deps.errLines.join('\n')).toMatch(/strict|trailing|duplicate|字段|registry/i)
    expect(before).not.toBe(source)
  })

  it.each([
    ['unsupported legacy version', 'version: 4\nskills:\n  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true }'],
    ['non-numeric version', 'version: nope\nskills:\n  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true }'],
    ['missing version', 'skills:\n  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true }'],
    ['unknown flow field', 'version: 2\nskills:\n  demo: { tool: bundled, source: tenon, content_skil: demo, tier: mandatory, official: true }'],
  ])('rejects strict legacy sync input with %s and preserves bytes/mode', async (_label, source) => {
    const root = await makeRoot()
    const path = join(root, 'templates', 'skill-sources.yaml')
    await writeFile(path, source, 'utf8')
    await chmod(path, 0o600)
    const beforeMode = (await stat(path)).mode & 0o777
    const deps = makeDeps()

    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(source)
    expect((await stat(path)).mode & 0o777).toBe(beforeMode)
    expect(deps.errLines.join('\n')).toMatch(/version|strict|unknown|字段|registry/i)
  })

  it('does not partially rewrite the registry when a later Skill cannot be hashed', async () => {
    const root = await makeRoot()
    const path = join(root, 'templates', 'skill-sources.yaml')
    const before = await readFile(path, 'utf8')
    const broken = `${before}  missing: { tool: bundled, source: tenon, tier: mandatory, official: true }\n`
    await writeFile(path, broken, 'utf8')
    await chmod(path, 0o600)
    const beforeMode = (await stat(path)).mode & 0o777

    const deps = makeDeps()
    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(broken)
    expect((await stat(path)).mode & 0o777).toBe(beforeMode)
  })

  it('rejects extra physical bundled roots before replacing the registry', async () => {
    const root = await makeRoot()
    const path = join(root, 'templates', 'skill-sources.yaml')
    const before = await readFile(path, 'utf8')
    await mkdir(join(root, 'skills', 'extra'), { recursive: true })
    await writeFile(join(root, 'skills', 'extra', 'SKILL.md'), '# extra\n', 'utf8')

    const deps = makeDeps()
    expect(await cmdInternalSkillProvenance(deps, 'sync', { root, quiet: true })).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(deps.errLines.join('\n')).toMatch(/extra|unregistered/i)
  })

  it('rejects a deterministic canonical parent swap between hashing and temp creation', async () => {
    const root = await makeRoot()
    const path = join(root, 'templates', 'skill-sources.yaml')
    const before = await readFile(path, 'utf8')
    const beforeMode = (await stat(path)).mode & 0o777
    let swapped = false
    await expect(syncSkillProvenanceRegistry(root, {
      beforeTempCreate: async () => {
        if (swapped) return
        swapped = true
        const original = join(root, 'templates')
        const replacement = join(root, 'templates-replacement')
        await rename(original, replacement)
        await mkdir(original)
        await writeFile(join(original, 'skill-sources.yaml'), before, 'utf8')
      },
    })).rejects.toThrow(/TOCTOU|替换|canonical registry parent/i)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await stat(path)).mode & 0o777).toBe(beforeMode)
  })

  it('rejects a deterministic canonical parent swap immediately before rename', async () => {
    const root = await makeRoot()
    const path = join(root, 'templates', 'skill-sources.yaml')
    const before = await readFile(path, 'utf8')
    await chmod(path, 0o600)
    const beforeMode = (await stat(path)).mode & 0o777
    let swapped = false

    await expect(syncSkillProvenanceRegistry(root, {
      beforeRename: async () => {
        if (swapped) return
        swapped = true
        const original = join(root, 'templates')
        const replacement = join(root, 'templates-replacement-before-rename')
        await rename(original, replacement)
        await mkdir(original)
        await writeFile(join(original, 'skill-sources.yaml'), before, 'utf8')
        await chmod(join(original, 'skill-sources.yaml'), beforeMode)
      },
    })).rejects.toThrow(/TOCTOU|替换|canonical registry parent/i)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await stat(path)).mode & 0o777).toBe(beforeMode)
  })
})
