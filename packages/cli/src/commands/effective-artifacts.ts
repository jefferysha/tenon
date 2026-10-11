/**
 * 当前 change 有效（track-适用）的 artifact 字段集 —— G2 P6 set/cas cutover 与 P5 artifact register
 * 共用的 declaration 判定源（口径单一真相，避免 register 允许写的字段与 set/cas 拒写的字段漂移）。
 * 按 state 的 workflow/phase/track 判定：
 *   - workflow==='default'：P4 生成表 defaultArtifactsForStep(phase, track)（已过 requiredWhen）。
 *   - custom：loadWorkflow→compileWorkflow→resolveStep(phase)→step.artifacts 过 requiredWhen。
 *     必须查**编译后** StepIR.artifacts（compileWorkflow 会把已知 file_path output 派生成 artifact），
 *     不能只看 YAML 显式 artifacts。
 * workflow **文件缺失**（loadWorkflow 返 null，即 workflow 仅作 registry 名、无定义文件）→ 空集：无
 * artifact 声明可内省、无 file-artifact cutover（R2 里 track/workflow 仅作 registry 名时靠 checkTrackWorkflow
 * 组合校验，不该被此处 fail-loud 误伤）。workflow **损坏**（文件存在但 parse/compile 失败）/ step 不在图
 * → throw（fail-closed）：绝不降级放行，否则坏 workflow 反而绕过 cutover。调用方在 change 锁内调用、捕获
 * 异常转 exit 1。纯只读判定：不写 state、不校验 producer（producer 校验是 artifact register 的职责）。
 */
import {
  matchesTrackPredicate,
  resolveStep,
} from '@tenon/kernel'
import type { FieldName, PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { isLegacyExecution } from './execution-cli-seam.js'

/** 标量字段值（列表按逗号连接；缺键 → 空串）。只读 phase/track 两个标量。 */
function scalar(state: PipelineState, f: FieldName): string {
  const v = state.fields[f]
  return Array.isArray(v) ? v.join(',') : (v ?? '')
}

export function effectiveArtifactFields(deps: CliDeps, state: PipelineState): ReadonlySet<FieldName> {
  const workflow = effectiveWorkflowForState(deps, state)
  const stepId = scalar(state, 'phase')
  const track = scalar(state, 'track')
  if (!workflow) {
    // workflow 名无对应文件 → 无 artifact 声明可内省 → 空集（该 change 无 file-artifact cutover）。
    // 这不是「降级放行坏 workflow」：真正 corrupted 的文件（存在但解析/编译失败）走下面
    // compileWorkflow/resolveStep 的 fail-loud（throw → 调用方 exit 1）。workflow 仅作 registry 名
    // （无文件）时，set/cas track/workflow 由 checkTrackWorkflow 组合校验，不应被此处 fail-loud 误伤。
    return new Set()
  }
  const step = resolveStep(workflow.workflow, stepId)
  if (!step) {
    if (isLegacyExecution(workflow)) return new Set()
    throw new Error(`step '${stepId}' 不在 workflow '${workflow.id}' 里`)
  }
  return new Set(
    step.artifacts
      .filter((a) => a.requiredWhen === undefined || matchesTrackPredicate(a.requiredWhen, track))
      .map((a) => a.field),
  )
}
