import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildUpstreamSkillView,
  parseUpstreamSkillLock,
  parseUpstreamSkillRunReport,
  parseUpstreamSkillSources,
  serializeUpstreamSkillLock,
  serializeUpstreamSkillRunReport,
  UpstreamSkillError,
  type UpstreamSkillLock,
  type UpstreamSkillRunReport,
} from './upstream-sources.js'

const SOURCES_TEXT = readFileSync(new URL('./upstream-sources.fixture.yaml', import.meta.url), 'utf8')
const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const T1 = `sha256:${'a'.repeat(64)}`

function category(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof UpstreamSkillError ? error.category : `other:${String(error)}`
  }
  return undefined
}

const miniSources = parseUpstreamSkillSources([
  'version: 1',
  'skills:',
  '  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }',
  '  brainstorming: { repo: obra/superpowers, path: skills/brainstorming, ref: default-branch, license_expected: MIT }',
  '  shadcn: { repo: shadcn-ui/ui, path: skills/shadcn, ref: default-branch, license_expected: MIT }',
  '',
].join('\n'))

function lockText(entries: readonly Record<string, unknown>[], updatedAt = '2026-09-15T08:00:00.000Z'): string {
  return `${JSON.stringify({ version: 1, updated_at: updatedAt, skills: entries }, null, 2)}\n`
}

function entry(id: string, repo: string, path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, repo, path, commit: C1, tree_sha256: T1, license: 'MIT',
    fetched_at: '2026-09-15T08:00:00.000Z', previous_commit: null, ...extra,
  }
}

describe('parseUpstreamSkillSources', () => {
  it('parses the source list with renamed ids and root-path skills', () => {
    const sources = parseUpstreamSkillSources(SOURCES_TEXT)
    const ids = sources.skills.map((skill) => skill.id)
    expect(sources.skills).toHaveLength(45)
    expect(new Set(sources.skills.map((skill) => skill.repo)).size).toBe(12)
    expect(ids).toEqual(expect.arrayContaining(['vercel-react-best-practices', 'shadcn', 'design-taste-frontend']))
    for (const removed of ['zoom-out', 'verify', 'run', 'uiuxdesign-pro', 'tailwind-css-patterns', 'code-review', 'react-best-practices', 'shadcn-ui']) {
      expect(ids).not.toContain(removed)
    }
    expect(sources.skills.find((skill) => skill.id === 'design-taste-frontend')?.path).toBe('skills/taste-skill')
    expect(sources.skills.find((skill) => skill.id === 'huashu-design')).toMatchObject({ path: '.', ref: 'default-branch' })
    expect(sources.skills.find((skill) => skill.id === 'skill-creator')?.licenseExpected).toBe('Apache-2.0')
  })

  const hueLine = '  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }'
  it.each([
    ['unknown field', hueLine.replace(' }', ', pin: abc }')],
    ['ref: main', hueLine.replace('default-branch', 'main')],
    ['path: ../x', hueLine.replace('path: .', 'path: ../x')],
    ['path trailing slash', hueLine.replace('path: .', 'path: skills/')],
    ['repo: a/b/c', hueLine.replace('dominikmartn/hue', 'a/b/c')],
    ['repo .git', hueLine.replace('dominikmartn/hue', 'dominikmartn/hue.git')],
    ['duplicate id', `${hueLine}\n${hueLine}`],
    ['license_expected: GPL-3.0', hueLine.replace('MIT', 'GPL-3.0')],
    ['uppercase id', hueLine.replace('hue:', 'Hue:')],
    ['missing field', hueLine.replace(', ref: default-branch', '')],
  ])('rejects %s', (_label, line) => {
    expect(category(() => parseUpstreamSkillSources(`version: 1\nskills:\n${line}\n`))).toBe('invalid-skill-sources')
  })

  it.each([
    ['version 2', 'version: 2\nskills:\n'],
    ['no version', 'skills:\n'],
    ['unknown top-level key', 'version: 1\nowner: me\nskills:\n'],
  ])('rejects %s', (_label, text) => {
    expect(category(() => parseUpstreamSkillSources(text))).toBe('invalid-skill-sources')
  })
})

describe('upstream skill lock', () => {
  it('round-trips a sorted lock and sorts unsorted input', () => {
    const sorted = lockText([
      entry('brainstorming', 'obra/superpowers', 'skills/brainstorming'),
      entry('hue', 'dominikmartn/hue', '.', { previous_commit: C2 }),
    ])
    expect(serializeUpstreamSkillLock(parseUpstreamSkillLock(sorted, miniSources))).toBe(sorted)
    const unsorted = lockText([
      entry('hue', 'dominikmartn/hue', '.', { previous_commit: C2 }),
      entry('brainstorming', 'obra/superpowers', 'skills/brainstorming'),
    ])
    expect(serializeUpstreamSkillLock(parseUpstreamSkillLock(unsorted))).toBe(sorted)
  })

  it.each([
    ['repo differs from source', [entry('hue', 'someone/hue', '.')]],
    ['id not in sources', [entry('stranger', 'dominikmartn/hue', '.')]],
    ['short commit', [entry('hue', 'dominikmartn/hue', '.', { commit: 'abc' })]],
    ['license not allowed', [entry('hue', 'dominikmartn/hue', '.', { license: 'GPL-3.0' })]],
    ['duplicate id', [entry('hue', 'dominikmartn/hue', '.'), entry('hue', 'dominikmartn/hue', '.')]],
    ['extra field', [entry('hue', 'dominikmartn/hue', '.', { note: 'x' })]],
  ])('rejects %s', (_label, entries) => {
    expect(category(() => parseUpstreamSkillLock(lockText(entries), miniSources))).toBe('invalid-skill-lock')
  })

  it('rejects malformed JSON and a non-UTC timestamp', () => {
    expect(category(() => parseUpstreamSkillLock('{'))).toBe('invalid-skill-lock')
    expect(category(() => parseUpstreamSkillLock(lockText([], '2026-09-15 08:00')))).toBe('invalid-skill-lock')
  })
})

describe('upstream skill run report', () => {
  it('round-trips and requires reasons exactly for failures', () => {
    const report: UpstreamSkillRunReport = {
      version: 1,
      at: '2026-09-15T08:00:00.000Z',
      host: 'codex',
      results: [
        { id: 'hue', outcome: 'unchanged' },
        { id: 'huashu-design', outcome: 'kept', reason: 'unreachable', detail: 'timed out after 2 attempts' },
        { id: 'web-design-guidelines', outcome: 'missing', reason: 'license-missing' },
      ],
    }
    const text = serializeUpstreamSkillRunReport(report)
    expect(parseUpstreamSkillRunReport(text)).toEqual(report)
    const bad = text.replace('"outcome": "unchanged"', '"outcome": "unchanged", "reason": "removed"')
    expect(category(() => parseUpstreamSkillRunReport(bad))).toBe('invalid-skill-lock')
    expect(category(() => parseUpstreamSkillRunReport(text.replace('"reason": "license-missing"', '"reason": "nope"')))).toBe('invalid-skill-lock')
  })
})

describe('buildUpstreamSkillView', () => {
  const lock: UpstreamSkillLock = parseUpstreamSkillLock(lockText([
    entry('brainstorming', 'obra/superpowers', 'skills/brainstorming', { fetched_at: '2026-09-01T00:00:00.000Z' }),
    entry('hue', 'dominikmartn/hue', '.', { commit: C2, previous_commit: C1 }),
  ]), miniSources)

  it('orders bundled rows first and derives changed, unchanged and failed rows', () => {
    const lastRun: UpstreamSkillRunReport = {
      version: 1, at: '2026-09-15T09:00:00.000Z', host: 'claude',
      results: [
        { id: 'hue', outcome: 'updated' },
        { id: 'brainstorming', outcome: 'unchanged' },
        { id: 'shadcn', outcome: 'missing', reason: 'unreachable', detail: 'deadline' },
      ],
    }
    const view = buildUpstreamSkillView({ bundledIds: ['tenon'], sources: miniSources, lock, lastRun })
    expect(view.updatedAt).toBe('2026-09-15T08:00:00.000Z')
    expect(view.lastRunAt).toBe('2026-09-15T09:00:00.000Z')
    expect(view.rows.map((row) => [row.id, row.status])).toEqual([
      ['tenon', 'bundled'], ['hue', 'changed'], ['brainstorming', 'unchanged'], ['shadcn', 'failed'],
    ])
    expect(view.rows[0]).toEqual({ id: 'tenon', origin: 'tenon', status: 'bundled' })
    expect(view.rows[1]).toMatchObject({
      origin: 'upstream',
      sourceUrl: `https://github.com/dominikmartn/hue/tree/${C2}`,
      commitUrl: `https://github.com/dominikmartn/hue/commit/${C2}`,
      compareUrl: `https://github.com/dominikmartn/hue/compare/${C1}...${C2}`,
    })
    expect(view.rows[2]?.compareUrl).toBeUndefined()
    expect(view.rows[2]?.sourceUrl).toBe(`https://github.com/obra/superpowers/tree/${C1}/skills/brainstorming`)
    expect(view.rows[3]).toMatchObject({ reason: 'unreachable', detail: 'deadline', repo: 'shadcn-ui/ui' })
  })

  it('marks a locked skill failed only when the last run is not older than the lock', () => {
    const kept = (at: string): UpstreamSkillRunReport => ({
      version: 1, at, host: 'codex', results: [{ id: 'hue', outcome: 'kept', reason: 'unreachable' }],
    })
    const older = buildUpstreamSkillView({ bundledIds: [], sources: miniSources, lock, lastRun: kept('2026-09-14T00:00:00.000Z') })
    expect(older.rows.find((row) => row.id === 'hue')).toMatchObject({ status: 'changed' })
    expect(older.rows.find((row) => row.id === 'hue')?.reason).toBeUndefined()
    const newer = buildUpstreamSkillView({ bundledIds: [], sources: miniSources, lock, lastRun: kept('2026-09-16T00:00:00.000Z') })
    expect(newer.rows.find((row) => row.id === 'hue')).toMatchObject({ status: 'failed', reason: 'unreachable', commit: C2 })
  })

  it('marks every source failed without reasons when there is no lock and no run', () => {
    const view = buildUpstreamSkillView({ bundledIds: [], sources: miniSources, lock: null, lastRun: null })
    expect(view.rows.every((row) => row.status === 'failed' && row.reason === undefined)).toBe(true)
    expect(view.updatedAt).toBeNull()
  })
})
