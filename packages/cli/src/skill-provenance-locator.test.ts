import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalManifest, SkillContentInvalidError } from '@tenon/automation'
import {
  createProvenanceAwareBundledLocator,
  SkillProvenanceLocatorError,
} from './skill-provenance-locator.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<{ root: string; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'provenance-locator-'))
  roots.push(root)
  const skill = join(root, 'skills', 'demo')
  await mkdir(skill, { recursive: true })
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '# demo\n', 'utf8')
  const manifest = await buildCanonicalManifest('demo', skill)
  const digest = `sha256:${manifest.treeSha256}`
  await writeFile(join(root, 'templates', 'skill-sources.yaml'), [
    'version: 3',
    'hash_algorithm: tree-sha256-v1',
    'skills:',
    `  logical: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/demo, content_hash: ${digest}, coordinate: tenon:skills/demo@${digest} }`,
    '',
  ].join('\n'), 'utf8')
  return { root, digest }
}

async function addUpstreamSkill(root: string): Promise<string> {
  const dir = join(root, 'skills', 'hue')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: hue\n---\n# hue\n', 'utf8')
  const tree = `sha256:${(await buildCanonicalManifest('hue', dir)).treeSha256}`
  await writeFile(join(root, 'skills', 'sources.yaml'), [
    'version: 1',
    'skills:',
    '  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'skills', 'skills.lock.json'), `${JSON.stringify({
    version: 2,
    updated_at: '2026-09-15T08:00:00.000Z',
    skills: [{
      id: 'hue', repo: 'dominikmartn/hue', path: '.', commit: '1'.repeat(40), tree_sha256: tree,
      license: 'MIT', fetched_at: '2026-09-15T08:00:00.000Z', previous_commit: null,
      model_invocable: true,
    }],
  }, null, 2)}\n`, 'utf8')
  return dir
}

describe('createProvenanceAwareBundledLocator with upstream skills', () => {
  it('locates a locked upstream skill after checking its tree hash', async () => {
    const { root } = await makeRoot()
    await addUpstreamSkill(root)
    const result = await createProvenanceAwareBundledLocator(root).locate('hue')
    expect(result.skillId).toBe('hue')
    expect(result.contentDir).toContain(join('skills', 'hue'))
  })

  it('rejects a tampered upstream skill', async () => {
    const { root } = await makeRoot()
    const dir = await addUpstreamSkill(root)
    await writeFile(join(dir, 'SKILL.md'), '---\nname: hue\n---\n# tampered\n', 'utf8')
    await expect(createProvenanceAwareBundledLocator(root).locate('hue')).rejects.toMatchObject({
      category: 'content-hash-mismatch',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })

  it('rejects an invalid lock without falling back to a lower tier', async () => {
    const { root } = await makeRoot()
    await addUpstreamSkill(root)
    await writeFile(join(root, 'skills', 'skills.lock.json'), '{', 'utf8')
    await expect(createProvenanceAwareBundledLocator(root).locate('hue')).rejects.toMatchObject({
      category: 'invalid-skill-lock',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })
})

describe('createProvenanceAwareBundledLocator', () => {
  it('returns only hash-verified bundled content and preserves logical token', async () => {
    const { root } = await makeRoot()
    const result = await createProvenanceAwareBundledLocator(root).locate('logical')
    expect(result.skillId).toBe('logical')
    expect(result.contentDir).toContain(join('skills', 'demo'))
  })

  it('rejects drift instead of falling back to a lower tier', async () => {
    const { root } = await makeRoot()
    await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# drift\n', 'utf8')
    await expect(createProvenanceAwareBundledLocator(root).locate('logical')).rejects.toMatchObject({
      category: 'content-hash-mismatch',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })

  it('rejects an existing undeclared bundled tree', async () => {
    const { root } = await makeRoot()
    await mkdir(join(root, 'skills', 'extra'), { recursive: true })
    await writeFile(join(root, 'skills', 'extra', 'SKILL.md'), '# extra\n', 'utf8')
    await expect(createProvenanceAwareBundledLocator(root).locate('extra')).rejects.toMatchObject({
      category: 'unregistered-distributed-skill',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })

  it('rejects a declared bundled root that is missing instead of allowing lower-tier fallback', async () => {
    const { root } = await makeRoot()
    await rm(join(root, 'skills', 'demo'), { recursive: true, force: true })
    await expect(createProvenanceAwareBundledLocator(root).locate('logical')).rejects.toMatchObject({
      category: 'missing-distributed-skill',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })

  it('rejects a top-level bundled symlink that escapes skillsRoot', async () => {
    const { root } = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'provenance-locator-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'SKILL.md'), '# demo\n', 'utf8')
    await rm(join(root, 'skills', 'demo'), { recursive: true, force: true })
    await symlink(outside, join(root, 'skills', 'demo'))
    await expect(createProvenanceAwareBundledLocator(root).locate('logical')).rejects.toMatchObject({
      category: 'filesystem-safety-error',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })

  it('rejects a skillsRoot symlink before resolving a declared child', async () => {
    const { root } = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'provenance-locator-root-outside-'))
    roots.push(outside)
    await mkdir(join(outside, 'demo'), { recursive: true })
    await writeFile(join(outside, 'demo', 'SKILL.md'), '# demo\n', 'utf8')
    await rm(join(root, 'skills'), { recursive: true, force: true })
    await symlink(outside, join(root, 'skills'))

    await expect(createProvenanceAwareBundledLocator(root).locate('logical')).rejects.toMatchObject({
      category: 'filesystem-safety-error',
    } satisfies Partial<SkillProvenanceLocatorError>)
  })

  it('validates unsafe skill ids before any bundled filesystem lookup', async () => {
    const { root } = await makeRoot()
    await expect(createProvenanceAwareBundledLocator(root).locate('../package.json')).rejects.toBeInstanceOf(SkillContentInvalidError)
  })

  it('does not cache a failed registry load; the same locator recovers after repair', async () => {
    const { root } = await makeRoot()
    const registryPath = join(root, 'templates', 'skill-sources.yaml')
    const clean = await readFile(registryPath, 'utf8')
    await writeFile(registryPath, 'version: 3\n', 'utf8')
    const locator = createProvenanceAwareBundledLocator(root)
    await expect(locator.locate('logical')).rejects.toMatchObject({ category: 'unsupported-registry-version' })
    await writeFile(registryPath, clean, 'utf8')
    await expect(locator.locate('logical')).resolves.toMatchObject({ skillId: 'logical' })
  })
})
