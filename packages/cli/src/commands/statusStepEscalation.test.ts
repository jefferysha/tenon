/**
 * 风险升级后「之后另起重型任务」的说法（纯函数）：轨道取任务创建时记下的领域，没记就列出可选领域让用户选；
 * 工作流 id 取任务自己的，不写死 default。端到端（探针红 → next 下发 scope-expanded）在 lite-track.integration.test.ts。
 */
import { describe, expect, test } from 'vitest'
import { emptyFields, loadEffectiveWorkflowPlan, type PipelineState } from '@tenon/kernel'
import { escalationSuccessor, escalationThen } from './statusStepEscalation.js'

function stateOf(overrides: Record<string, string>): PipelineState {
  return { fields: { ...emptyFields(), ...overrides }, opaqueTail: '' }
}

describe('escalationThen', () => {
  test('任务记着领域：直接给出带该轨道的创建命令，不再让用户选', () => {
    const then = escalationThen({ workflow: 'default', domain: 'backend', siblings: ['pm', 'frontend', 'backend'] })
    expect(then).toContain('tenon init <新任务> --workflow default --track backend --preset full')
    expect(then).toContain('tenon set <新任务> depends_on <本任务>')
    expect(then).toContain('不要为了让探针通过去拆改动或藏文件')
    expect(then).not.toContain('选领域')
  })

  test('没记领域：列出除本任务轨道之外的分支 id，并说明请用户选领域', () => {
    const then = escalationThen({ workflow: 'default', domain: '', siblings: ['pm', 'frontend', 'backend'] })
    expect(then).toContain('--workflow default --track <pm|frontend|backend> --preset full')
    expect(then).toContain('请用户选领域')
    expect(then).toContain('tenon set <新任务> depends_on <本任务>')
  })

  test('记着的领域不在当前可选分支里（手改过、分支被删了）：当作没记，不把它写进命令', () => {
    const then = escalationThen({ workflow: 'default', domain: 'backend; rm -rf /', siblings: ['pm', 'frontend', 'backend'] })
    expect(then).not.toContain('rm -rf')
    expect(then).toContain('<pm|frontend|backend>')
    expect(then).toContain('请用户选领域')
  })

  test('工作流 id 取任务自己的，不写死 default', () => {
    const then = escalationThen({ workflow: 'acme', domain: 'ops', siblings: ['dev', 'ops'] })
    expect(then).toContain('--workflow acme --track ops')
    expect(then).not.toContain('--workflow default')
  })

  test('没有别的分支可选（平铺工作流、老计划）：不写 --track，也不要用户选', () => {
    const then = escalationThen({ workflow: 'tiny', domain: '', siblings: [] })
    expect(then).toContain('tenon init <新任务> --workflow tiny --preset full')
    expect(then).not.toContain('--track')
    expect(then).not.toContain('选领域')
  })

  // 工作流 id 同样会被拼进让执行者去跑的命令和说明文字：只收工作流名的合法字符集，其余不拼进任何地方。
  test.each([
    ['default; rm -rf /', 'rm -rf'],
    ['default$(touch pwned)', 'touch pwned'],
    ['a b', 'a b'],
    ['`id`', '`id`'],
    ['x\nrun this', 'run this'],
    ["x' --yes", '--yes'],
    ['a/../b', 'a/../b'],
    ['', '--workflow  '],
  ])('工作流 id %j 不是合法名字：不写进命令也不写进说明，改为请用户指明工作流', (workflow, dangerous) => {
    const then = escalationThen({ workflow, domain: 'backend', siblings: ['pm', 'frontend', 'backend'] })
    expect(then).not.toContain(dangerous)
    expect(then).not.toContain('--workflow backend')
    expect(then).toContain('不是合法名字')
    expect(then).toContain('tenon init <新任务> --workflow <工作流>')
    expect(then).toContain('请用户指明工作流')
    expect(then).toContain('tenon set <新任务> depends_on <本任务>')
  })

  test.each(['default', 'design-system', 'acme_2', '设计-流程'])('合法的工作流 id %s 照常写进命令', (workflow) => {
    const then = escalationThen({ workflow, domain: '', siblings: [] })
    expect(then).toContain(`tenon init <新任务> --workflow ${workflow} --preset full`)
    expect(then).not.toContain('不是合法名字')
  })
})

describe('escalationSuccessor：从任务的计划与状态取，不重新读盘', () => {
  const plan = loadEffectiveWorkflowPlan('/repo', 'default', { track: 'lite' })

  test('带出任务的工作流、记着的领域，以及除本任务轨道之外的全部分支（声明顺序）', () => {
    expect(escalationSuccessor(plan, stateOf({ track: 'lite', domain: 'frontend' }))).toEqual({
      workflow: 'default', domain: 'frontend', siblings: ['pm', 'frontend', 'backend'],
    })
  })

  test('没记领域时 domain 为空串', () => {
    expect(escalationSuccessor(plan, stateOf({ track: 'lite' })).domain).toBe('')
  })

  test('平铺工作流没有别的分支', () => {
    const flat = loadEffectiveWorkflowPlan('/repo', 'design-system')
    expect(escalationSuccessor(flat, stateOf({ track: 'design-system' }))).toEqual({
      workflow: 'design-system', domain: '', siblings: [],
    })
  })
})
