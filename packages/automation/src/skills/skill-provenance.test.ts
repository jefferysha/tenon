import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUpstreamSkillSources } from '@tenon/kernel'
import { buildCanonicalManifest } from './snapshot-manifest.js'
import {
  SKILL_PROVENANCE_ERROR_CATEGORIES,
  verifySkillProvenance,
  type SkillProvenanceVerificationResult,
} from './skill-provenance.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<{ root: string; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skill-provenance-'))
  roots.push(root)
  await mkdir(join(root, 'skills', 'demo'), { recursive: true })
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
  const manifest = await buildCanonicalManifest('demo', join(root, 'skills', 'demo'))
  const digest = `sha256:${manifest.treeSha256}`
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(join(root, 'templates', 'skill-sources.yaml'), [
    'version: 3',
    'hash_algorithm: tree-sha256-v1',
    'skills:',
    `  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/demo, content_hash: ${digest}, coordinate: tenon:skills/demo@${digest} }`,
    '',
  ].join('\n'), 'utf8')
  return { root, digest }
}

const SOURCES = [
  'version: 1',
  'skills:',
  '  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }',
  '',
].join('\n')

/**
 * A root whose single bundled Skill carries the upstream `disable-model-invocation: true` header
 * and is declared mandatory by a real flow manifest. Both halves are required: the flag alone is
 * legal (it only bars automatic invocation), and the manifest row alone is legal too.
 */
async function makeNonInvocableDemoRoot(): Promise<{ root: string }> {
  const { root } = await makeRoot()
  await writeFile(
    join(root, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: human-invoked only\ndisable-model-invocation: true\n---\n# demo\n',
    'utf8',
  )
  const digest = `sha256:${(await buildCanonicalManifest('demo', join(root, 'skills', 'demo'))).treeSha256}`
  await writeFile(join(root, 'templates', 'skill-sources.yaml'), [
    'version: 3',
    'hash_algorithm: tree-sha256-v1',
    'skills:',
    `  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/demo, content_hash: ${digest}, coordinate: tenon:skills/demo@${digest} }`,
    '',
  ].join('\n'), 'utf8')
  const manifest = await readFile(join(process.cwd(), 'templates', 'manifest.yaml'), 'utf8')
  const patched = manifest.replace(/^ {2}explore\.pm:.*$/mu, '  explore.pm: [demo]')
  expect(patched).toContain('  explore.pm: [demo]')
  await writeFile(join(root, 'templates', 'manifest.yaml'), patched, 'utf8')
  return { root }
}

async function addUpstream(root: string, options: { readonly dir?: boolean; readonly sources?: boolean } = {}): Promise<void> {
  const dir = join(root, 'skills', 'hue')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: hue\n---\n# hue\n', 'utf8')
  const tree = `sha256:${(await buildCanonicalManifest('hue', dir)).treeSha256}`
  if (options.dir === false) await rm(dir, { recursive: true, force: true })
  if (options.sources !== false) await writeFile(join(root, 'skills', 'sources.yaml'), SOURCES, 'utf8')
  await writeFile(join(root, 'skills', 'skills.lock.json'), `${JSON.stringify({
    version: 2,
    updated_at: '2026-09-15T08:00:00.000Z',
    skills: [{
      id: 'hue', repo: 'dominikmartn/hue', path: '.', commit: 'a'.repeat(40), tree_sha256: tree,
      license: 'MIT', fetched_at: '2026-09-15T08:00:00.000Z', previous_commit: null,
      model_invocable: true,
    }],
  }, null, 2)}\n`, 'utf8')
}

describe('verifySkillProvenance with upstream skills', () => {
  it('accepts locked upstream directories whose hashes match', async () => {
    const { root } = await makeRoot()
    await addUpstream(root)
    const result = await verifySkillProvenance(root)
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('accepts sources.yaml without a lock and without upstream directories', async () => {
    const { root } = await makeRoot()
    await writeFile(join(root, 'skills', 'sources.yaml'), SOURCES, 'utf8')
    expect((await verifySkillProvenance(root)).ok).toBe(true)
  })

  it('reports a tampered upstream file for that id', async () => {
    const { root } = await makeRoot()
    await addUpstream(root)
    await writeFile(join(root, 'skills', 'hue', 'SKILL.md'), '---\nname: hue\n---\n# tampered\n', 'utf8')
    const result = await verifySkillProvenance(root)
    expect(result.findings).toEqual([expect.objectContaining({ category: 'content-hash-mismatch', skill: 'hue' })])
  })

  it('reports a lock entry without its directory', async () => {
    const { root } = await makeRoot()
    await addUpstream(root, { dir: false })
    expect((await verifySkillProvenance(root)).findings).toEqual([
      expect.objectContaining({ category: 'missing-distributed-skill', skill: 'hue' }),
    ])
  })

  it('reports an extra directory next to a lock', async () => {
    const { root } = await makeRoot()
    await addUpstream(root)
    await mkdir(join(root, 'skills', 'extra'), { recursive: true })
    expect((await verifySkillProvenance(root)).findings).toEqual([
      expect.objectContaining({ category: 'unregistered-distributed-skill', skill: 'extra' }),
    ])
  })

  it('reports a lock without sources.yaml and a source id that collides with a bundled token', async () => {
    const { root } = await makeRoot()
    await addUpstream(root, { sources: false })
    expect((await verifySkillProvenance(root)).findings).toEqual([expect.objectContaining({ category: 'invalid-skill-lock' })])
    const collision = await makeRoot()
    await writeFile(join(collision.root, 'skills', 'sources.yaml'), SOURCES.replace('  hue:', '  demo:'), 'utf8')
    expect((await verifySkillProvenance(collision.root)).findings).toEqual([expect.objectContaining({ category: 'invalid-skill-sources' })])
  })
})

describe('verifySkillProvenance', () => {
  it('accepts a clean root and detects content drift', async () => {
    const { root } = await makeRoot()
    const clean = await verifySkillProvenance(root)
    expect(clean.ok).toBe(true)
    await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# drift\n', 'utf8')
    const drift = await verifySkillProvenance(root)
    expect(drift.ok).toBe(false)
    expect(drift.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'content-hash-mismatch', skill: 'demo' }),
    ]))
  })

  it('treats executable-bit drift as a content-hash mismatch', async () => {
    const { root } = await makeRoot()
    await chmod(join(root, 'skills', 'demo', 'SKILL.md'), 0o755)
    const result = await verifySkillProvenance(root)
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'content-hash-mismatch',
        skill: 'demo',
        expected: expect.stringMatching(/^sha256:/),
        actual: expect.stringMatching(/^sha256:/),
      }),
    ]))
  })

  it('rejects a reintroduced legacy lock', async () => {
    const { root } = await makeRoot()
    await writeFile(join(root, 'skills-lock.json'), '{}', 'utf8')
    const result: SkillProvenanceVerificationResult = await verifySkillProvenance(root)
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'legacy-provenance-source' }),
    ]))
  })

  it('rejects any lstat-success legacy lock node, including a directory', async () => {
    const { root } = await makeRoot()
    await mkdir(join(root, 'skills-lock.json'), { recursive: true })
    const result = await verifySkillProvenance(root)
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'legacy-provenance-source' }),
    ]))
  })

  it('rejects a top-level Skill symlink that escapes skillsRoot', async () => {
    const { root } = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'skill-provenance-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'SKILL.md'), '# demo\n', 'utf8')
    await rm(join(root, 'skills', 'demo'), { recursive: true, force: true })
    await symlink(outside, join(root, 'skills', 'demo'))

    const result = await verifySkillProvenance(root)
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'filesystem-safety-error', skill: 'demo' }),
    ]))
  })

  it('does not hash a physical root after its safety check rejects an outside symlink tree', async () => {
    const { root } = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'skill-provenance-outside-hash-'))
    roots.push(outside)
    await writeFile(join(outside, 'SKILL.md'), '# outside drift\n', 'utf8')
    await rm(join(root, 'skills', 'demo'), { recursive: true, force: true })
    await symlink(outside, join(root, 'skills', 'demo'))

    const result = await verifySkillProvenance(root)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'filesystem-safety-error', skill: 'demo' }),
    ]))
    expect(result.findings.some((item) => item.category === 'content-hash-mismatch')).toBe(false)
    expect(result.findings.some((item) => item.category === 'coordinate-mismatch')).toBe(false)
  })

  it('measures the real repository provenance inventory (tracked skill roots = registry entries, no tracked lock, no rewrites)', async () => {
    const root = process.cwd()
    const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0').filter(Boolean)
    const machineDataRoots = /^(?:templates(?:\/|$)|runtime(?:\/|$)|\.codex-plugin(?:\/|$)|\.claude-plugin(?:\/|$)|packages\/[^/]+\/dist(?:\/|$))/
    const provenanceLike = /(?:skill[-_]?sources?|skill[-_]?registry|skills[-_]?lock|provenance)/iu
    const provenanceSources = tracked.filter((path) =>
      machineDataRoots.test(path) && /\.(?:yaml|yml|json)$/iu.test(path) && provenanceLike.test(path))
    expect(provenanceSources).toEqual(['templates/skill-sources.yaml'])
    expect(tracked).not.toContain('skills/skills.lock.json')
    expect(execFileSync('git', ['check-attr', 'eol', '--', 'skills/tenon/SKILL.md'], { cwd: root, encoding: 'utf8' })).toContain('eol: lf')
    await expect(lstat(join(root, 'skills-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const trackedSkillIds = [...new Set(tracked
      .filter((path) => /^skills\/[^/]+\/SKILL\.md$/u.test(path))
      .map((path) => path.split('/')[1] ?? ''))].sort()
    // A development checkout may hold fetched upstream directories plus their lock; the verifier accepts both.
    const result = await verifySkillProvenance(root)
    expect(result.findings).toHaveLength(0)
    expect(result.ok).toBe(true)
    const registryIds = (result.registry?.skills ?? []).map((entry) => entry.sourceRef.slice('skills/'.length)).sort()
    expect(registryIds).toEqual(trackedSkillIds)
    expect(result.registry?.skills.every((entry) => entry.contentHash.startsWith('sha256:'))).toBe(true)
    const sources = parseUpstreamSkillSources(await readFile(join(root, 'skills', 'sources.yaml'), 'utf8'))
    expect(trackedSkillIds.filter((id) => sources.skills.some((source) => source.id === id))).toEqual([])
    const rewrites = []
    for (const id of trackedSkillIds.filter((candidate) => !registryIds.includes(candidate))) {
      if ((await readFile(join(root, 'skills', id, 'SKILL.md'), 'utf8')).includes('description: First-party')) rewrites.push(id)
    }
    expect(rewrites).toEqual([])
  })

  it('has a deterministic failing fixture for every declared drift category', async () => {
    const fixtures: Record<string, () => Promise<string>> = {
      'unsupported-registry-version': async () => {
        const { root } = await makeRoot()
        const path = join(root, 'templates', 'skill-sources.yaml')
        const raw = await readFile(path, 'utf8')
        await writeFile(path, raw.replace('version: 3', 'version: 2'), 'utf8')
        return root
      },
      'unknown-source-kind': async () => {
        const { root } = await makeRoot()
        const path = join(root, 'templates', 'skill-sources.yaml')
        const raw = await readFile(path, 'utf8')
        await writeFile(path, raw.replace('source_kind: bundled', 'source_kind: mystery'), 'utf8')
        return root
      },
      'invalid-source-ref': async () => {
        const { root } = await makeRoot()
        const path = join(root, 'templates', 'skill-sources.yaml')
        const raw = await readFile(path, 'utf8')
        await writeFile(path, raw.replace('source_ref: skills/demo', 'source_ref: ../escape'), 'utf8')
        return root
      },
      'missing-distributed-skill': async () => {
        const { root } = await makeRoot()
        await rm(join(root, 'skills', 'demo'), { recursive: true, force: true })
        return root
      },
      'unregistered-distributed-skill': async () => {
        const { root } = await makeRoot()
        await mkdir(join(root, 'skills', 'extra'), { recursive: true })
        await writeFile(join(root, 'skills', 'extra', 'SKILL.md'), '# extra\n', 'utf8')
        return root
      },
      'duplicate-distributed-source': async () => {
        const { root, digest } = await makeRoot()
        await writeFile(join(root, 'templates', 'skill-sources.yaml'), [
          'version: 3', 'hash_algorithm: tree-sha256-v1', 'skills:',
          `  demo: { tool: bundled, source: tenon, content_skill: demo, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/demo, content_hash: ${digest}, coordinate: tenon:skills/demo@${digest} }`,
          `  duplicate: { tool: bundled, source: tenon, content_skill: demo, tier: optional, official: true, source_kind: bundled, source_ref: skills/demo, content_hash: ${digest}, coordinate: tenon:skills/demo@${digest} }`,
          '',
        ].join('\n'), 'utf8')
        return root
      },
      'content-hash-mismatch': async () => {
        const { root } = await makeRoot()
        await chmod(join(root, 'skills', 'demo', 'SKILL.md'), 0o755)
        return root
      },
      'coordinate-mismatch': async () => {
        const { root } = await makeRoot()
        const path = join(root, 'templates', 'skill-sources.yaml')
        const raw = await readFile(path, 'utf8')
        await writeFile(path, raw.replace('coordinate: tenon:skills/demo@', 'coordinate: tenon:skills/other@'), 'utf8')
        return root
      },
      'legacy-provenance-source': async () => {
        const { root } = await makeRoot()
        await writeFile(join(root, 'skills-lock.json'), '{}', 'utf8')
        return root
      },
      'invalid-skill-sources': async () => {
        const { root } = await makeRoot()
        await writeFile(join(root, 'skills', 'sources.yaml'), SOURCES.replace('ref: default-branch', 'ref: main'), 'utf8')
        return root
      },
      'invalid-skill-lock': async () => {
        const { root } = await makeRoot()
        await addUpstream(root)
        await writeFile(join(root, 'skills', 'skills.lock.json'), '{"version":2}', 'utf8')
        return root
      },
      // 0.1.0 的原始事故：manifest 把一个 disable-model-invocation: true 的技能列为强制，
      // 宿主不会代模型调用它，该 phase×track 于是永远过不去。真 manifest + 真字节复现一次。
      'mandatory-skill-not-invocable': async () => {
        const { root } = await makeNonInvocableDemoRoot()
        return root
      },
    }
    expect(Object.keys(fixtures).sort()).toEqual([...SKILL_PROVENANCE_ERROR_CATEGORIES].sort())
    for (const category of SKILL_PROVENANCE_ERROR_CATEGORIES) {
      const root = await fixtures[category]!()
      const result = await verifySkillProvenance(root)
      expect(result.ok, category).toBe(false)
      expect(result.findings.some((item) => item.category === category), category).toBe(true)
    }
  })
})
