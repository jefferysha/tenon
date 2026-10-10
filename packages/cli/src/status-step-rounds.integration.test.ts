/**
 * `tenon status <change> --json` 步骤块的 `rounds`：真实 canonical 转换记录链 + 真实 `tenon set max_rounds`。
 *
 * 链里的转换用 WorkflowRunRepository 直接提交（本测试的主题是读侧计数，不重走每条转换的守卫）；
 * 其余——状态、转换记录、`set`、`get`、`status`——都是生产代码路径。
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createStateStore, createTransitionRecordStore, createWorkflowRunRepository } from '@tenon/kernel'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'roundsdemo'

interface StatusJson {
  readonly step?: {
    readonly id: string
    readonly rounds?: { readonly current: number; readonly max: number; readonly source: string } | null
  }
}

describe('status --json 的 step.rounds', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function walk(targets: readonly string[]): Promise<void> {
    const dir = join(h.cwd, 'openspec', 'changes', CHANGE)
    const repo = createWorkflowRunRepository({
      store: createStateStore(), recordStore: createTransitionRecordStore(), clock: () => FIXED_CLOCK,
    })
    for (const to of targets) {
      await repo.transact(dir, async (tx) => {
        const from = String(tx.state.fields.phase)
        await tx.commit({ ...tx.state.fields, phase: to }, { event: `to-${to}`, from, to })
      })
    }
  }

  async function step(): Promise<NonNullable<StatusJson['step']>> {
    expect(await h.run(['status', CHANGE, '--json'])).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as StatusJson
    expect(payload.step, 'step 分块必须存在').toBeDefined()
    return payload.step as NonNullable<StatusJson['step']>
  }

  test('default 工作流 verify 步：上限 2、来源 workflow；没有任何转换记录时仍是第 1 轮', async () => {
    expect(await h.seedPhase(CHANGE, 'verify')).toBeUndefined()
    const verify = await step()
    expect(verify.id).toBe('verify')
    expect(verify.rounds).toEqual({ current: 1, max: 2, source: 'workflow' })
  })

  test('按 canonical 转换链数进入次数；task 字段覆盖上限；回到规格后重新计数', async () => {
    await walk(['explore', 'spec', 'build', 'verify'])
    expect((await step()).rounds).toEqual({ current: 1, max: 2, source: 'workflow' })

    await walk(['build', 'verify'])
    expect((await step()).rounds).toEqual({ current: 2, max: 2, source: 'workflow' })

    expect(await h.run(['set', CHANGE, 'max_rounds', '1'])).toBe(0)
    expect((await step()).rounds).toEqual({ current: 2, max: 1, source: 'task' })
    expect(await h.run(['get', CHANGE, 'max_rounds'])).toBe(0)
    expect(h.out).toEqual(['1'])
    expect(await h.run(['set', CHANGE, 'max_rounds', '3'])).toBe(0)
    expect((await step()).rounds).toEqual({ current: 2, max: 3, source: 'task' })

    // build 没有评审门，不受上限约束。
    await walk(['build'])
    const build = await step()
    expect(build.id).toBe('build')
    expect(build.rounds).toBeNull()

    // 经 requirements-changed 回到规格步，再走到 verify：重新计数。
    await walk(['spec', 'build', 'verify'])
    expect((await step()).rounds).toEqual({ current: 1, max: 3, source: 'task' })
  })

  test('set max_rounds 的非法取值被拒绝，已有的覆盖值不变', async () => {
    expect(await h.run(['set', CHANGE, 'max_rounds', '2'])).toBe(0)
    for (const bad of ['0', '21', 'two', '1.5']) {
      expect(await h.run(['set', CHANGE, 'max_rounds', bad]), bad).toBe(1)
    }
    expect(await h.run(['get', CHANGE, 'max_rounds'])).toBe(0)
    expect(h.out).toEqual(['2'])
  })

  test('set 写进任务历史', async () => {
    expect(await h.run(['set', CHANGE, 'max_rounds', '4'])).toBe(0)
    const history = (await h.readIn(CHANGE, '.pipeline-history.jsonl'))
      .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(history.filter((row) => row.kind === 'set' && row.field === 'max_rounds'))
      .toEqual([expect.objectContaining({ kind: 'set', field: 'max_rounds', to: '4' })])
  })
})
