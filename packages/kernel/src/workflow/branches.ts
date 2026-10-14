/**
 * 工作流分支的统一读取视图：定义层（WorkflowDef）与编译后的 IR 共用。
 *
 * 独立成叶子模块（只依赖类型），好让 validate.ts、resolve-track.ts 与 document-contract.ts 都能读分支而不互相成环。
 */
import type { StepDef, TrackAutomation, TrackRoute, TrackSpec, WorkflowDocumentContractV1 } from './types.js'

/** 一条分支的读取视图（定义层与编译后的 IR 共用，S 是步骤类型）。 */
export interface WorkflowBranch<S = StepDef> {
  /** 分支 id；没有 `tracks:` 的平铺工作流只有一个隐式分支，id 为 ''。 */
  readonly track: string
  readonly implicit: boolean
  readonly label?: string
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly S[]
  /** 已折算：分支声明的 `spec`；没写时取工作流顶层 `openspec`（true → openspec，否则 none）。 */
  readonly spec: TrackSpec
  readonly route?: TrackRoute
  readonly automation?: TrackAutomation
}

/** `workflowBranches` 接受的形状：WorkflowDef 与 WorkflowIR 都满足。 */
export interface BranchedWorkflow<S> {
  readonly openspec?: boolean
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly S[]
  /** 平铺工作流顶层的路由数据，成为隐式分支的 route。 */
  readonly route?: TrackRoute
  readonly tracks?: Readonly<Record<string, {
    readonly label?: string
    readonly documentContract?: WorkflowDocumentContractV1
    readonly steps: readonly S[]
    readonly spec?: TrackSpec
    readonly route?: TrackRoute
    readonly automation?: TrackAutomation
  }>>
}

/** 有 tracks 的工作流：分支 = 每条 track（key = track id，契约取分支自己的）；否则只有单条隐式 pipeline（key ''）。 */
export function workflowBranches<S>(wf: BranchedWorkflow<S>): ReadonlyArray<WorkflowBranch<S>> {
  const inherited: TrackSpec = wf.openspec === true ? 'openspec' : 'none'
  const tracks = Object.entries(wf.tracks ?? {})
  if (tracks.length === 0) {
    return [{
      track: '',
      implicit: true,
      ...(wf.documentContract === undefined ? {} : { documentContract: wf.documentContract }),
      steps: wf.steps,
      spec: inherited,
      ...(wf.route === undefined ? {} : { route: wf.route }),
    }]
  }
  return tracks.map(([track, branch]) => ({
    track,
    implicit: false,
    ...(branch.label === undefined ? {} : { label: branch.label }),
    ...(branch.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: branch.steps,
    spec: branch.spec ?? inherited,
    ...(branch.route === undefined ? {} : { route: branch.route }),
    ...(branch.automation === undefined ? {} : { automation: branch.automation }),
  }))
}
