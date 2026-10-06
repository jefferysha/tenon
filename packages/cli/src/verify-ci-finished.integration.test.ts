/**
 * `tenon verify --ci` 与已完结的任务：CI 证明的是它检出的那棵树，所以一个已完结的任务也是对本次检出的树判定，
 * 不是对它完结时的提交。完结之后的提交（改了代码、后来的任务新增测试文件）会让它出错——这是设计，不是 bug；
 * 报告要把这一点说清楚，并且在它自己的交付提交上它照样通过。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { git, writeFiles } from './integration-harness-tests.js'
import { ciCheckout, devProject, type CiCheckout, type Dev } from './verify-ci-fixture.js'

describe('tenon verify --ci：已完结的任务', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function finished(): Promise<{ dev: Dev; ci: CiCheckout; delivery: string }> {
    const dev = await devProject({ finish: true })
    cleanups.push(dev.cleanup)
    const delivery = git(dev.dir, ['rev-parse', 'HEAD']).trim()
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)
    return { dev, ci, delivery }
  }

  async function verify(ci: CiCheckout, ...args: string[]): Promise<{ code: number; report: CiVerifyReport; out: string }> {
    const run = await ci.verify(['--change', 'demo', '--format', 'json', ...args])
    return { code: run.code, out: `${run.out}\n${run.err}`, report: JSON.parse(run.out) as CiVerifyReport }
  }

  const codes = (report: CiVerifyReport, severity: 'error' | 'note'): string[] =>
    report.changes.flatMap((change) => change.findings).filter((item) => item.severity === severity).map((item) => item.code)

  test('交付提交上通过且没有额外说明；之后的提交让它出错：错误仍然报，另有一条提示说明它是对检出的树判定的', async () => {
    const { ci, delivery } = await finished()
    const atDelivery = await verify(ci)
    expect(atDelivery.code, atDelivery.out).toBe(0)
    expect(codes(atDelivery.report, 'note')).not.toContain('finished-judged-at-head')

    // 之后的任务改了实现文件。
    await writeFile(join(ci.dir, 'src/feature.js'), 'export const feature = () => 2\n', 'utf8')
    await writeFiles(ci.dir, { 'src/other.test.js': 'export {}\n' })
    ci.commit('a later task changes the code')
    const later = await verify(ci)
    expect(later.code, later.out).toBe(2)
    expect(codes(later.report, 'error')).toContain('candidate-mismatch')
    const note = later.report.changes[0]?.findings.find((item) => item.code === 'finished-judged-at-head')
    expect(note).toMatchObject({ severity: 'note', source: 'ci', change: 'demo' })
    expect(note?.message).toContain('--since')
    expect(note?.message).toContain('demo')
    const text = await ci.verify(['--change', 'demo'], { TENON_LANG: 'en' })
    expect(text.out).toContain('is finished, but CI judges it against the checked-out tree')

    // 检出它的交付提交再校验：和完结时一样通过。
    git(ci.dir, ['checkout', '-q', delivery])
    const back = await verify(ci)
    expect(back.code, back.out).toBe(0)
    expect(codes(back.report, 'note')).not.toContain('finished-judged-at-head')
  }, 180_000)

  test('没有完结的任务出错时不加这条说明', async () => {
    const dev = await devProject()
    cleanups.push(dev.cleanup)
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)
    await writeFile(join(ci.dir, 'src/feature.js'), 'export const feature = () => 2\n', 'utf8')
    ci.commit('change the code')
    const result = await verify(ci)
    expect(result.code).toBe(2)
    expect(codes(result.report, 'error')).toContain('candidate-mismatch')
    expect(codes(result.report, 'note')).not.toContain('finished-judged-at-head')
  }, 180_000)
})
