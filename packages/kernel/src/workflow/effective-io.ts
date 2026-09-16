/**
 * 物化每个 step 的输入 / 输出槽位——把工作流定义里两处并行的声明合成一份给 Dashboard / CLI 渲染：
 *   · 字段槽位：`step.inputs / step.outputs`（FieldRef）；producer = 最近一个把该字段列为 output 的上游 step，
 *     consumers = 把该字段列为 input 的下游 steps。
 *   · 文档槽位：`documentGovernancePolicy` 的 produce / update（输出）与 read / require（输入）；
 *     scope 由文档类型决定（design-md 是项目文档）。
 * 纯函数、无 I/O；不改变任何运行时判定，只是展示面的单一真相。
 */
import {
  DOCUMENT_KIND_CATALOG,
  documentGovernancePolicy,
  type DocumentKind,
  type DocumentScope,
} from './document-contract.js'
import type { FieldType, WorkflowDef } from './types.js'

export interface WorkflowDocumentSlotIo {
  readonly kind: 'document'
  readonly id: string
  /** 输出：produce | update；输入：read | require。 */
  readonly role: 'produce' | 'update' | 'read' | 'require'
  readonly scope: DocumentScope
  /** 输出：候选技能；read：[产出它的上游 step id]；require：[]。 */
  readonly producers: readonly string[]
  /** 读取或要求该文档的下游 step id。 */
  readonly consumers: readonly string[]
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

export function materializeWorkflowIo(def: WorkflowDef): WorkflowEffectiveIo {
  const policy = documentGovernancePolicy(def.name, def)
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
  function documentConsumers(kind: DocumentKind, after: number): string[] {
    if (!policy) return []
    return steps.slice(after + 1)
      .filter((candidate) => (policy.readsByStep[candidate.id] ?? []).includes(kind)
        || (policy.requiresByStep?.[candidate.id] ?? []).includes(kind))
      .map((s) => s.id)
  }
  /** The produce step; a project document without one is sourced from the nearest earlier update. */
  function documentSourceStep(kind: DocumentKind, before: number): string | null {
    if (!policy) return null
    const owner = policy.steps.find((stepId) => (policy.outputsByStep[stepId] ?? []).some((requirement) => requirement.kind === kind))
    if (owner !== undefined) return owner
    for (let i = before - 1; i >= 0; i -= 1) {
      const candidate = steps[i]?.id
      if (candidate !== undefined && (policy.mutableByStep[candidate] ?? []).some((requirement) => requirement.kind === kind)) return candidate
    }
    return null
  }
  function documentSlot(
    id: DocumentKind,
    role: WorkflowDocumentSlotIo['role'],
    producers: readonly string[],
    consumers: readonly string[],
  ): WorkflowDocumentSlotIo {
    return { kind: 'document', id, role, scope: DOCUMENT_KIND_CATALOG[id].scope, producers, consumers }
  }

  steps.forEach((step, index) => {
    const outputs: WorkflowIoSlot[] = []
    const inputs: WorkflowIoSlot[] = []
    for (const requirement of policy?.outputsByStep[step.id] ?? []) {
      outputs.push(documentSlot(requirement.kind, 'produce', [...requirement.producerCandidates], documentConsumers(requirement.kind, index)))
    }
    for (const requirement of policy?.mutableByStep[step.id] ?? []) {
      outputs.push(documentSlot(requirement.kind, 'update', [...requirement.producerCandidates], documentConsumers(requirement.kind, index)))
    }
    for (const output of step.outputs) {
      outputs.push({ kind: 'field', id: output.field, type: output.type, producer: null, consumers: fieldConsumers(output.field, index) })
    }
    for (const kind of policy?.readsByStep[step.id] ?? []) {
      const owner = documentSourceStep(kind, index)
      inputs.push(documentSlot(kind, 'read', owner === null ? [] : [owner], []))
    }
    for (const kind of policy?.requiresByStep?.[step.id] ?? []) {
      inputs.push(documentSlot(kind, 'require', [], []))
    }
    for (const input of step.inputs) {
      inputs.push({ kind: 'field', id: input.field, type: input.type, producer: fieldProducer(input.field, index), consumers: [] })
    }
    out[step.id] = { inputs, outputs }
  })
  return out
}
