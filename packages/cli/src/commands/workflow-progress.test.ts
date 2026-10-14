import {
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanFromIr,
  workflowPlanSnapshot,
  type PipelineState,
} from '@tenon/kernel'
import { describe, expect, test } from 'vitest'
import { buildProgram } from '../program.js'
import { makeDeps, mockState } from '../test-support.js'
import { cmdWorkflowProgress } from './workflow-progress.js'

function stateWithSnapshot(
  workflow: string,
  phase: string,
  snapshot: ReturnType<typeof workflowPlanSnapshot>,
  extra: Record<string, string> = {},
): PipelineState {
  return {
    ...mockState({ workflow, phase, track: 'backend', ...extra }),
    runMetadata: {
      runId: 'run-1',
      transitionSequence: 0,
      workflowPlanFingerprint: snapshot.workflowFingerprint,
      workflowPlanSnapshot: snapshot,
    },
  }
}

const defaultSnapshot = workflowPlanSnapshot(compileEffectiveWorkflowPlan('default', undefined, { track: 'backend' }))

describe('workflow progress —— 终端一行步骤清单', () => {
  test('冻结默认计划、phase=explore：stdout 恰为一行，立项已过、调研当前', async () => {
    const deps = makeDeps({ state: stateWithSnapshot('default', 'explore', defaultSnapshot) })
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(0)
    expect(deps.outLines).toEqual(['立项 ✓ → 调研 ● → 规格 ○ → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○'])
    expect(deps.errLines).toEqual([])
  })

  test('fields.archived=true：每一步都是 ✓', async () => {
    const deps = makeDeps({
      state: stateWithSnapshot('default', 'archive', defaultSnapshot, { archived: 'true' }),
    })
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(0)
    expect(deps.outLines).toEqual(['立项 ✓ → 调研 ✓ → 规格 ✓ → 实现 ✓ → 验证 ✓ → 交付 ✓ → 完结 ✓'])
  })

  test('自定义短工作流：只列出冻结计划里的步骤，标签取步骤 label', async () => {
    const plan = compileEffectiveWorkflowPlan('short-flow', {
      name: 'short-flow',
      steps: [
        { id: 'shape', label: 'shape', gate: null, skills: [], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'shape-complete', to: 'implement' }] },
        { id: 'implement', label: 'implement', gate: null, skills: [], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'implement-complete', to: 'verify' }] },
        { id: 'verify', label: 'verify', gate: null, skills: [], inputs: [], outputs: [], guards: [],
          transitions: [] },
      ],
    })
    const deps = makeDeps({
      state: stateWithSnapshot('short-flow', 'implement', workflowPlanSnapshot(plan)),
    })
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(0)
    expect(deps.outLines).toEqual(['shape ✓ → implement ● → verify ○'])
  })

  test('workflow 未知且没有冻结快照：exit 1、stdout 为空', async () => {
    const deps = makeDeps({ state: mockState({ workflow: 'no-such-flow', phase: 'x', track: 'free' }) })
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('no-such-flow')
  })

  test('冻结计划的 projection 没有步骤：exit 1、stdout 为空', async () => {
    const def = compileEffectiveWorkflowPlan('short-flow', {
      name: 'short-flow',
      steps: [{ id: 'only', label: 'only', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }).workflow
    const emptyPlan = effectiveWorkflowPlanFromIr('empty-flow', { ...def, steps: [] })
    const deps = makeDeps({
      state: stateWithSnapshot('empty-flow', 'only', workflowPlanSnapshot(emptyPlan)),
    })
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('没有可列出的步骤')
  })

  test('经 tenon workflow progress <change> 入口调用，stdout 只有清单一行', async () => {
    const deps = makeDeps({ state: stateWithSnapshot('default', 'spec', defaultSnapshot) })
    await buildProgram(deps).parseAsync(['workflow', 'progress', 'demo'], { from: 'user' })
    expect(deps.outLines).toEqual(['立项 ✓ → 调研 ✓ → 规格 ● → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○'])
  })

  test('任务名非法：exit 1、stdout 为空，不读状态', async () => {
    const deps = makeDeps({ state: stateWithSnapshot('default', 'explore', defaultSnapshot) })
    expect(await cmdWorkflowProgress(deps, '../evil')).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.length).toBeGreaterThan(0)
  })

  test('读不到状态：exit 1、stdout 为空', async () => {
    const deps = makeDeps({ state: stateWithSnapshot('default', 'explore', defaultSnapshot) })
    deps.store.read = async () => {
      throw new Error('boom: 读不到')
    }
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('boom')
  })

  describe('任务建在 worktree 里：主检出读不到时回退到 worktree', () => {
    const WT = '/repo/.worktrees/demo'
    const wtDir = `${WT}/openspec/changes/demo`
    const enoent = (dir: string): NodeJS.ErrnoException => {
      const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${dir}/.pipeline.yaml'`)
      error.code = 'ENOENT'
      return error
    }

    function mainCheckoutDeps(changes: readonly string[] = ['demo']) {
      const state = stateWithSnapshot('default', 'spec', defaultSnapshot)
      const deps = makeDeps({ state })
      deps.store.read = async (dir: string) => {
        if (dir === wtDir) return state
        throw enoent(dir)
      }
      deps.taskWorktrees = async () => [{ path: WT, branch: 'tenon/demo', changes }]
      return deps
    }

    test('主检出里没有该任务、它在 .worktrees/demo：输出该任务的一行清单', async () => {
      const deps = mainCheckoutDeps()
      expect(await cmdWorkflowProgress(deps, 'demo')).toBe(0)
      expect(deps.outLines).toEqual(['立项 ✓ → 调研 ✓ → 规格 ● → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○'])
      expect(deps.errLines).toEqual([])
    })

    test('任何 worktree 里都没有该任务：exit 1、stdout 为空，错误是原来的读取错误', async () => {
      const deps = mainCheckoutDeps(['other'])
      expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
      expect(deps.outLines).toEqual([])
      expect(deps.errLines.join('\n')).toContain('ENOENT')
    })

    test('读 worktree 清单失败：exit 1、stdout 为空', async () => {
      const deps = mainCheckoutDeps()
      deps.taskWorktrees = async () => { throw new Error('git 不可用') }
      expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
      expect(deps.outLines).toEqual([])
    })

    test('主检出里读到了任务就不查 worktree 清单', async () => {
      const deps = makeDeps({ state: stateWithSnapshot('default', 'explore', defaultSnapshot) })
      let listed = 0
      deps.taskWorktrees = async () => { listed += 1; return [] }
      expect(await cmdWorkflowProgress(deps, 'demo')).toBe(0)
      expect(listed).toBe(0)
    })

    test('读取失败不是「找不到」（状态损坏之类）：不回退，原样报错', async () => {
      const deps = mainCheckoutDeps()
      deps.store.read = async () => { throw new Error('boom: 状态损坏') }
      expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
      expect(deps.outLines).toEqual([])
      expect(deps.errLines.join('\n')).toContain('boom')
    })
  })

  test('冻结快照与 workflow 不一致导致解析抛错：exit 1、stdout 为空', async () => {
    const deps = makeDeps({ state: stateWithSnapshot('other-flow', 'explore', defaultSnapshot) })
    expect(await cmdWorkflowProgress(deps, 'demo')).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('snapshot')
  })
})
