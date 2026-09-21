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
 * 技能全部来自 manifest 叠加的 default 定义（step 自己不声明技能）：manifest-overlay 机制的单测
 * 用它做夹具——该机制仍服务冻结的老快照。
 */
export function legacyDefaultWorkflow(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  // 分支化之前 default 只有一条 pipeline：spec 的 plan artifact 带 PM 豁免谓词。用 frontend 分支（含其文档契约）还原它。
  const branch = def.tracks?.frontend
  const frontend = branch?.steps ?? def.steps
  return {
    ...def,
    tracks: undefined,
    ...(branch?.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: frontend.map((step) => ({
      ...step,
      skills: [],
      ...(step.id === 'spec' && step.artifacts !== undefined
        ? { artifacts: step.artifacts.map((artifact) => artifact.field === 'plan' ? { ...artifact, requiredWhen: { kind: 'track-not-in' as const, values: ['pm'] } } : artifact) }
        : {}),
    })),
  }
}
