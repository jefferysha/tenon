/**
 * 出口报告（`tenon status` 的 exits、`tenon check` 与 Dashboard 就绪的共同来源）对三个通用离开条件的接线：
 * 报告自己用宿主的文件面构造能力，求值口径与 transition 一致，不会因为没人注入而恒报「缺少能力」。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeGuardFileContext } from '../infrastructure/guard-file-context.js'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision } from '../state/run-revision-store.js'
import type { PipelineState } from '../types.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { evaluateStepExitReport } from './step-exit-report.js'
import type { WorkflowDef } from './types.js'

const WORKFLOW: WorkflowDef = {
  name: 'ug',
  steps: [
    {
      id: 'build', label: '', gate: null, skills: [], inputs: [], outputs: [],
      guards: [{ type: 'tasks-through-step' }, { type: 'not-afk-queued' }, { type: 'dependencies-ended' }],
      transitions: [{ event: 'complete', to: 'done' }],
    },
    { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seed(over: Partial<Record<string, string | string[]>>, tasks: string): Promise<{
  readonly root: string
  readonly changeDir: string
  readonly state: PipelineState
}> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-exit-report-ug-'))
  roots.push(root)
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
  const state: PipelineState = {
    fields: { ...emptyFields(), phase: 'build', workflow: 'ug', ...over } as PipelineState['fields'],
    opaqueTail: '',
  }
  await publishInitialRunRevision(changeDir, state, '2026-10-10T00:00:00Z')
  await writeFile(join(changeDir, 'tasks.md'), tasks)
  return { root, changeDir, state }
}

async function completeExit(root: string, changeDir: string, state: PipelineState) {
  const report = await evaluateStepExitReport({
    repoRoot: root,
    changeName: 'demo',
    changeDir,
    state,
    plan: compileEffectiveWorkflowPlan('ug', WORKFLOW),
    guardCheck: () => ({ pass: true, failures: [] }),
    guardContext: {},
    fileContext: makeGuardFileContext(root, { automationRunner: false })('demo'),
    testEvidence: { context: undefined },
    skills: async () => ({ completedSkillIds: new Set<string>(), slots: [] }),
    agentBlockers: async () => [],
  })
  const exit = report.exits.find((candidate) => candidate.event === 'complete')
  if (exit === undefined) throw new Error('期望有 complete 出边')
  return exit
}

describe('evaluateStepExitReport 与通用离开条件', () => {
  it('三项都满足：出边就绪，不报「缺少能力」', async () => {
    const { root, changeDir, state } = await seed({ automation: 'off' }, '- [x] 做完了\n')
    const exit = await completeExit(root, changeDir, state)
    expect(exit.blockers).toEqual([])
    expect(exit.ready).toBe(true)
  })

  it('未勾任务、AFK 排队、依赖未结束：三条阻断一次列出，来源为 guard', async () => {
    const { root, changeDir, state } = await seed(
      { automation: 'queued', depends_on: ['not-there'] },
      '- [ ] 还没做\n',
    )
    const exit = await completeExit(root, changeDir, state)
    expect(exit.ready).toBe(false)
    expect(exit.blockers).toHaveLength(3)
    expect(exit.blockers.every((item) => item.source === 'guard')).toBe(true)
    const text = exit.blockers.map((item) => item.message).join('\n')
    expect(text).toContain('未勾')
    expect(text).toContain('automation')
    expect(text).toContain('not-there')
    expect(text).not.toContain('缺少能力')
  })
})
