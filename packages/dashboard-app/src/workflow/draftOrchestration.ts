/**
 * 工作流页画的是编辑中的草稿：编排直接调 kernel 的 orchestrate（与服务端 buildOrchestration 同一个实现），
 * 技能只来自工作流 YAML 里的声明，没有任何机器级叠加，也就不必问服务端。
 */
import { useMemo } from 'react'
import { orchestrate, type WorkflowOrchestration } from '@tenon/kernel/workflow/orchestration'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { gateKind } from '../workbench/workbenchDefinition'

/** kernel `orchestrate` 可选的每步输出（文档流向 / OpenSpec 注入的来源）；草稿没有它，缺省即可。 */
type DraftIo = Parameters<typeof orchestrate>[0]['io']

export function draftOrchestration(def: WbWorkflowDef, io?: DraftIo): WorkflowOrchestration {
  // 与服务端编译同口径：gate null 就是自动。
  return orchestrate({ steps: def.steps.map((step) => ({ ...step, gate: gateKind(step.gate) })), ...(io === undefined ? {} : { io }) })
}

export function useDraftOrchestration(def: WbWorkflowDef | null, io?: DraftIo): WorkflowOrchestration | null {
  return useMemo(() => def === null ? null : draftOrchestration(def, io), [def, io])
}
