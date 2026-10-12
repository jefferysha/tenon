/**
 * 状态层单测共享基座：在临时仓库里按「工作流 + 轨道」初始化一个任务，列出任务目录里的文件。
 * 零 vitest 依赖（同 workflow/test-support.ts 先例）；`default` 用目标形态的夹具定义（含 lite 分支）。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanBinding,
  workflowPlanSnapshot,
} from '../workflow/effective-plan.js'
import { targetDefaultWorkflow } from '../workflow/test-support.js'
import { createStateStore } from './store.js'
import { createTransitionRecordStore } from './transition-record-store.js'
import { createWorkflowRunRepository } from './workflow-run-repository.js'

const CLOCK = '2026-10-10T00:00:00Z'
const CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

export interface InitializedRun {
  readonly dir: string
  /** 任务目录里的文件名（排序）。 */
  readonly files: string[]
  readonly cleanup: () => Promise<void>
}

export async function initRunInTemp(opts: { workflow: string; track: string }): Promise<InitializedRun> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-init-run-'))
  const cleanup = (): Promise<void> => rm(root, { recursive: true, force: true })
  try {
    const plan = compileEffectiveWorkflowPlan(
      opts.workflow,
      opts.workflow === 'default' ? targetDefaultWorkflow() : undefined,
      { track: opts.track },
    )
    const first = plan.workflow.steps[0]
    if (first === undefined) throw new Error(`workflow '${opts.workflow}' 没有步骤`)
    const repo = createWorkflowRunRepository({
      store: createStateStore(),
      recordStore: createTransitionRecordStore(),
      clock: () => CLOCK,
    })
    const { changeDir } = await repo.initChange({
      repoRoot: root,
      name: 'demo',
      track: opts.track,
      reviewSeed: 'pending',
      preset: 'full',
      creator: CREATOR,
      clock: () => CLOCK,
      initialWorkflow: {
        workflow: opts.workflow,
        phase: first.id,
        ...effectiveWorkflowPlanBinding(plan),
        workflowPlanSnapshot: workflowPlanSnapshot(plan),
        ...(plan.capabilities.documents.policy?.id === 'openspec-v1' ? { openspecContract: true } : {}),
        ...(plan.capabilities.documents.policy?.id === 'document-v1' ? { documentContract: true } : {}),
      },
    })
    return { dir: changeDir, files: (await readdir(changeDir)).sort(), cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
