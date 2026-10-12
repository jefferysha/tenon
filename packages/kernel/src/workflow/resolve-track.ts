/**
 * M1 轨道解析：轨道只是工作流 YAML 里的 `tracks.<id>` 分支，身份是「工作流 + 轨道 id」。
 * 本模块是纯函数，建在 `workflowBranches` 之上，不另存任何登记表；init、`tenon tracks`、server、
 * 生效计划与文档治理都经它得到分支的步骤、规范、路由与自动化设置。
 *
 * 没有 `tracks:` 的平铺工作流只有一个隐式分支，对外的 `id` 就是工作流名。
 */
import { workflowBranches, type BranchedWorkflow } from './branches.js'
import type { StepIR } from './ir.js'
import type { TrackAutomation, TrackRoute, TrackSpec, WorkflowDocumentContractV1 } from './types.js'

export interface TrackBranch<S = StepIR> {
  /** 轨道 id；隐式分支用工作流名。 */
  readonly id: string
  readonly label: string
  readonly steps: readonly S[]
  /** 已折算：分支声明的 `spec`，没写时继承工作流顶层 `openspec`。 */
  readonly spec: TrackSpec
  /** 不写 `route` 的分支不参与自动路由，只能点名使用。 */
  readonly route?: TrackRoute
  /** 没写 `automation` 的分支不可进入 AFK（失败关闭）。 */
  readonly automation: TrackAutomation
  readonly documentContract?: WorkflowDocumentContractV1
  /** 平铺工作流的唯一分支。 */
  readonly implicit: boolean
}

/** 轨道不存在，或工作流有多条分支却没指定轨道。`available` 是当时全部可选轨道 id。 */
export class UnknownTrackError extends Error {
  readonly _tag = 'UnknownTrackError'
  readonly workflow: string
  readonly track: string
  readonly available: readonly string[]

  constructor(workflow: string, track: string, available: readonly string[]) {
    const choices = available.join(', ')
    super(track === ''
      ? `工作流 '${workflow}' 有多条轨道，须指定其中之一（可选：${choices}）`
      : `工作流 '${workflow}' 没有轨道 '${track}'（可选：${choices}）`)
    this.name = 'UnknownTrackError'
    this.workflow = workflow
    this.track = track
    this.available = available
  }
}

const NOT_AUTOMATED: TrackAutomation = Object.freeze({ eligible: false, enqueueAfterSpec: false })

/** `resolveTrack` 只读这几项：编译后的工作流、定义层与冻结快照里的定义（含旧版本）都满足。 */
export type TrackResolvable<S = StepIR> = BranchedWorkflow<S> & { readonly name: string }

/** 工作流的全部轨道，按声明顺序；平铺工作流只有一条隐式分支。 */
export function listTracks<S = StepIR>(workflow: TrackResolvable<S>): readonly TrackBranch<S>[] {
  return workflowBranches(workflow).map((branch) => resolveTrack(workflow, branch.implicit ? undefined : branch.track))
}

/**
 * 在已编译的工作流里解析一条轨道。
 * - 平铺工作流：`trackId` 省略、为空或等于工作流名 → 隐式分支；其余 → `UnknownTrackError`（可选项只有工作流名）。
 * - 有分支的工作流：按 id 取分支；省略或没有该 id → `UnknownTrackError`，`available` 列出全部分支 id。
 */
export function resolveTrack<S = StepIR>(workflow: TrackResolvable<S>, trackId?: string): TrackBranch<S> {
  const requested = trackId ?? ''
  const branches = workflowBranches(workflow)
  const implicit = branches.length === 1 && branches[0]?.implicit === true
  const found = implicit
    ? (requested === '' || requested === workflow.name ? branches[0] : undefined)
    : branches.find((branch) => requested !== '' && branch.track === requested)
  if (found === undefined) {
    throw new UnknownTrackError(workflow.name, requested, implicit ? [workflow.name] : branches.map((branch) => branch.track))
  }
  const id = found.implicit ? workflow.name : found.track
  return {
    id,
    label: found.label ?? id,
    steps: found.steps,
    spec: found.spec,
    ...(found.route === undefined ? {} : { route: found.route }),
    automation: found.automation ?? NOT_AUTOMATED,
    ...(found.documentContract === undefined ? {} : { documentContract: found.documentContract }),
    implicit: found.implicit,
  }
}

/**
 * 任务已记着轨道时的分支：有分支的工作流必须命中（和 `resolveTrack` 一样严格，不取第一条）；
 * 平铺工作流只有隐式分支，任务记的轨道（旧任务记着 `free`、工作流名或空）不参与选择。
 */
export function resolveRunTrack<S = StepIR>(workflow: TrackResolvable<S>, trackId: string | undefined): TrackBranch<S> {
  return Object.keys(workflow.tracks ?? {}).length === 0 ? resolveTrack(workflow) : resolveTrack(workflow, trackId)
}
