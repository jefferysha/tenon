import { describe, expect, it } from 'vitest'
import {
  classifyAgainstKnownFailures, knownFailureExpired, knownFailureTooLong, latestKnownFailureExpiry, parseKnownFailures,
  serializeKnownFailures, type KnownFailure,
} from './known-failures.js'

const TEXT = `schema: tenon-known-failures/v1
entries:
  - suite: api-regression
    test: "tests/api/orders.test.ts › 退款超时"
    reason: 上游支付沙箱不稳定
    link: https://example.test/issues/1
    expires: 2026-10-31
    added_by: tester@tenon.test
`

function entries(text: string): readonly KnownFailure[] {
  const result = parseKnownFailures(text)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.line}: ${issue.message}`).join('\n'))
  return result.entries
}

const identity = { file: 'tests/api/orders.test.ts', suite_path: [], name: '退款超时' }

describe('已知失败清单（R3：指向具体用例、期限有上限）', () => {
  it('只写文件的引用被拒：必须指向具体用例', () => {
    const result = parseKnownFailures(TEXT.replace('tests/api/orders.test.ts › 退款超时', 'tests/api/orders.test.ts'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/只指向文件；必须指向具体用例/)
  })

  it('最晚到期日是今天 + 30 天；更晚的条目不被承认，当天到期日之前仍按已知失败处理', () => {
    expect(latestKnownFailureExpiry('2026-09-29')).toBe('2026-10-29')
    expect(latestKnownFailureExpiry('2026-12-15')).toBe('2027-01-14')
    const entry: KnownFailure = { suite: 's', test: 'a.test.ts › x', reason: 'r', expires: '2026-10-29', added_by: 'a' }
    expect(knownFailureTooLong(entry, '2026-09-29')).toBe(false)
    expect(knownFailureTooLong({ ...entry, expires: '2026-10-30' }, '2026-09-29')).toBe(true)
    const identity2 = { file: 'a.test.ts', suite_path: [], name: 'x' }
    expect(classifyAgainstKnownFailures([{ ...entry, expires: '2027-06-01' }], 's', identity2, 'fail', '2026-09-29').verdict).toBe('too-long')
    expect(classifyAgainstKnownFailures([entry], 's', identity2, 'fail', '2026-09-29').verdict).toBe('known-fail')
  })
})

describe('已知失败清单', () => {
  it('解析、写出、读回', () => {
    const list = entries(TEXT)
    expect(list).toEqual([{
      suite: 'api-regression', test: 'tests/api/orders.test.ts › 退款超时', reason: '上游支付沙箱不稳定',
      link: 'https://example.test/issues/1', expires: '2026-10-31', added_by: 'tester@tenon.test',
    }])
    const text = serializeKnownFailures(list)
    expect(entries(text)).toEqual(list)
    expect(text).toContain('expires: "2026-10-31"')
  })

  it.each([
    ['schema 不对', TEXT.replace('tenon-known-failures/v1', 'x'), /schema 必须是/],
    ['过期日期格式', TEXT.replace('2026-10-31', '2026/10/31'), /YYYY-MM-DD/],
    ['用例引用非法', TEXT.replace('tests/api/orders.test.ts › 退款超时', '../x'), /已知失败 test '\.\.\/x' 非法/],
    ['链接不是 http', TEXT.replace('https://example.test/issues/1', 'ftp://x'), /http\(s\) 链接/],
    ['未知键', TEXT.replace('    reason:', '    owner: x\n    reason:'), /不认识键 'owner'/],
    ['缺原因', TEXT.replace('    reason: 上游支付沙箱不稳定\n', ''), /reason 缺失/],
    ['重复条目', TEXT + TEXT.split('entries:\n')[1], /重复/],
    ['YAML 错误', 'entries: [\n', /未闭合/],
  ])('%s → 拒绝', (_name, text, pattern) => {
    const result = parseKnownFailures(text)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.message).join('\n')).toMatch(pattern)
  })

  it('判定：清单内失败 known-fail、清单内通过 fixed、过期失败 expired、清单外失败 new-fail', () => {
    const list = entries(TEXT)
    expect(classifyAgainstKnownFailures(list, 'api-regression', identity, 'fail', '2026-10-31').verdict).toBe('known-fail')
    expect(classifyAgainstKnownFailures(list, 'api-regression', identity, 'known-fail', '2026-10-01').verdict).toBe('known-fail')
    expect(classifyAgainstKnownFailures(list, 'api-regression', identity, 'pass', '2026-10-01').verdict).toBe('fixed')
    expect(classifyAgainstKnownFailures(list, 'api-regression', identity, 'flaky', '2026-10-01').verdict).toBe('fixed')
    expect(classifyAgainstKnownFailures(list, 'api-regression', identity, 'fail', '2026-11-01').verdict).toBe('expired')
    expect(classifyAgainstKnownFailures(list, 'other-suite', identity, 'fail', '2026-10-01').verdict).toBe('new-fail')
    expect(classifyAgainstKnownFailures(list, 'api-regression', { ...identity, name: '别的' }, 'fail', '2026-10-01').verdict).toBe('new-fail')
    expect(classifyAgainstKnownFailures(list, 'api-regression', identity, 'skip', '2026-10-01').verdict).toBe('skip')
    expect(classifyAgainstKnownFailures([], 'api-regression', identity, 'pass', '2026-10-01').verdict).toBe('pass')
    expect(knownFailureExpired(list[0] ?? ({} as KnownFailure), '2026-10-31')).toBe(false)
  })
})
