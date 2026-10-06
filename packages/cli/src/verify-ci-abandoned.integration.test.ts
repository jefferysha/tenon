/**
 * `tenon verify --ci` 与被放弃的任务：standard 通道里的任务风险升级（`scope-expanded` → `escalated`）之后，它和接手它的
 * default 任务会出现在同一个 PR 里。放弃边不要求任何测试证据，所以被放弃的任务只留一条提示、不判定；
 * 但只认「真的走过放弃边」的任务——状态里写着 `phase: escalated` 却没有放弃转换的任务照常判定、照常失败。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiChangeReport, CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { CATALOG_PATH, catalog, ciCheckout, devProject, type CiCheckout, type Dev } from './verify-ci-fixture.js'

describe('tenon verify --ci：被放弃的任务', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /** 开发者仓库：交付了 demo，另有一个 standard 任务 `sketch`（`abandon` 为真时沿放弃边转入 escalated）。 */
  async function setup(abandon: boolean): Promise<{ dev: Dev; ci: CiCheckout }> {
    const dev = await devProject()
    cleanups.push(dev.cleanup)
    expect(await dev.tenon(['init', 'sketch', '--workflow', 'standard', '--track', 'standard']), `${dev.out()}\n${dev.err()}`).toBe(0)
    if (abandon) expect(await dev.tenon(['transition', 'sketch', 'scope-expanded']), `${dev.out()}\n${dev.err()}`).toBe(0)
    dev.commit(abandon ? 'abandon sketch, deliver demo' : 'start sketch')
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)
    return { dev, ci }
  }

  async function verify(ci: CiCheckout, ...args: string[]): Promise<{ code: number; report: CiVerifyReport; out: string }> {
    const run = await ci.verify([...args, '--format', 'json'])
    return { code: run.code, out: `${run.out}\n${run.err}`, report: JSON.parse(run.out) as CiVerifyReport }
  }

  const change = (report: CiVerifyReport, name: string): CiChangeReport => {
    const found = report.changes.find((item) => item.change === name)
    if (found === undefined) throw new Error(`报告里没有任务 ${name}`)
    return found
  }

  test('沿放弃边转入 escalated 的任务：不判定、留一条提示；交付的任务照常判定，整体通过（--since 与 --all-open 都是）', async () => {
    const { ci } = await setup(true)
    const since = await verify(ci, '--since', 'main')
    expect(since.code, since.out).toBe(0)
    expect(since.report.changes.map((item) => item.change)).toEqual(['demo', 'sketch'])
    const abandoned = change(since.report, 'sketch')
    expect(abandoned).toMatchObject({ phase: 'escalated', step: 'escalated', policy: 'none', evaluatedUser: null, chains: [] })
    expect(abandoned.findings).toEqual([expect.objectContaining({ code: 'change-abandoned', severity: 'note', source: 'ci', change: 'sketch' })])
    expect(abandoned.findings[0]?.message).toContain('scope-expanded')
    expect(change(since.report, 'demo')).toMatchObject({ policy: 'pass', step: 'build' })
    expect(since.report.summary).toMatchObject({ pass: true, errors: 0 })

    // 放弃边带 archive-run：任务已是完结状态，--all-open 本来就不选它。
    const open = await verify(ci, '--all-open')
    expect(open.code, open.out).toBe(0)
    expect(open.report.changes.map((item) => item.change)).toEqual(['demo'])

    const named = await verify(ci, '--change', 'sketch')
    expect(named.code, named.out).toBe(0)
    const text = await ci.verify(['--change', 'sketch'])
    expect(text.code).toBe(0)
    expect(text.out).toContain('[NOTE]')
    expect(text.out).toContain('change-abandoned')
  }, 180_000)

  /** 把任务的 canonical 状态与它的 YAML 投影里的当前步骤改成 escalated，不经过任何转换。 */
  async function writeEscalatedPhase(ci: CiCheckout, name: string): Promise<void> {
    const base = join(ci.dir, 'openspec/changes', name)
    for (const file of [join(base, '.pipeline.yaml'), join(base, '.pipeline-run/current.json')]) {
      const text = await readFile(file, 'utf8')
      const next = text.replace(/("phase":"|^phase: )(open|build)\b/gmu, '$1escalated')
      expect(next, file).not.toBe(text)
      await writeFile(file, next, 'utf8')
    }
  }

  test('状态被改成 phase: escalated、没有放弃转换（从未转换，或最后一次转换是别的事件）：不算被放弃，任务状态校验不过、照常失败', async () => {
    const { dev, ci } = await setup(false)
    const untouched = await verify(ci, '--change', 'sketch')
    expect(untouched.code, untouched.out).toBe(0)
    expect(untouched.report.changes[0]?.findings.map((item) => item.code)).not.toContain('change-abandoned')

    await writeEscalatedPhase(ci, 'sketch')
    ci.commit('make sketch look abandoned: no transition at all')
    const never = await verify(ci, '--change', 'sketch')
    expect(never.code, never.out).toBe(2)
    expect(never.report.changes[0]?.findings.map((item) => item.code)).not.toContain('change-abandoned')
    expect(never.report.summary.pass).toBe(false)

    // 真的走过一次转换（open-complete），之后状态被改成 escalated：链头不是放弃事件。
    expect(await dev.tenon(['transition', 'sketch', 'open-complete']), `${dev.out()}\n${dev.err()}`).toBe(0)
    dev.commit('advance sketch to build')
    const second = await ciCheckout(dev)
    cleanups.push(second.cleanup)
    expect((await verify(second, '--change', 'sketch')).report.changes[0]?.phase).toBe('build')
    await writeEscalatedPhase(second, 'sketch')
    second.commit('make sketch look abandoned: the last transition was open-complete')
    const stale = await verify(second, '--change', 'sketch')
    expect(stale.code, stale.out).toBe(2)
    expect(stale.report.changes[0]?.findings.map((item) => item.code)).not.toContain('change-abandoned')
  }, 180_000)

  test('被放弃的任务动了受保护的测试目录、没有批准行：照样失败——放弃边不要求评审，批准检查不能被它绕过', async () => {
    const dev = await devProject()
    cleanups.push(dev.cleanup)
    expect(await dev.tenon(['init', 'sketch', '--workflow', 'standard', '--track', 'standard']), `${dev.out()}\n${dev.err()}`).toBe(0)
    // 任务起点之后改了受保护的测试目录（降低标准的一种典型改法），然后沿放弃边离开：没有评审、没有批准行。
    await writeFile(join(dev.dir, CATALOG_PATH), catalog('单测（放弃的任务里改的）'), 'utf8')
    expect(await dev.tenon(['transition', 'sketch', 'scope-expanded']), `${dev.out()}\n${dev.err()}`).toBe(0)
    dev.commit('abandon sketch; its edit to the test catalog stays in the tree')
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)

    const result = await verify(ci, '--change', 'sketch')
    expect(result.code, result.out).toBe(2)
    const abandoned = change(result.report, 'sketch')
    expect(abandoned).toMatchObject({ policy: 'none', step: 'escalated', chains: [] })
    expect(abandoned.findings.map((item) => `${item.code}:${item.severity}`).sort()).toEqual(['change-abandoned:note', 'protected-unapproved:error'])
    expect(abandoned.findings.find((item) => item.code === 'protected-unapproved')?.subject ?? '').toContain(CATALOG_PATH)
    expect(result.report.summary).toMatchObject({ pass: false, errors: 1 })

    // 选进 PR 里的任务时同样：被放弃的任务的受保护改动不会因为它「被放弃」而被放过。
    expect((await verify(ci, '--since', 'main')).code).toBe(2)
  }, 180_000)

  test('放弃转换的记录被改成别的事件：不再认作放弃（状态与记录对不上，照常失败）', async () => {
    const { ci } = await setup(true)
    const dir = join(ci.dir, 'openspec/changes/sketch/.pipeline-transitions')
    const [name] = await readdir(dir)
    expect(name).toBeDefined()
    const file = join(dir, name ?? '')
    const record = await readFile(file, 'utf8')
    expect(record).toContain('"event":"scope-expanded"')
    await writeFile(file, record.replace('"event":"scope-expanded"', '"event":"open-complete"'), 'utf8')
    ci.commit('rewrite the abandon transition')
    const forged = await verify(ci, '--change', 'sketch')
    expect(forged.code, forged.out).toBe(2)
    expect(forged.report.changes[0]?.findings.map((item) => item.code)).not.toContain('change-abandoned')
  }, 180_000)
})
