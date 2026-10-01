/**
 * `tenon verify --ci` 的测试完整性：与转换门禁同一份判定。开发者在交付前删了基线里的旧测试文件（又让套件照常通过），
 * 策略 `integrity: block` 时 CI 失败（error 级 test-integrity），缺省 notice 只给 note 级发现、退出码不变；
 * 没有信号就没有完整性发现；浅克隆读不出任务起点以来的改动行时，block 失败关闭，notice 提示未检查。
 */
import type { CiFinding, CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { ciCheckout, devProject, type CiCheckout, type DevProjectOptions } from './verify-ci-fixture.js'

const INTEGRITY_CODES = ['test-integrity', 'files-diff-unavailable', 'files-unchecked']

interface Result {
  code: number
  report: CiVerifyReport
  out: string
  err: string
}

function findings(result: Result): readonly CiFinding[] {
  return result.report.changes.flatMap((change) => change.findings)
}

function integrityFindings(result: Result): readonly CiFinding[] {
  return findings(result).filter((item) => INTEGRITY_CODES.includes(item.code))
}

describe('tenon verify --ci 测试完整性', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function checkout(options: DevProjectOptions, ci: { readonly shallow?: boolean } = {}): Promise<CiCheckout> {
    const dev = await devProject(options)
    cleanups.push(dev.cleanup)
    const checkedOut = await ciCheckout(dev, ci)
    cleanups.push(checkedOut.cleanup)
    return checkedOut
  }

  async function verify(ci: CiCheckout, ...args: string[]): Promise<Result> {
    const run = await ci.verify(['--change', 'demo', '--format', 'json', ...args])
    return { ...run, report: JSON.parse(run.out) as CiVerifyReport }
  }

  test('integrity: block + 被删的测试文件：error 级 test-integrity，exit 2', async () => {
    const ci = await checkout({ integrity: 'block', deleteLegacyTest: true })
    const result = await verify(ci)
    expect(result.code, `${result.out}\n${result.err}`).toBe(2)
    const [finding, ...rest] = integrityFindings(result)
    expect(rest).toEqual([])
    expect(finding).toMatchObject({ code: 'test-integrity', severity: 'error', source: 'policy', fix: 'tenon test integrity demo' })
    expect(finding?.message).toContain('测试文件被删')
    expect(result.report.changes[0]?.policy).toBe('fail')
    expect(findings(result).filter((item) => item.severity === 'error').map((item) => item.code)).toEqual(['test-integrity'])
  }, 180_000)

  test('缺省 notice + 被删的测试文件：note 级 test-integrity，exit 0，SARIF 与 markdown 里也是提示级', async () => {
    const ci = await checkout({ deleteLegacyTest: true })
    const result = await verify(ci)
    expect(result.code, `${result.out}\n${result.err}`).toBe(0)
    expect(integrityFindings(result)).toEqual([
      expect.objectContaining({ code: 'test-integrity', severity: 'note', source: 'policy', fix: 'tenon test integrity demo' }),
    ])
    expect(result.report.summary).toMatchObject({ pass: true, errors: 0, warnings: 0 })
    expect(result.report.changes[0]?.policy).toBe('pass')

    const sarif = await ci.verify(['--change', 'demo', '--format', 'sarif'])
    expect(sarif.code).toBe(0)
    const results = (JSON.parse(sarif.out) as { runs: Array<{ results: Array<{ ruleId: string; level: string }> }> }).runs[0]?.results ?? []
    expect(results.filter((item) => item.ruleId === 'tenon/test-integrity')).toEqual([expect.objectContaining({ level: 'note' })])
    expect(results.filter((item) => item.level !== 'note')).toEqual([])

    const markdown = await ci.verify(['--change', 'demo', '--format', 'markdown'])
    expect(markdown.code).toBe(0)
    expect(markdown.out).toContain('| 提示 | `test-integrity` | `demo` |')
    expect(markdown.out).toContain('测试完整性信号')
  }, 180_000)

  test('没有信号：不论 block 还是缺省，都没有完整性发现', async () => {
    const blocked = await checkout({ integrity: 'block' })
    const strict = await verify(blocked)
    expect(strict.code, `${strict.out}\n${strict.err}`).toBe(0)
    expect(integrityFindings(strict)).toEqual([])
    expect(strict.report.changes[0]?.policy).toBe('pass')

    const plain = await checkout({})
    const lenient = await verify(plain)
    expect(lenient.code, `${lenient.out}\n${lenient.err}`).toBe(0)
    expect(integrityFindings(lenient)).toEqual([])
  }, 240_000)

  test('浅克隆 + integrity: block：读不出改动行，失败关闭（files-diff-unavailable）而不是当作没有信号', async () => {
    const ci = await checkout({ integrity: 'block', deleteLegacyTest: true }, { shallow: true })
    const result = await verify(ci)
    expect(result.code).toBe(2)
    const unavailable = findings(result).find((item) => item.code === 'files-diff-unavailable')
    expect(unavailable).toMatchObject({ severity: 'error', source: 'policy' })
    expect(unavailable?.message).toContain('fetch-depth: 0')
    expect(findings(result).map((item) => item.code)).not.toContain('test-integrity')
    expect(result.report.changes[0]?.policy).toBe('fail')
  }, 180_000)

  test('浅克隆 + 缺省 notice：提示测试完整性没能检查，不是错误', async () => {
    const ci = await checkout({ deleteLegacyTest: true }, { shallow: true })
    const result = await verify(ci)
    const unchecked = findings(result).find((item) => item.code === 'files-unchecked')
    expect(unchecked).toMatchObject({ severity: 'note', source: 'policy' })
    expect(unchecked?.message).toContain('不能确认测试没有被削弱')
    expect(findings(result).filter((item) => INTEGRITY_CODES.includes(item.code) && item.severity !== 'note')).toEqual([])
    expect(findings(result).filter((item) => item.severity === 'error').map((item) => item.code)).toEqual(['protected-diff-unavailable'])
  }, 180_000)
})
