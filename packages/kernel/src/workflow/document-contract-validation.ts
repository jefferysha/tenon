import type { WorkflowDef } from './types.js'
import {
  DOCUMENT_CONTRACT_PHASES,
  isDocumentKind,
  type DocumentContractPhase,
  type DocumentKind,
} from './document-contract-model.js'

const CANONICAL_TRANSITIONS: Readonly<Record<DocumentContractPhase, readonly DocumentContractPhase[]>> = {
  open: ['explore'],
  explore: ['spec'],
  spec: ['build'],
  build: ['verify', 'spec'],
  verify: ['ship', 'build'],
  ship: ['archive'],
  archive: [],
}

const REVIEW_PHASES: ReadonlySet<DocumentContractPhase> = new Set(['explore', 'spec', 'verify'])

const REQUIRED_RUNTIME_REFS: Readonly<Partial<Record<DocumentContractPhase, {
  readonly inputs?: readonly { readonly field: string; readonly type: string }[]
  readonly outputs?: readonly { readonly field: string; readonly type: string }[]
}>>> = {
  build: { outputs: [{ field: 'build_sha', type: 'string' }] },
  verify: {
    inputs: [{ field: 'build_sha', type: 'string' }],
    outputs: [{ field: 'verification_report', type: 'file_path' }],
  },
}

const REQUIRED_SKILL_GROUPS: Readonly<Record<DocumentContractPhase, readonly {
  readonly label: string
  readonly alternatives: readonly string[]
}[]>> = {
  open: [
    { label: 'OpenSpec proposal', alternatives: ['openspec-propose', 'opsx:propose'] },
    { label: 'pipeline open', alternatives: ['tenon-open', 'tenon:tenon-open'] },
  ],
  explore: [
    { label: 'pipeline explore', alternatives: ['tenon-explore', 'tenon:tenon-explore'] },
    { label: 'Superpower brainstorming', alternatives: ['brainstorming', 'superpowers:brainstorming'] },
  ],
  spec: [
    { label: 'tenon spec', alternatives: ['tenon-spec', 'tenon:tenon-spec'] },
    { label: 'OpenSpec delta proposal', alternatives: ['openspec-propose', 'opsx:propose'] },
    { label: 'Superpower plan', alternatives: ['writing-plans', 'superpowers:writing-plans'] },
  ],
  build: [{ label: 'pipeline build', alternatives: ['tenon-build', 'tenon:tenon-build'] }],
  verify: [
    { label: 'pipeline verify', alternatives: ['tenon-verify', 'tenon:tenon-verify'] },
    {
      label: 'Superpower verification',
      alternatives: ['verification-before-completion', 'superpowers:verification-before-completion'],
    },
  ],
  ship: [
    { label: 'pipeline ship', alternatives: ['tenon-ship', 'tenon:tenon-ship'] },
    { label: 'OpenSpec apply', alternatives: ['openspec-apply-change', 'opsx:apply'] },
  ],
  archive: [{ label: 'pipeline archive', alternatives: ['tenon-archive', 'tenon:tenon-archive'] }],
}

/** 技能 id 的等价写法：tenon:/superpowers: 命名空间前缀、OpenSpec 的 opsx 别名。 */
export function aliasesForSkill(id: string): readonly string[] {
  const aliases = new Set<string>([id])
  if (id.startsWith('tenon:')) aliases.add(id.slice('tenon:'.length))
  if (id.startsWith('superpowers:')) aliases.add(id.slice('superpowers:'.length))
  if (id === 'opsx:propose') aliases.add('openspec-propose')
  if (id === 'openspec-propose') aliases.add('opsx:propose')
  if (id === 'opsx:apply') aliases.add('openspec-apply-change')
  if (id === 'openspec-apply-change') aliases.add('opsx:apply')
  return [...aliases]
}

function hasFieldRef(
  refs: readonly { readonly field: string; readonly type: string }[],
  required: { readonly field: string; readonly type: string },
): boolean {
  return refs.some((ref) => ref.field === required.field && ref.type === required.type)
}

function readerReachableWithoutOwner(
  workflow: WorkflowDef,
  ownerStep: string,
  readerStep: string,
): boolean {
  const entry = workflow.steps[0]
  if (!entry || entry.id === ownerStep) return false
  const steps = new Map(workflow.steps.map((step) => [step.id, step]))
  const visited = new Set<string>()
  const queue = [entry.id]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || current === ownerStep || visited.has(current)) continue
    if (current === readerStep) return true
    visited.add(current)
    for (const transition of steps.get(current)?.transitions ?? []) {
      if (transition.to !== ownerStep && !visited.has(transition.to)) queue.push(transition.to)
    }
  }
  return false
}

function validateLegacyContract(workflow: WorkflowDef): readonly string[] {
  const errors: string[] = []
  const actualIds = workflow.steps.map((step) => step.id)
  if (actualIds.length !== DOCUMENT_CONTRACT_PHASES.length) {
    errors.push(`openspec_contract: required 必须恰好声明 ${DOCUMENT_CONTRACT_PHASES.length} 个标准阶段`)
  }
  for (const [index, expected] of DOCUMENT_CONTRACT_PHASES.entries()) {
    const actual = actualIds[index]
    if (actual !== expected) {
      errors.push(`openspec_contract: required 的第 ${index + 1} 阶段必须是 '${expected}'（当前 '${actual ?? '缺失'}'）`)
    }
  }
  for (const phase of DOCUMENT_CONTRACT_PHASES) {
    const step = workflow.steps.find((candidate) => candidate.id === phase)
    if (!step) continue
    for (const target of CANONICAL_TRANSITIONS[phase]) {
      if (!step.transitions.some((transition) => transition.to === target)) {
        errors.push(`openspec_contract: required 要求 '${phase}' 可转换到 '${target}'`)
      }
    }
    if (REVIEW_PHASES.has(phase) && step.gate !== 'review') {
      errors.push(`openspec_contract: required 要求 '${phase}' 的 gate=review`)
    }
    for (const group of REQUIRED_SKILL_GROUPS[phase]) {
      const satisfied = step.skills.some((skill) => {
        const aliases = new Set(aliasesForSkill(skill.id))
        return group.alternatives.some((candidate) => aliasesForSkill(candidate).some((alias) => aliases.has(alias)))
      })
      if (!satisfied) {
        errors.push(
          `openspec_contract: required 要求 '${phase}' 声明 ${group.label} skill（允许: ${group.alternatives.join(' | ')}）`,
        )
      }
    }
    const runtimeRefs = REQUIRED_RUNTIME_REFS[phase]
    for (const required of runtimeRefs?.inputs ?? []) {
      if (!hasFieldRef(step.inputs, required)) {
        errors.push(
          `openspec_contract: required 要求 '${phase}' 声明 input '${required.field}'（type=${required.type}）以读取构建基线`,
        )
      }
    }
    for (const required of runtimeRefs?.outputs ?? []) {
      if (!hasFieldRef(step.outputs, required)) {
        errors.push(
          `openspec_contract: required 要求 '${phase}' 声明 output '${required.field}'（type=${required.type}）以留下可验证证据`,
        )
      }
    }
  }
  return errors
}

function validateDeclarativeContract(workflow: WorkflowDef): readonly string[] {
  const contract = workflow.documentContract
  if (!contract) return []
  const errors: string[] = []
  if (workflow.openspecContract !== undefined) {
    errors.push('openspec_contract 与 document_contract 不得同时声明')
  }
  const stepIds = new Set(workflow.steps.map((step) => step.id))
  const kinds = new Set<DocumentKind>()
  for (const [index, slot] of contract.slots.entries()) {
    if (!isDocumentKind(slot.kind)) {
      errors.push(`document_contract.slots[${index}].kind '${slot.kind}' 不受支持`)
      continue
    }
    if (kinds.has(slot.kind)) {
      errors.push(`document_contract document kind '${slot.kind}' 只能声明一个 owner_step`)
    }
    kinds.add(slot.kind)
    if (!stepIds.has(slot.ownerStep)) {
      errors.push(`document_contract document '${slot.kind}' 的 owner_step '${slot.ownerStep}' 不存在`)
    }
    if (slot.producers.length === 0) {
      errors.push(`document_contract document '${slot.kind}' 的 producers 不得为空`)
    }
    const ownerSkills = workflow.steps.find((step) => step.id === slot.ownerStep)?.skills.map((skill) => skill.id) ?? []
    for (const producer of slot.producers) {
      if (!ownerSkills.some((skill) => {
        const aliases = new Set(aliasesForSkill(skill))
        return aliasesForSkill(producer).some((alias) => aliases.has(alias))
      })) {
        errors.push(
          `document_contract document '${slot.kind}' 的 producer '${producer}' 未在 owner_step '${slot.ownerStep}' 声明`,
        )
      }
    }
  }
  const readSteps = new Set<string>()
  for (const [index, read] of contract.reads.entries()) {
    if (!stepIds.has(read.step)) {
      errors.push(`document_contract.reads[${index}].step '${read.step}' 不存在`)
      continue
    }
    if (readSteps.has(read.step)) {
      errors.push(`document_contract step '${read.step}' 只能声明一组 reads`)
    }
    readSteps.add(read.step)
    for (const rawKind of read.kinds) {
      if (!isDocumentKind(rawKind) || !kinds.has(rawKind)) {
        errors.push(`document_contract step '${read.step}' 读取了未声明的 document '${rawKind}'`)
        continue
      }
      const owner = contract.slots.find((slot) => slot.kind === rawKind)
      if (owner?.ownerStep === read.step) {
        errors.push(`document_contract step '${read.step}' 只能读取更早 step 产出的 '${rawKind}'`)
      } else if (owner && readerReachableWithoutOwner(workflow, owner.ownerStep, read.step)) {
        errors.push(
          `document_contract document '${rawKind}' 的 owner_step '${owner.ownerStep}' 不支配 reader step '${read.step}'`,
        )
      }
    }
  }
  return errors
}

/**
 * default 项目覆盖文件（`.pipeline/workflows/default.yaml`）的结构契约：七阶段及顺序、规范流转边、
 * 评审门禁、build/verify 的运行时字段引用。不检查 REQUIRED_SKILL_GROUPS——内建模板本身只声明
 * `tenon-*` 驱动技能，技能矩阵由 manifest 叠加；覆盖文件可以自由增删技能，但不能改动 phase-manifest
 * 运行模型赖以成立的骨架。
 */
export function validateDefaultWorkflowStructure(workflow: WorkflowDef): readonly string[] {
  const errors: string[] = []
  const actualIds = workflow.steps.map((step) => step.id)
  if (actualIds.length !== DOCUMENT_CONTRACT_PHASES.length) {
    errors.push(`default 必须恰好声明 ${DOCUMENT_CONTRACT_PHASES.length} 个标准阶段`)
  }
  for (const [index, expected] of DOCUMENT_CONTRACT_PHASES.entries()) {
    const actual = actualIds[index]
    if (actual !== expected) {
      errors.push(`default 的第 ${index + 1} 阶段必须是 '${expected}'（当前 '${actual ?? '缺失'}'）`)
    }
  }
  for (const phase of DOCUMENT_CONTRACT_PHASES) {
    const step = workflow.steps.find((candidate) => candidate.id === phase)
    if (!step) continue
    for (const target of CANONICAL_TRANSITIONS[phase]) {
      if (!step.transitions.some((transition) => transition.to === target)) {
        errors.push(`default 要求 '${phase}' 可转换到 '${target}'`)
      }
    }
    if (REVIEW_PHASES.has(phase) && step.gate !== 'review') {
      errors.push(`default 要求 '${phase}' 的 gate=review`)
    }
    const runtime = REQUIRED_RUNTIME_REFS[phase]
    for (const required of runtime?.inputs ?? []) {
      if (!step.inputs.some((ref) => ref.field === required.field && ref.type === required.type)) {
        errors.push(`default 要求 '${phase}' 声明 input ${required.field}:${required.type}`)
      }
    }
    for (const required of runtime?.outputs ?? []) {
      if (!step.outputs.some((ref) => ref.field === required.field && ref.type === required.type)) {
        errors.push(`default 要求 '${phase}' 声明 output ${required.field}:${required.type}`)
      }
    }
  }
  return errors
}

/** Strict structural validation for a custom workflow declaring either governance profile. */
export function validateOpenSpecContractWorkflow(workflow: WorkflowDef): readonly string[] {
  return workflow.openspecContract === 'required'
    ? validateLegacyContract(workflow)
    : validateDeclarativeContract(workflow)
}
