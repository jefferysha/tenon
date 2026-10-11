/**
 * 自定义工作流里 loop 的 phases 怎么解析成 StepIR，以及逐分支求值 skill wiring。
 *
 * 带 `tracks:` 的工作流顶层没有 steps，步骤在分支里。loop 自己不选分支（真正跑的是任务所在轨道的
 * 分支，运行时坐标按任务的冻结计划取它自己分支的步骤），所以静态核对只看能进 AFK
 * （`automation.eligible`）的分支，绝不取「第一条」；其中每一条都必须声明 loop 的全部 phases，
 * 缺一条整个 loop 不通过——任务可能走进任何一条可进 AFK 的分支，不能因别的分支齐全就放行。
 */
import { listTracks, type LoopEntry, type resolveStep, type WorkflowIR } from '@tenon/kernel'
import type {
  SkillBundleWiringDeps,
  SkillBundleWiringResolutionInput,
  SkillBundleWiringResult,
} from '../skills/wiring.js'

/** 一份 loop phases 的解析计划：`track` 为 null = 平铺工作流 / default 的固定 loop 轨道，不另标轨道。 */
export interface PhaseInputs {
  readonly track: string | null
  readonly inputs: readonly SkillBundleWiringResolutionInput[]
}

export type CustomPhaseResolution =
  | { readonly ok: true; readonly branches: readonly PhaseInputs[] }
  | { readonly ok: false; readonly reason: string }

/** 平铺工作流的 phases 就是它自己的 steps；带 tracks 的按上面的规则逐条分支解析。 */
export function resolveCustomPhases(
  compiled: WorkflowIR,
  workflowId: string,
  phases: readonly string[],
  findStep: typeof resolveStep,
): CustomPhaseResolution {
  if (Object.keys(compiled.tracks ?? {}).length === 0) {
    const inputs: SkillBundleWiringResolutionInput[] = []
    for (const phase of phases) {
      const step = findStep(compiled, phase)
      if (step === null) {
        return { ok: false, reason: `loop phase/step "${phase}" 未在 custom workflow "${workflowId}" 中声明` }
      }
      inputs.push({ kind: 'custom', step })
    }
    return { ok: true, branches: [{ track: null, inputs }] }
  }
  const eligible = listTracks(compiled).filter((branch) => branch.automation.eligible)
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: `custom workflow "${workflowId}" 没有可进入 AFK 的轨道（没有分支声明 automation.eligible: true）`,
    }
  }
  const branches: PhaseInputs[] = []
  const incomplete: string[] = []
  for (const branch of eligible) {
    const inputs: SkillBundleWiringResolutionInput[] = []
    const missing: string[] = []
    for (const phase of phases) {
      const step = findStep({ steps: branch.steps }, phase)
      if (step === null) missing.push(`"${phase}"`)
      else inputs.push({ kind: 'custom', step })
    }
    if (missing.length === 0) branches.push({ track: branch.id, inputs })
    else incomplete.push(`轨道 '${branch.id}' 缺 ${missing.join(', ')}`)
  }
  if (incomplete.length > 0) {
    return {
      ok: false,
      reason: `custom workflow "${workflowId}" 里每条可进入 AFK 的轨道都必须声明 loop 的全部 phases/steps：${incomplete.join('；')}`,
    }
  }
  return { ok: true, branches }
}

type EvaluateSkillWiring = (
  loop: LoopEntry,
  deps: SkillBundleWiringDeps,
  resolutionInputs?: readonly SkillBundleWiringResolutionInput[],
) => Promise<SkillBundleWiringResult>

/** 逐条分支求值：第一条没通过的原样返回（带轨道名），全部通过则返回最后一份 ready 结果。 */
export async function evaluateAcrossBranches(
  loop: LoopEntry,
  skillDeps: SkillBundleWiringDeps,
  branches: readonly PhaseInputs[],
  evaluate: EvaluateSkillWiring,
): Promise<SkillBundleWiringResult> {
  let last: SkillBundleWiringResult | undefined
  for (const branch of branches) {
    const result = await evaluate(loop, skillDeps, branch.inputs)
    if (result.status !== 'ready') {
      return branch.track === null || result.reason === null
        ? result
        : { ...result, reason: `轨道 '${branch.track}'：${result.reason}` }
    }
    last = result
  }
  return last ?? { status: 'invalid', bundleId: loop.skill_bundle_id ?? null, reason: '没有可求值的 workflow 分支' }
}
