import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUpstreamSkillRunReport } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { makeDeps } from '../test-support.js'
import {
  createFixtureHub,
  fixtureSkillMd,
  MIT_LICENSE_TEXT,
  writePluginRoot,
  type FixtureHub,
} from '../upstream-skills/test-support.js'
import { cmdInternalSkillUpstream, type InternalSkillUpstreamRuntime } from './internal-skill-upstream.js'

const ALPHA = '  alpha: { repo: owner-a/skills, path: skills/alpha, ref: default-branch, license_expected: MIT }'
const NOLIC = '  nolic: { repo: owner-b/nolicense, path: skills/nolic, ref: default-branch, license_expected: MIT }'
const hubs: FixtureHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.cleanup()
})

function fixture(lines: readonly string[]): { hub: FixtureHub; root: string; runtime: InternalSkillUpstreamRuntime } {
  const hub = createFixtureHub()
  hubs.push(hub)
  hub.commit('owner-a/skills', { 'skills/alpha/SKILL.md': fixtureSkillMd('alpha'), LICENSE: MIT_LICENSE_TEXT })
  hub.commit('owner-b/nolicense', { 'skills/nolic/SKILL.md': fixtureSkillMd('nolic') })
  const root = writePluginRoot(join(hub.root, 'checkout'), lines)
  return {
    hub,
    root,
    runtime: { env: hub.env, stateRoot: join(hub.root, 'state'), workRoot: join(hub.root, 'work'), now: () => '2026-09-15T08:00:00.000Z' },
  }
}

describe('cmdInternalSkillUpstream', () => {
  it('exits 0 when every skill is installed and records the last run', async () => {
    const { root, runtime } = fixture([ALPHA])
    const deps = makeDeps()
    expect(await cmdInternalSkillUpstream(deps, 'fetch', { root }, runtime)).toBe(0)
    expect(deps.outLines).toContain('[skills] 获取 owner-a/skills …')
    expect(deps.outLines.at(-1)).toBe('[skills] 1 个上游技能：更新 1，无变化 0，保留 0，缺失 0')
    expect(existsSync(join(root, 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    const lastRun = parseUpstreamSkillRunReport(readFileSync(join(runtime.stateRoot, 'skills', 'last-update.json'), 'utf8'))
    expect(lastRun).toMatchObject({ host: 'dev', results: [{ id: 'alpha', outcome: 'updated' }] })
  })

  it('exits 1 when a skill is missing and prints the JSON report with --json', async () => {
    const { root, runtime } = fixture([ALPHA, NOLIC])
    const deps = makeDeps()
    expect(await cmdInternalSkillUpstream(deps, 'fetch', { root, json: true }, runtime)).toBe(1)
    expect(deps.outLines).toHaveLength(1)
    expect(parseUpstreamSkillRunReport(deps.outLines[0] ?? '').results).toEqual([
      { id: 'alpha', outcome: 'updated' },
      { id: 'nolic', outcome: 'missing', reason: 'license-missing' },
    ])
  })

  it('exits 2 for a bad mode, a missing root or invalid sources', async () => {
    const { root, runtime, hub } = fixture([ALPHA.replace('default-branch', 'main')])
    const deps = makeDeps()
    expect(await cmdInternalSkillUpstream(deps, 'sync', { root }, runtime)).toBe(2)
    expect(await cmdInternalSkillUpstream(deps, 'fetch', {}, runtime)).toBe(2)
    expect(await cmdInternalSkillUpstream(deps, 'fetch', { root }, runtime)).toBe(2)
    expect(deps.errLines.join('\n')).toContain('ref')
    expect(hub.calls).toEqual([])
  })
})
