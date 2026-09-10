/**
 * workflow handler 单测共享基座（G2 P1）——guard-handlers.test.ts 与 action-handlers.test.ts
 * 曾各持一份的全字段 fixture 收拢为单一来源。零 vitest 依赖（同 packages/cli/src/test-support.ts
 * 先例），tsc 正常编译、不进任何运行时路径。
 */
import { FIELD_ORDER, LIST_FIELDS, type FieldName } from '../types.js'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { parseWorkflow } from './parse.js'
import type { WorkflowDef } from './types.js'

const LIST_FIELD_SET: ReadonlySet<string> = new Set<string>(LIST_FIELDS)

/** 全字段初始化，over 覆盖。基底对齐真实 PipelineState 形状（flow/flow.test.ts 同款口径）：
 *  列表字段（LIST_FIELDS）→ []、标量字段 → ''——scalar guard 若误读列表字段会在 fixture 上
 *  立刻炸出（guard-handlers.ts 的数组读值 fail-loud），而不是被 '' 掩过。 */
export function allFields(
  over: Partial<Record<FieldName, string | string[]>> = {},
): Record<FieldName, string | string[]> {
  const fields = {} as Record<FieldName, string | string[]>
  for (const k of FIELD_ORDER) fields[k] = LIST_FIELD_SET.has(k) ? [] : ''
  return { ...fields, ...over }
}

/**
 * 2026-09 技能合一之前的 default 定义（技能矩阵仍在机器级 manifest、YAML 只有 tenon-* 驱动技能）：
 * 只保留无轨道条件的 tenon-* 驱动技能即得。manifest-overlay 机制的单测用它做夹具——该机制仍服务冻结的老快照。
 */
export function legacyDefaultWorkflow(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  return {
    ...def,
    steps: def.steps.map((step) => ({ ...step, skills: step.skills.filter((skill) => skill.when === undefined && skill.id.startsWith('tenon-')) })),
  }
}
