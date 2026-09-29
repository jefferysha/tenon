import { describe, expect, it } from 'vitest'
import { decodeTestRunRecordV2, type KnownFailure, type TestPlan } from '@tenon/kernel'
import { fixtureRecordDraft, fixtureSuiteRun } from '@tenon/kernel/test-system/test-support'
import { isRetained, recordCases, totalsOf, wantedFiles } from './case-records.js'
import type { ParsedCase } from './parsers/index.js'

function parsed(overrides: Partial<ParsedCase> & { name: string }): ParsedCase {
  return { file: 'src/a.test.ts', suite_path: ['grp'], project: null, status: 'pass', duration_ms: 3, attempts: 1, attachments: [], ...overrides }
}

const KNOWN: KnownFailure[] = [{ suite: 'unit', test: 'src/known.test.ts › known bug', reason: 'r', expires: '2026-12-31', added_by: 'a@x.io' }]
const PLAN: TestPlan = {
  schema: 'tenon-test-plan/v1', change: 'demo', suites: [], files: [{ path: 'src/registered.test.ts', suite: 'unit' }],
  cases: [{ covers: 'task:1', tests: ['src/mapped.test.ts › works'] }], waivers: [],
}

function context(extra: Partial<Parameters<typeof recordCases>[1]> = {}) {
  return {
    suiteId: 'unit', wanted: wantedFiles(PLAN, ['src/registered.test.ts'], KNOWN, 'unit'), knownFailures: KNOWN, today: '2026-09-29',
    indexed: (absolute: string) => (absolute === '/repo/shot.png' ? 'artifacts/unit/shot.png' : undefined),
    resolveAttachment: (path: string) => path, ...extra,
  }
}

describe('recordCases', () => {
  it('已知失败（未过期）标 known-fail，其余失败保持 fail；过期的按普通失败', () => {
    const known = parsed({ name: 'known bug', file: 'src/known.test.ts', status: 'fail', failure: { message: 'boom' } })
    const other = parsed({ name: 'new bug', status: 'fail', failure: { message: 'boom' } })
    const { all } = recordCases([known, other], context())
    expect(all.map((item) => item.status)).toEqual(['known-fail', 'fail'])
    expect(recordCases([known], context({ today: '2027-01-01' })).all[0]?.status).toBe('fail')
  })

  it('totals 覆盖全部用例；记录只保留失败 / flaky / 已知失败 / 登记文件与映射文件 / 已知失败清单点名文件里的用例', () => {
    const list = [
      parsed({ name: 'plain pass', file: 'src/plain.test.ts' }),
      parsed({ name: 'a skip', file: 'src/plain.test.ts', status: 'skip' }),
      parsed({ name: 'bad', file: 'src/plain.test.ts', status: 'fail', failure: { message: 'x' } }),
      parsed({ name: 'wobbly', file: 'src/plain.test.ts', status: 'flaky', attempts: 2 }),
      parsed({ name: 'in registered', file: 'packages/w/src/registered.test.ts' }),
      parsed({ name: 'works', file: 'src/mapped.test.ts' }),
      parsed({ name: 'fixed now', file: 'src/known.test.ts' }),
    ]
    const { all, kept } = recordCases(list, context())
    expect(totalsOf(all)).toEqual({ cases: 7, pass: 4, fail: 1, skip: 1, flaky: 1, known_fail: 0 })
    expect(kept.map((item) => item.name)).toEqual(['bad', 'wobbly', 'in registered', 'works', 'fixed now'])
    expect(isRetained(list[0] as ParsedCase, context().wanted)).toBe(false)
  })

  it('失败信息只留给失败 / flaky / 已知失败；附件换成产物索引路径，找不到索引的丢掉', () => {
    const item = parsed({
      name: 'shot', file: 'src/a.test.ts', status: 'fail', failure: { message: 'x' },
      attachments: [{ name: 'screenshot', path: '/repo/shot.png' }, { name: 'gone', path: '/repo/gone.png' }],
    })
    const passing = parsed({ name: 'ok', file: 'src/registered.test.ts', failure: { message: 'stale' } })
    const { kept } = recordCases([item, passing], context())
    expect(kept[0]).toMatchObject({ artifacts: ['artifacts/unit/shot.png'], failure: { message: 'x' } })
    expect(kept[1]?.failure).toBeUndefined()
  })

  it('过长的名字 / project 被截断，写出的记录能通过解码', () => {
    const long = 'x'.repeat(9000)
    const { all } = recordCases([parsed({ name: long, file: `src/${long}.test.ts`, suite_path: [long], project: 'p'.repeat(300), status: 'fail', failure: { message: 'm' }, duration_ms: -5.4 })], context())
    const record = fixtureRecordDraft({ suites: [fixtureSuiteRun({ suite: 'unit', cases: all, totals: totalsOf(all), result: 'fail' })] })
    expect(decodeTestRunRecordV2({ ...record, prev_digest: null, digest: `sha256:${'0'.repeat(64)}` })).toBeDefined()
    expect(all[0]?.duration_ms).toBe(0)
  })
})
