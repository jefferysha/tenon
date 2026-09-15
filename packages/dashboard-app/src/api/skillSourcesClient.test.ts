import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeSkillSources, fetchSkillSources } from './skillSourcesClient'

const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)

/** Shape produced by the server's buildUpstreamSkillView. */
export const SERVER_FIXTURE = {
  updatedAt: '2026-09-15T08:00:00.000Z',
  lastRunAt: '2026-09-15T09:00:00.000Z',
  rows: [
    { id: 'tenon', origin: 'tenon', status: 'bundled' },
    {
      id: 'hue', origin: 'upstream', status: 'changed', repo: 'dominikmartn/hue', path: '.', commit: C2,
      previousCommit: C1, license: 'MIT', fetchedAt: '2026-09-15T08:00:00.000Z',
      sourceUrl: `https://github.com/dominikmartn/hue/tree/${C2}`,
      commitUrl: `https://github.com/dominikmartn/hue/commit/${C2}`,
      compareUrl: `https://github.com/dominikmartn/hue/compare/${C1}...${C2}`,
    },
    {
      id: 'web-design-guidelines', origin: 'upstream', status: 'failed', repo: 'vercel-labs/agent-skills',
      path: 'skills/web-design-guidelines', reason: 'license-missing',
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decodeSkillSources', () => {
  it('accepts the server fixture', () => {
    expect(decodeSkillSources(SERVER_FIXTURE)).toEqual(SERVER_FIXTURE)
  })

  it.each([
    ['a bad status', { ...SERVER_FIXTURE, rows: [{ id: 'hue', origin: 'upstream', status: 'stale' }] }],
    ['missing rows', { updatedAt: null, lastRunAt: null }],
    ['a non-string commit', { ...SERVER_FIXTURE, rows: [{ id: 'hue', origin: 'upstream', status: 'unchanged', commit: 42 }] }],
    ['an unknown row key', { ...SERVER_FIXTURE, rows: [{ id: 'hue', origin: 'upstream', status: 'unchanged', installed: true }] }],
    ['a non-GitHub link', { ...SERVER_FIXTURE, rows: [{ id: 'hue', origin: 'upstream', status: 'unchanged', commitUrl: 'javascript:alert(1)' }] }],
  ])('rejects %s', (_label, body) => {
    expect(decodeSkillSources(body)).toBeNull()
  })
})

describe('fetchSkillSources', () => {
  it('returns the decoded view and surfaces the server error on failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => SERVER_FIXTURE, text: async () => JSON.stringify(SERVER_FIXTURE) })
      .mockResolvedValueOnce({
        ok: false, status: 500,
        json: async () => ({ ok: false, error: 'skills/skills.lock.json: JSON 无效' }),
        text: async () => JSON.stringify({ ok: false, error: 'skills/skills.lock.json: JSON 无效' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchSkillSources()).resolves.toEqual(SERVER_FIXTURE)
    expect(fetchMock).toHaveBeenCalledWith('/api/skills/sources', { headers: { Accept: 'application/json' } })
    await expect(fetchSkillSources()).rejects.toThrow(/skills\.lock\.json/u)
  })
})
