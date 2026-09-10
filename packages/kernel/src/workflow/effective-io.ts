/**
 * 物化每个 step 的输入 / 输出槽位——把工作流定义里两处并行的声明合成一份给 Dashboard / CLI 渲染：
 *   · 字段槽位：`step.inputs / step.outputs`（FieldRef）；producer = 最近一个把该字段列为 output 的上游 step，
 *     consumers = 把该字段列为 input 的下游 steps。
 *   · 文档槽位：`documentGovernancePolicy` 的 outputsByStep（owner）/ readsByStep（reads）；
 *     `locked` = 契约固定（default 或 openspec_contract: required），编辑器不得增删。
 * 纯函数、无 I/O；不改变任何运行时判定，只是展示面的单一真相。
 */
import { documentGovernancePolicy } from './document-contract.js'
import type { FieldType, WorkflowDef } from './types.js'

export interface WorkflowDocumentSlotIo {
  readonly kind: 'document'
  readonly id: string
  readonly producers: readonly string[]
  /** 读取该文档的下游 step id（含 owner 之后的所有声明 reads 的 step）。 */
  readonly consumers: readonly string[]
  readonly locked: boolean
}

export interface WorkflowFieldSlotIo {
  readonly kind: 'field'
  readonly id: string
  readonly type: FieldType
  /** 输出槽位上为 null；输入槽位上为产出它的上游 step id，找不到时为 null。 */
  readonly producer: string | null
  readonly consumers: readonly string[]
}

export type WorkflowIoSlot = WorkflowDocumentSlotIo | WorkflowFieldSlotIo

export interface WorkflowStepIo {
  readonly inputs: readonly WorkflowIoSlot[]
  readonly outputs: readonly WorkflowIoSlot[]
}

export type WorkflowEffectiveIo = Readonly<Record<string, WorkflowStepIo>>

export function documentSlotsLocked(def: Pick<WorkflowDef, 'name' | 'openspecContract'>): boolean {
  return def.name === 'default' || def.openspecContract === 'required'
}

export function materializeWorkflowIo(def: WorkflowDef): WorkflowEffectiveIo {
  const policy = documentGovernancePolicy(def.name, def)
  const locked = documentSlotsLocked(def)
  const steps = def.steps
  const out: Record<string, WorkflowStepIo> = {}

  function fieldProducer(field: string, before: number): string | null {
    for (let i = before - 1; i >= 0; i -= 1) {
      const candidate = steps[i]
      if (candidate?.outputs.some((output) => output.field === field)) return candidate.id
    }
    return null
  }
  function fieldConsumers(field: string, after: number): string[] {
    return steps.slice(after + 1).filter((candidate) => candidate.inputs.some((input) => input.field === field)).map((s) => s.id)
  }
  function documentConsumers(kind: string, after: number): string[] {
    if (!policy) return []
    return steps.slice(after + 1).filter((candidate) => (policy.readsByStep[candidate.id] ?? []).includes(kind as never)).map((s) => s.id)
  }
  function documentProducerStep(kind: string): string | null {
    if (!policy) return null
    for (const stepId of policy.steps) {
      if ((policy.outputsByStep[stepId] ?? []).some((requirement) => requirement.kind === kind)) return stepId
    }
    return null
  }

  steps.forEach((step, index) => {
    const outputs: WorkflowIoSlot[] = []
    const inputs: WorkflowIoSlot[] = []
    for (const requirement of policy?.outputsByStep[step.id] ?? []) {
      outputs.push({
        kind: 'document',
        id: requirement.kind,
        producers: [...requirement.producerCandidates],
        consumers: documentConsumers(requirement.kind, index),
        locked,
      })
    }
    for (const output of step.outputs) {
      outputs.push({ kind: 'field', id: output.field, type: output.type, producer: null, consumers: fieldConsumers(output.field, index) })
    }
    for (const kind of policy?.readsByStep[step.id] ?? []) {
      const owner = documentProducerStep(kind)
      inputs.push({
        kind: 'document',
        id: kind,
        producers: owner === null ? [] : [owner],
        consumers: [],
        locked,
      })
    }
    for (const input of step.inputs) {
      inputs.push({ kind: 'field', id: input.field, type: input.type, producer: fieldProducer(input.field, index), consumers: [] })
    }
    out[step.id] = { inputs, outputs }
  })
  return out
}
