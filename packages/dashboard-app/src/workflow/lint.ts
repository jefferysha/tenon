import type { WbEffectiveIo, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'

export type LintIssue =
  | { kind: 'step-no-output'; stepId: string }
  | { kind: 'input-not-upstream'; stepId: string; field: string }

/**
 * 编辑器保存前校验（kernel 校验之外的产品规则）：
 *   · 每个阶段至少一个输出（文档或值）；
 *   · 字段输入必须由更早阶段声明为输出。
 */
export function lintWorkflow(def: WbWorkflowDef, io: WbEffectiveIo | undefined): LintIssue[] {
  const issues: LintIssue[] = []
  def.steps.forEach((step, index) => {
    const outputs = io?.[step.id]?.outputs.length ?? step.outputs.length
    if (outputs === 0) issues.push({ kind: 'step-no-output', stepId: step.id })
    for (const input of step.inputs) {
      const upstream = def.steps.slice(0, index)
      if (!upstream.some((candidate) => candidate.outputs.some((output) => output.field === input.field))) {
        issues.push({ kind: 'input-not-upstream', stepId: step.id, field: input.field })
      }
    }
  })
  return issues
}

export function issuesFor(issues: readonly LintIssue[], stepId: string): LintIssue[] {
  return issues.filter((issue) => issue.stepId === stepId)
}

/**
 * 草稿（未保存）的物化 IO 近似：服务端只对已保存定义返回 effectiveIo；编辑中的定义在前端按同一规则
 * 重算字段槽位，文档槽位沿用已保存版本（契约固定的工作流）或从草稿 documentContract 推出。
 */
export function draftEffectiveIo(def: WbWorkflowDef, saved: WbEffectiveIo | undefined): WbEffectiveIo {
  const out: WbEffectiveIo = {}
  const lockedDocuments = def.openspecContract === 'required' || def.name === 'default'
  def.steps.forEach((step, index) => {
    const upstream = def.steps.slice(0, index)
    const downstream = def.steps.slice(index + 1)
    const documentsOut = lockedDocuments
      ? (saved?.[step.id]?.outputs ?? []).filter((slot) => slot.kind === 'document')
      : (def.documentContract?.slots ?? []).filter((slot) => slot.ownerStep === step.id).map((slot) => ({
          kind: 'document' as const,
          id: slot.kind,
          producers: slot.producers,
          consumers: (def.documentContract?.reads ?? []).filter((read) => read.kinds.includes(slot.kind)).map((read) => read.step),
          locked: false,
        }))
    const documentsIn = lockedDocuments
      ? (saved?.[step.id]?.inputs ?? []).filter((slot) => slot.kind === 'document')
      : ((def.documentContract?.reads ?? []).find((read) => read.step === step.id)?.kinds ?? []).map((kind) => ({
          kind: 'document' as const,
          id: kind,
          producers: [def.documentContract?.slots.find((slot) => slot.kind === kind)?.ownerStep ?? ''].filter(Boolean),
          consumers: [],
          locked: false,
        }))
    out[step.id] = {
      outputs: [
        ...documentsOut,
        ...step.outputs.map((output) => ({
          kind: 'field' as const,
          id: output.field,
          type: output.type,
          producer: null,
          consumers: downstream.filter((candidate) => candidate.inputs.some((input) => input.field === output.field)).map((candidate) => candidate.id),
        })),
      ],
      inputs: [
        ...documentsIn,
        ...step.inputs.map((input) => ({
          kind: 'field' as const,
          id: input.field,
          type: input.type,
          producer: [...upstream].reverse().find((candidate) => candidate.outputs.some((output) => output.field === input.field))?.id ?? null,
          consumers: [],
        })),
      ],
    }
  })
  return out
}

export function stepById(def: WbWorkflowDef, id: string): WbStepDef | undefined {
  return def.steps.find((step) => step.id === id)
}
