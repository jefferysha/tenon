import { describe, expect, it } from 'vitest'
import { mergeRerun } from './rerun.js'
import type { ParsedCase } from './parsers/index.js'

function item(overrides: Partial<ParsedCase> & { name: string }): ParsedCase {
  return { file: 'src/a.test.ts', suite_path: ['grp'], project: null, status: 'pass', duration_ms: 1, attempts: 1, attachments: [], ...overrides }
}

describe('mergeRerun', () => {
  const failing = item({ name: 'flaky', status: 'fail', failure: { message: 'first boom' } })
  const stillBad = item({ name: 'bad', status: 'fail', failure: { message: 'boom' } })
  const fine = item({ name: 'fine' })
  const first = [fine, failing, stillBad]

  it('重跑通过 → flaky（累加尝试次数，保留首次的失败信息）；仍失败 → 保持失败并累加；没跑到的保持原样', () => {
    const again = [item({ name: 'flaky', status: 'pass' }), item({ name: 'bad', status: 'fail', failure: { message: 'boom again' } })]
    const merged = mergeRerun(first, [failing, stillBad], again)
    expect(merged[0]).toBe(fine)
    expect(merged[1]).toMatchObject({ name: 'flaky', status: 'flaky', attempts: 2, failure: { message: 'first boom' } })
    expect(merged[2]).toMatchObject({ name: 'bad', status: 'fail', attempts: 2, failure: { message: 'boom again' } })
    expect(mergeRerun(first, [failing, stillBad], [])).toEqual(first)
  })

  it('同名但不同文件 / 分组 / project 不算同一用例；文件按尾部匹配', () => {
    const other = item({ name: 'flaky', file: 'src/other.test.ts', status: 'pass' })
    expect(mergeRerun([failing], [failing], [other])[0]).toBe(failing)
    const tail = item({ name: 'flaky', file: 'packages/w/src/a.test.ts', status: 'pass' })
    expect(mergeRerun([failing], [failing], [tail])[0]).toMatchObject({ status: 'flaky' })
    const browser = item({ name: 'e2e', status: 'fail', project: 'chromium' })
    expect(mergeRerun([browser], [browser], [item({ name: 'e2e', status: 'pass', project: 'webkit' })])[0]).toBe(browser)
  })

  it('重跑里被跳过的用例不改变结论', () => {
    expect(mergeRerun([failing], [failing], [item({ name: 'flaky', status: 'skip' })])[0]).toBe(failing)
  })
})
