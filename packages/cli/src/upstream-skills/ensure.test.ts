import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { UpstreamSkillInstallInput, UpstreamSkillInstallResult } from './install.js'
import { ensureUpstreamSkillsForSource, upstreamSkillGap, upstreamSkillIds } from './ensure.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SOURCES = [
  'version: 1',
  'skills:',
  '  alpha: { repo: owner/alpha, path: skills/alpha, ref: default-branch, license_expected: MIT }',
  '  beta: { repo: owner/beta, path: skills/beta, ref: default-branch, license_expected: MIT }',
  '',
].join('\n')

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function repoWith(options: { alpha?: boolean; beta?: boolean; index?: boolean; sources?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'tenon-ensure-'))
  roots.push(root)
  write(root, 'skills/sources.yaml', options.sources ?? SOURCES)
  if (options.alpha !== false) write(root, 'skills/alpha/SKILL.md', 'alpha\n')
  if (options.beta !== false) write(root, 'skills/beta/SKILL.md', 'beta\n')
  if (options.index !== false) write(root, 'skills/skills.lock.json', '{"version":1}\n')
  return root
}

function result(outcomes: Array<{ id: string; outcome: 'updated' | 'unchanged' | 'missing' }>): UpstreamSkillInstallResult {
  return {
    lockWritten: true,
    report: {
      version: 1,
      at: '2026-10-07T00:00:00.000Z',
      host: 'dev',
      results: outcomes.map((entry) => entry.outcome === 'missing'
        ? { id: entry.id, outcome: 'missing' as const, reason: 'unreachable' as const, detail: 'offline' }
        : { id: entry.id, outcome: entry.outcome }),
    },
  } as UpstreamSkillInstallResult
}

function base(repo: string, install: (input: UpstreamSkillInstallInput) => Promise<UpstreamSkillInstallResult>) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'tenon-ensure-state-'))
  roots.push(stateRoot)
  const lines: string[] = []
  return {
    lines,
    input: {
      repo,
      env: { runCommand: () => ({ code: 1, stdout: '', stderr: 'no git in unit tests' }) },
      workRoot: join(stateRoot, 'staging'),
      stateRoot,
      now: () => '2026-10-07T00:00:00.000Z',
      log: (line: string) => lines.push(line),
      install,
    },
  }
}

describe('upstreamSkillGap', () => {
  test('lists missing ids and a missing index', () => {
    const repo = repoWith({ beta: false, index: false })
    expect(upstreamSkillIds(repo)).toEqual(['alpha', 'beta'])
    expect(upstreamSkillGap(repo)).toEqual({ missingIds: ['beta'], indexMissing: true })
  })

  test('an empty sources file never reports a missing index', () => {
    const repo = repoWith({ sources: 'version: 1\nskills:\n', index: false })
    expect(upstreamSkillGap(repo)).toEqual({ missingIds: [], indexMissing: false })
  })

  test.each(['../x', 'a/b', '..', '.'])('refuses the id %s before it can be joined into skills/<id>/SKILL.md', (id) => {
    const sources = `version: 1\nskills:\n  ${id}: { repo: owner/x, path: skills/x, ref: default-branch, license_expected: MIT }\n`
    const repo = repoWith({ sources })
    expect(() => upstreamSkillIds(repo)).toThrow('不合法')
    expect(() => upstreamSkillGap(repo)).toThrow('不合法')
  })
})

describe('ensureUpstreamSkillsForSource', () => {
  test('does nothing, and never touches the network, when every skill and the index exist', async () => {
    let calls = 0
    const { input } = base(repoWith(), async () => { calls += 1; return result([]) })
    expect(await ensureUpstreamSkillsForSource(input)).toEqual({ state: 'present' })
    expect(calls).toBe(0)
  })

  test('fetches into the repository itself when a skill is missing, treating the checkout as its own previous state', async () => {
    const repo = repoWith({ beta: false })
    let received: UpstreamSkillInstallInput | undefined
    const { input, lines } = base(repo, async (installInput) => {
      received = installInput
      write(repo, 'skills/beta/SKILL.md', 'beta\n')
      return result([{ id: 'alpha', outcome: 'unchanged' }, { id: 'beta', outcome: 'updated' }])
    })
    expect(await ensureUpstreamSkillsForSource(input)).toEqual({ state: 'fetched' })
    expect(received).toMatchObject({ pluginRoot: repo, previousRoot: repo, host: 'dev' })
    expect(lines.join('\n')).toContain('缺 1 个上游技能')
  })

  test('a missing index alone also triggers the fetch', async () => {
    const repo = repoWith({ index: false })
    let calls = 0
    const { input } = base(repo, async () => {
      calls += 1
      write(repo, 'skills/skills.lock.json', '{"version":1}\n')
      return result([{ id: 'alpha', outcome: 'unchanged' }, { id: 'beta', outcome: 'unchanged' }])
    })
    expect(await ensureUpstreamSkillsForSource(input)).toEqual({ state: 'fetched' })
    expect(calls).toBe(1)
  })

  test('any skill the fetch reports missing aborts as a whole', async () => {
    const { input } = base(repoWith({ alpha: false, beta: false }), async () => result([
      { id: 'alpha', outcome: 'missing' },
      { id: 'beta', outcome: 'updated' },
    ]))
    const outcome = await ensureUpstreamSkillsForSource(input)
    expect(outcome.state).toBe('failed')
    expect(outcome.state === 'failed' ? outcome.detail : '').toContain('alpha')
  })

  test('a fetch that throws, and a fetch that leaves the gap open, both abort', async () => {
    const thrown = base(repoWith({ beta: false }), async () => { throw new Error('git clone failed') })
    const thrownOutcome = await ensureUpstreamSkillsForSource(thrown.input)
    expect(thrownOutcome).toMatchObject({ state: 'failed' })
    expect(thrownOutcome.state === 'failed' ? thrownOutcome.detail : '').toContain('git clone failed')

    const stillOpen = base(repoWith({ beta: false }), async () => result([{ id: 'alpha', outcome: 'unchanged' }]))
    expect(await ensureUpstreamSkillsForSource(stillOpen.input)).toMatchObject({ state: 'failed' })
  })

  test('an invalid sources file aborts before any fetch', async () => {
    let calls = 0
    const { input } = base(repoWith({ sources: 'version: 1\nskills: {}\n' }), async () => { calls += 1; return result([]) })
    const outcome = await ensureUpstreamSkillsForSource(input)
    expect(outcome.state).toBe('failed')
    expect(calls).toBe(0)
  })
})
