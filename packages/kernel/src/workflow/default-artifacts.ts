/**
 * default 工作流的 artifact 声明查询层（G2 P4/P5）：只读生成表 default-workflow.generated.ts，按 change 的
 * track 选中分支（`tracks.<id>`，否则通用分支 `_base`）后取该 step 的 file artifact 声明。
 *
 * 边界（codex P4 定稿 D5）：本层只读生成表并做分支选择；分支是完整 pipeline，不与通用分支叠加。
 * `requiredWhen` 保留为兼容过滑（分支化后的 default.yaml 已不再需要它）。
 */
import { matchesTrackPredicate, type TrackPredicate } from './predicates.js'
import type { FieldName } from '../types.js'
import type { ArtifactProducerPolicy } from './types.js'
import { DEFAULT_ARTIFACT_DECLARATIONS } from './default-workflow.generated.js'

export interface DefaultArtifactDeclaration {
  readonly kind: 'file'
  readonly field: FieldName
  readonly type: 'file_path'
  readonly producerPolicy: ArtifactProducerPolicy
  readonly requiredWhen?: TrackPredicate
}

type BranchTable = Readonly<Record<string, readonly DefaultArtifactDeclaration[]>>
const TABLE: Readonly<Record<string, BranchTable>> = DEFAULT_ARTIFACT_DECLARATIONS

/** track 命中 default 的某条分支 → 该分支的表；否则通用分支。 */
function branchTable(track: string): BranchTable {
  return TABLE[track] ?? TABLE._base ?? {}
}

/** default 某 step / track 适用的 file artifact 声明（只读）。 */
export function defaultArtifactsForStep(stepId: string, track: string): readonly DefaultArtifactDeclaration[] {
  const decls = branchTable(track)[stepId] ?? []
  return decls.filter((d) => d.requiredWhen === undefined || matchesTrackPredicate(d.requiredWhen, track))
}

/** 某 step/track 下某 field 的 artifact 声明；该分支该 step 无此 field 的 artifact → undefined。 */
export function defaultArtifactForField(
  stepId: string,
  field: FieldName,
  track: string,
): DefaultArtifactDeclaration | undefined {
  return defaultArtifactsForStep(stepId, track).find((d) => d.field === field)
}

/** 任一分支在该 step 声明过该 field 的 artifact（与 track 无关的「是否受 artifact 治理」判定）。 */
export function defaultArtifactDeclaredForField(stepId: string, field: FieldName): boolean {
  return Object.values(TABLE).some((branch) => (branch[stepId] ?? []).some((d) => d.field === field))
}
