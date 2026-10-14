import {
  GATE_TTL_MS,
  reviewGateApprovedFor,
  type GateKind,
  type Phase,
} from '@tenon/kernel'
import type { EffectiveWorkflowPlan, StepIR, StepTransitionIR } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { EVENTS } from '../events.js'
import { changeDir } from '../paths.js'
import { cmdCheck } from './check.js'
import { advancingExits } from './exitGuards.js'
import { cmdTransition } from './transition.js'

export interface AdvanceOpts {
  maxSteps?: number
  dryRun?: boolean
  throughGates?: boolean
}

const HARD_GATES: readonly GateKind[] = ['confirm', 'interaction']

export interface ForwardStep {
  event: string
  to: Phase
}

export function forwardStep(deps: CliDeps, current: string): ForwardStep | undefined {
  const phases = deps.flow.manifest.phases
  const index = phases.indexOf(current as Phase)
  if (index < 0) return undefined
  const targets = deps.flow.manifest.transitions[current as Phase] ?? []
  const target = targets.find((candidate) => phases.indexOf(candidate) > index)
  if (target === undefined) return undefined
  const entry = Object.entries(EVENTS).find(([, event]) => {
    return event.from === current && event.to === target
  })
  return entry ? { event: entry[0], to: target } : undefined
}

/**
 * 步骤图任务自动推进可走的出口 = 前进出边（不含回退边与放弃边，判定见 exitGuards.ts）。回退边与放弃边是人工决定，
 * 只在显式 `tenon transition` 时走；没有前进出边的 step 走 kernel 推导的隐式完成边 `archived`，进入这类 step 不等于
 * 运行完成。`completion` 是 exits 里 step 没声明过的那条（隐式完成边），调用方据此判断「这一步完成并归档了运行」。
 * `others` 是该步还有的、不会自动走的出边事件（回退 / 放弃），没有前进出边时拿来告诉人下一步能选什么。
 */
export function graphExits(
  plan: EffectiveWorkflowPlan,
  step: StepIR,
): { readonly exits: readonly StepTransitionIR[]; readonly completion?: StepTransitionIR; readonly others: readonly string[] } {
  const exits = advancingExits(plan, step)
  const completion = exits.find((transition) => !step.transitions.includes(transition))
  const others = step.transitions.filter((transition) => !exits.includes(transition)).map((transition) => transition.event)
  return completion === undefined ? { exits, others } : { exits, completion, others }
}

/** 没有前进出边时的停点说明：真正的终态，或只剩回退 / 放弃出边（人选 event）。 */
export function noAdvancingExitLine(prefix: string, others: readonly string[], terminal: string): string {
  return others.length === 0
    ? `${prefix}${terminal}`
    : `${prefix}没有可自动走的前进出边，其余出边需人选 event（HITL），手动 transition 其一：${others.join(', ')}`
}

export async function freshHardGate(deps: CliDeps): Promise<GateKind | undefined> {
  const markers = (await deps.readGateMarkers?.()) ?? []
  for (const marker of markers) {
    if (HARD_GATES.includes(marker.kind) && marker.ageMs <= GATE_TTL_MS[marker.kind]) {
      return marker.kind
    }
  }
  return undefined
}

export async function guardQuietly(
  deps: CliDeps,
  name: string,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const isolated: CliDeps = {
    ...deps,
    io: {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    },
  }
  const code = await cmdCheck(isolated, name)
  return { code, lines }
}

export async function transitionQuietly(
  deps: CliDeps,
  name: string,
  event: string,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const isolated: CliDeps = {
    ...deps,
    io: {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    },
  }
  const code = await cmdTransition(isolated, name, event)
  return { code, lines }
}

export function isReviewPhase(deps: CliDeps, phase: string): boolean {
  return (deps.flow.manifest.reviewPhases as readonly string[]).includes(phase)
}

export async function approvedReviewReceipt(
  deps: CliDeps,
  name: string,
  phase: string,
  event: string,
): Promise<boolean | null> {
  try {
    const state = await deps.store.read(changeDir(deps.cwd, name))
    return reviewGateApprovedFor(state, phase, event)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return null
  }
}

export function reviewReceiptStop(
  deps: CliDeps,
  name: string,
  phase: string,
  event: string,
  dryRun = false,
): void {
  const target = dryRun ? phase : `${name} @ ${phase}`
  const prefix = dryRun ? '  预计停在' : '[STOP]'
  deps.io.out(
    `${prefix} ${target}: review 出口 event '${event}' 尚无人工确认回执；先完成 check 并运行 ` +
      `tenon review request ${name} --event ${event}，` +
      `等用户确认（回复“确认继续”，或在 Dashboard 确认，或由用户本人在自己的终端运行 tenon review acknowledge ${name}；` +
      'agent 不得代为执行）',
  )
}
