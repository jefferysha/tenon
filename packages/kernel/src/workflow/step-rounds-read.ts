/**
 * 受上限约束的步骤当前是第几轮、上限多少、上限从哪来——从任务的转换记录读出来。
 *
 * 轮次取自 canonical 转换记录链（`recordStore.readChain` + `state.runMetadata`，只数当前 run）；没有转换记录链的
 * 旧任务退回读 `.pipeline-history.jsonl` 里的 `kind: transition` 行。只读，不写任何状态。
 * `tenon status` 的步骤块、`tenon review request` 与两个宿主（CLI、Dashboard 服务）的 transition 强制层读同一份实现。
 */
import type { PipelineState } from '../types.js'
import type { TransitionRecordStore } from '../state/transition-record-store.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import {
  currentRound, effectiveMaxRounds, isRoundsLimited, resolveMaxRounds, stepBackTargets,
  type MaxRoundsSource, type RoundTransition,
} from './step-rounds.js'

export interface StepRounds {
  /** 自上次清零以来进入本步的次数（含当前这次），至少为 1。 */
  readonly current: number
  readonly max: number
  readonly source: MaxRoundsSource
}

/**
 * 读取转换记录需要的能力。`recordStore` 在任务状态有 canonical 链头时必须装配（缺席抛错）；
 * 没有链头的旧任务才用 `readHistoryRaw` 读 JSONL，两者都缺席时按「此刻就在这一步」算第 1 轮。
 */
export interface StepRoundsReadDeps {
  readonly recordStore?: Pick<TransitionRecordStore, 'readChain'>
  readonly readHistoryRaw?: (changeDir: string) => Promise<string | undefined | null>
}

function scalar(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/**
 * canonical 链上的转换；没有链头（旧任务、刚建的 run）时返回 undefined，调用方退回读 JSONL。
 * 状态里有链头却没装配 recordStore 是接线错误，抛错而不退回 JSONL：JSONL 在这种任务上缺转换行（或被截断、删除）时
 * 会把轮次算得偏小，等于悄悄放过已经用完的上限（失败关闭）。
 */
async function chainTransitions(
  deps: StepRoundsReadDeps,
  dir: string,
  state: PipelineState,
): Promise<readonly RoundTransition[] | undefined> {
  const metadata = state.runMetadata
  if (metadata?.transitionHead === undefined) return undefined
  if (deps.recordStore === undefined) {
    throw new Error('无法计算验证轮次：缺少转换记录读取依赖（recordStore），而任务状态里有 canonical 转换记录链头；不退回读 .pipeline-history.jsonl')
  }
  const chain = await deps.recordStore.readChain(dir, metadata.transitionSequence, metadata.transitionHead, metadata.runId)
  return chain.map((record) => ({ to: record.to, runId: record.runId }))
}

/**
 * 旧任务的 JSONL 转换行。带 `transitionRecordId` 的行是某条 canonical 记录的兼容投影，那条链不属于
 * 当前 run（否则上面已经读到了），不能算进来；损坏的行与缺目标步骤的行跳过。
 */
async function historyTransitions(deps: StepRoundsReadDeps, dir: string): Promise<readonly RoundTransition[]> {
  const raw = (await deps.readHistoryRaw?.(dir)) ?? ''
  const rows: RoundTransition[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const to = Reflect.get(entry, 'to')
    if (Reflect.get(entry, 'kind') !== 'transition' || typeof to !== 'string' || to === '') continue
    if (Reflect.get(entry, 'transitionRecordId') !== undefined) continue
    rows.push({ to })
  }
  return rows
}

/**
 * 当前步骤的轮次；不受约束的步骤（没有评审门或没有回退边、不在计划里）返回 null，且不去读转换记录。
 * 任务此刻就在这一步：记录缺失或被清掉时，至少是第一轮。
 */
export async function readStepRounds(
  deps: StepRoundsReadDeps,
  dir: string,
  state: PipelineState,
  plan: Pick<EffectiveWorkflowPlan, 'executionModel' | 'workflow'>,
  stepId: string,
): Promise<StepRounds | null> {
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined || !isRoundsLimited(plan, stepId)) return null
  const transitions = await chainTransitions(deps, dir, state) ?? await historyTransitions(deps, dir)
  const entered = currentRound({
    stepId,
    steps: plan.workflow.steps.map((candidate) => candidate.id),
    backTargets: stepBackTargets(plan, stepId),
    transitions,
    runId: state.runMetadata?.runId ?? null,
  })
  const { max, source } = resolveMaxRounds(effectiveMaxRounds(step), scalar(state.fields.max_rounds))
  return { current: Math.max(1, entered), max, source }
}

/** 当前轮次已达到上限：不再自动回退。 */
export function roundsExhausted(rounds: Pick<StepRounds, 'current' | 'max'> | null | undefined): boolean {
  return rounds !== null && rounds !== undefined && rounds.current >= rounds.max
}
