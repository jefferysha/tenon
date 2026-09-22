import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildUpstreamSkillView,
  parseUpstreamSkillLock,
  parseUpstreamSkillSources,
  serializeUpstreamSkillRunReport,
  UpstreamSkillError,
} from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { readUpstreamSkillView } from './upstream-skill-view.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const SOURCES = [
  'version: 1',
  'skills:',
  '  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }',
  '  shadcn: { repo: shadcn-ui/ui, path: skills/shadcn, ref: default-branch, license_expected: MIT }',
  '',
].join('\n')
const LOCK = `${JSON.stringify({
  version: 2,
  updated_at: '2026-09-15T08:00:00.000Z',
  skills: [{
    id: 'hue', repo: 'dominikmartn/hue', path: '.', commit: '2'.repeat(40), tree_sha256: DIGEST,
    license: 'MIT', fetched_at: '2026-09-15T08:00:00.000Z', previous_commit: '1'.repeat(40),
    model_invocable: true,
  }],
}, null, 2)}\n`

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function pluginRoot(files: Record<string, string>): Promise<{ root: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), 'upstream-skill-view-'))
  roots.push(root)
  await mkdir(join(root, 'templates'), { recursive: true })
  await mkdir(join(root, 'skills'), { recursive: true })
  await writeFile(join(root, 'templates', 'skill-sources.yaml'), [
    'version: 3',
    'hash_algorithm: tree-sha256-v1',
    'skills:',
    `  tenon: { tool: bundled, source: tenon, content_skill: tenon, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/tenon, content_hash: ${DIGEST}, coordinate: tenon:skills/tenon@${DIGEST} }`,
    '',
  ].join('\n'), 'utf8')
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text, 'utf8')
  }
  return { root, state: join(root, 'state') }
}

describe('readUpstreamSkillView', () => {
  it('builds the kernel view from the registry, source list, lock and last run', async () => {
    const report = {
      version: 1 as const, at: '2026-09-15T09:00:00.000Z', host: 'codex' as const,
      results: [{ id: 'hue', outcome: 'updated' as const }, { id: 'shadcn', outcome: 'missing' as const, reason: 'unreachable' as const }],
    }
    const { root, state } = await pluginRoot({
      'skills/sources.yaml': SOURCES,
      'skills/skills.lock.json': LOCK,
      'state/skills/last-update.json': serializeUpstreamSkillRunReport(report),
    })
    const sources = parseUpstreamSkillSources(SOURCES)
    expect(readUpstreamSkillView(root, state)).toEqual(buildUpstreamSkillView({
      bundledIds: ['tenon'], sources, lock: parseUpstreamSkillLock(LOCK, sources), lastRun: report,
    }))
    expect(readUpstreamSkillView(root, state).rows.map((row) => [row.id, row.status])).toEqual([
      ['tenon', 'bundled'], ['hue', 'changed'], ['shadcn', 'failed'],
    ])
  })

  it('marks every source failed without a reason in a source checkout without a lock', async () => {
    const { root, state } = await pluginRoot({ 'skills/sources.yaml': SOURCES })
    const view = readUpstreamSkillView(root, state)
    expect(view.rows.filter((row) => row.origin === 'upstream').map((row) => [row.status, row.reason])).toEqual([
      ['failed', undefined], ['failed', undefined],
    ])
    expect(view.updatedAt).toBeNull()
  })

  it('throws invalid-skill-lock for an invalid lock or a lock without sources, and ignores a broken last run', async () => {
    const broken = await pluginRoot({ 'skills/sources.yaml': SOURCES, 'skills/skills.lock.json': '{', 'state/skills/last-update.json': '{' })
    expect(() => readUpstreamSkillView(broken.root, broken.state)).toThrow(UpstreamSkillError)
    const orphan = await pluginRoot({ 'skills/skills.lock.json': LOCK })
    expect(() => readUpstreamSkillView(orphan.root, orphan.state)).toThrow(/缺少 skills\/sources.yaml/u)
    const noRun = await pluginRoot({ 'skills/sources.yaml': SOURCES, 'skills/skills.lock.json': LOCK, 'state/skills/last-update.json': '{' })
    expect(readUpstreamSkillView(noRun.root, noRun.state).lastRunAt).toBeNull()
  })
})
