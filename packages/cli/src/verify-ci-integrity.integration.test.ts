/**
 * `tenon verify --ci` 的测试完整性：与转换门禁同一份判定。开发者在交付前删了基线里的旧测试文件（又让套件照常通过），
 * 策略 `integrity: block` 时 CI 失败（error 级 test-integrity），缺省 notice 只给 note 级发现、退出码不变；
 * 没有信号就没有完整性发现；浅克隆读不出任务起点以来的改动行时，block 失败关闭，notice 提示未检查。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiFinding, CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { LEGACY_TEST, LEGACY_TEST_PATH, ciCheckout, devProject, type CiCheckout, type DevProjectOptions } from './verify-ci-fixture.js'

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

  test('integrity: block 端到端：同一个被删的测试文件，本地 test integrity 与步骤出口、CI 的 verify --ci 给同一个结论；还原之后三处一起放行', async () => {
    const dev = await devProject({ integrity: 'block', deleteLegacyTest: true })
    cleanups.push(dev.cleanup)

    // 本地 1：test integrity 以 exit 2 报出信号（--json 的 pass 为 false，模式 block）。
    expect(await dev.tenon(['test', 'integrity', 'demo', '--json']), `${dev.out()}\n${dev.err()}`).toBe(2)
    const local = JSON.parse(dev.out()) as { pass: boolean; mode: string; signals: Array<{ code: string; subject: string }> }
    expect(local).toMatchObject({ pass: false, mode: 'block' })
    expect(local.signals.map((signal) => `${signal.code}:${signal.subject}`)).toEqual([`test-file-deleted:${LEGACY_TEST_PATH}`])

    // 本地 2：步骤出口被它挡住——test status 以 exit 2 退出，唯一的阻塞项就是 test-integrity；tenon check 同样不放行。
    expect(await dev.tenon(['test', 'status', 'demo', '--step', 'build', '--json'])).toBe(2)
    const status = JSON.parse(dev.out()) as { pass: boolean; policy?: { blockers: Array<{ code: string; blocking: boolean }> } }
    expect(status.pass).toBe(false)
    expect(status.policy?.blockers.filter((blocker) => blocker.blocking).map((blocker) => blocker.code)).toEqual(['test-integrity'])
    expect(await dev.tenon(['check', 'demo'])).not.toBe(0)
    expect(dev.out()).toContain('测试完整性未通过：测试文件被删 1')

    // CI：干净克隆里的 verify --ci 对同一个信号报 error 级 test-integrity，exit 2，修复命令指回本地的 test integrity。
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)
    const blocked = await verify(ci)
    expect(blocked.code, `${blocked.out}\n${blocked.err}`).toBe(2)
    expect(integrityFindings(blocked)).toEqual([
      expect.objectContaining({ code: 'test-integrity', severity: 'error', source: 'policy', fix: 'tenon test integrity demo' }),
    ])
    expect(findings(blocked).filter((item) => item.severity === 'error').map((item) => item.code)).toEqual(['test-integrity'])

    // 还原被删的文件并提交：三处一起放行（信号是相对任务起点的 diff，文件回到起点内容就没有信号）。
    await writeFile(join(dev.dir, LEGACY_TEST_PATH), LEGACY_TEST, 'utf8')
    expect(await dev.tenon(['test', 'run', 'demo', '--stage']), `${dev.out()}\n${dev.err()}`).toBe(0)
    dev.commit('restore the deleted test')
    expect(await dev.tenon(['test', 'integrity', 'demo', '--json'])).toBe(0)
    expect(JSON.parse(dev.out())).toMatchObject({ pass: true, mode: 'block', signals: [] })
    expect(await dev.tenon(['test', 'status', 'demo', '--step', 'build', '--json']), dev.out()).toBe(0)
    const restored = await ciCheckout(dev)
    cleanups.push(restored.cleanup)
    const clean = await verify(restored)
    expect(clean.code, `${clean.out}\n${clean.err}`).toBe(0)
    expect(integrityFindings(clean)).toEqual([])
  }, 240_000)

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
