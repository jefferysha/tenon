/**
 * 三个通用离开条件（tasks-through-step / not-afk-queued / dependencies-ended，设计 §1b Q5 / Q7 / Q8）
 * 的能力工厂——CLI 与 Dashboard server 绑定同一份实现，同一个任务在两处得到同样的判定。
 *
 * 判定口径一律复用现有实现，不另写一套：
 *   · 任务勾选 —— TaskPlan / tasks.md 的 `taskPlanTasksThroughPhaseForChange`（有界读取、投影认证、
 *     按阶段累计），与 Todo 投影同源。
 *   · AFK 排队 —— `automation=queued`；调度器自己执行（`automationRunner`）时恒为 false。
 *   · 依赖结束 —— 沿用 `depends-archived` 的判定：活跃目录存在时以其规范状态 `archived` 为准，
 *     否则看 `openspec/changes/archive/*-<dep>`。
 *
 * 能力读取失败（状态读不到、状态损坏）一律抛错，由 guard handler 失败关闭，不在这里吞掉。
 */
import { readCurrentRunRevision } from '../state/run-revision-store.js'
import { taskPlanTasksThroughPhaseForChange } from '../state/task-plan-store.js'
import { normalizeDeps } from '../state/tasks.js'
import { PHASES, type GuardContext, type PipelineState } from '../types.js'
import type { DependencyState, TasksThroughStepResult, UniversalGuardCapabilities } from './ir.js'
import { fieldStr } from './transition-field-scalar.js'

/** 文件面探针（`makeGuardFileContext` 的产物）；缺失的探针对应的能力不提供，guard 随之失败关闭。 */
export type UniversalGuardSource = Pick<
  GuardContext,
  'dirExists' | 'changeArchived' | 'activeChangeArchived' | 'automationRunner'
>

/** 依赖名要进目录路径，只接受任务名允许的字符；其余按「未结束」处理且不探测文件系统。 */
const DEPENDENCY_NAME = /^[A-Za-z0-9_-]+$/

async function currentFields(changeDir: string): Promise<PipelineState['fields']> {
  const revision = await readCurrentRunRevision(changeDir)
  if (revision === undefined) throw new Error('无法读取任务状态')
  return revision.state.fields
}

/**
 * 步骤 id 不是流水线阶段时没有对应的任务段（Todo 投影对未知阶段同样不设约束），视为完成。
 * 以 PHASES 做校验式收窄而不是类型断言：阶段表之外的 id 不会被当作阶段传给 TaskPlan 判定。
 */
function tasksThroughStep(changeDir: string): NonNullable<UniversalGuardCapabilities['tasksThroughStep']> {
  return async (step): Promise<TasksThroughStepResult> => {
    const phase = PHASES.find((candidate) => candidate === step)
    if (phase === undefined) return { complete: true, unchecked: [] }
    const verdict = await taskPlanTasksThroughPhaseForChange(changeDir, phase)
    if (verdict.pass) return { complete: true, unchecked: [] }
    return { complete: false, unchecked: [verdict.failure ?? `${step} 出口：tasks.md 未通过检查`] }
  }
}

function afkQueued(changeDir: string, automationRunner: boolean): NonNullable<UniversalGuardCapabilities['afkQueued']> {
  return async (): Promise<boolean> => {
    if (automationRunner) return false
    return fieldStr((await currentFields(changeDir)).automation) === 'queued'
  }
}

function dependencyStates(
  changeDir: string,
  probes: Required<Pick<UniversalGuardSource, 'dirExists' | 'changeArchived'>> & Pick<UniversalGuardSource, 'activeChangeArchived'>,
): NonNullable<UniversalGuardCapabilities['dependencyStates']> {
  const ended = (name: string): boolean => {
    if (!DEPENDENCY_NAME.test(name)) return false
    return probes.dirExists(`openspec/changes/${name}`)
      ? probes.activeChangeArchived?.(name) === true
      : probes.changeArchived(name)
  }
  return async (): Promise<readonly DependencyState[]> => {
    const fields = await currentFields(changeDir)
    return normalizeDeps(fields.depends_on)
      .filter((name) => name !== 'null')
      .map((name) => ({ name, ended: ended(name) }))
  }
}

/**
 * `changeDir` 是任务目录的绝对路径。`source` 缺省 = 宿主没有文件面：任务勾选与 AFK 排队只读任务目录与状态，
 * 照常提供（AFK 不当作调度器旁路）；依赖结束需要归档探针，缺失时不提供。
 */
export function universalGuardCapabilities(
  changeDir: string,
  source?: UniversalGuardSource,
): UniversalGuardCapabilities {
  const { dirExists, changeArchived } = source ?? {}
  return {
    tasksThroughStep: tasksThroughStep(changeDir),
    afkQueued: afkQueued(changeDir, source?.automationRunner === true),
    ...(dirExists === undefined || changeArchived === undefined
      ? {}
      : {
          dependencyStates: dependencyStates(changeDir, {
            dirExists,
            changeArchived,
            activeChangeArchived: source?.activeChangeArchived,
          }),
        }),
  }
}
