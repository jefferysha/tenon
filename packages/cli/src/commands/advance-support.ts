import {
  GATE_TTL_MS,
  reviewGateApprovedFor,
  type GateKind,
  type Phase,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { EVENTS } from '../events.js'
import { changeDir } from '../paths.js'
import { cmdCheck } from './check.js'
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
