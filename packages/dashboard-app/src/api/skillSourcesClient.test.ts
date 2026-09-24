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
      modelInvocable: true,
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

describe('decodeSkillSources · 视图自知的失败原因', () => {
  it('keeps lock-missing / not-locked and still rejects an unknown reason', () => {
    const row = (reason: string) => ({ id: 'hue', origin: 'upstream', status: 'failed', repo: 'dominikmartn/hue', path: '.', reason })
    expect(decodeSkillSources({ ...SERVER_FIXTURE, rows: [row('lock-missing')] })?.rows[0]?.reason).toBe('lock-missing')
    expect(decodeSkillSources({ ...SERVER_FIXTURE, rows: [row('not-locked')] })?.rows[0]?.reason).toBe('not-locked')
    expect(decodeSkillSources({ ...SERVER_FIXTURE, rows: [row('mystery')] })).toBeNull()
  })
})

describe('decodeSkillSources · modelInvocable', () => {
  // 服务端从 SKILL.md 字节读出可调用性后会带上 modelInvocable；白名单漏了它，整页报「响应格式无效」。
  it('keeps a boolean modelInvocable and rejects any other type', () => {
    expect(decodeSkillSources(SERVER_FIXTURE)?.rows[1]?.modelInvocable).toBe(true)
    const wrong = { ...SERVER_FIXTURE, rows: [{ id: 'x', origin: 'upstream', status: 'unchanged', modelInvocable: 'yes' }] }
    expect(decodeSkillSources(wrong)).toBeNull()
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
