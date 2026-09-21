import type { WbEffectiveIo, WbIoSlot, WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
import { DOCUMENT_CHAIN_PAIRS, DOCUMENT_KIND_CATALOG, isDocumentKind } from '@tenon/kernel/workflow/document-contract-model'
import { skillsEquivalent } from './producers'

type LintKind =
  | { kind: 'step-no-output'; stepId: string }
  | { kind: 'input-not-upstream'; stepId: string; field: string }
  | { kind: 'transition-empty-event'; stepId: string }
  | { kind: 'transition-duplicate-event'; stepId: string; event: string }
  | { kind: 'transition-contract-required'; stepId: string; to: string }
  | { kind: 'transition-not-next-or-back'; stepId: string; event: string; to: string }
  | { kind: 'document-producer-missing'; stepId: string; document: string; skill: string }
  | { kind: 'document-order'; stepId: string; document: string }
  | { kind: 'document-chain-gap'; stepId: string; document: string; missing: string }
  | { kind: 'test-id-duplicate'; stepId: string; test: string }
  | { kind: 'test-command-empty'; stepId: string; test: string }
  | { kind: 'test-output-location'; stepId: string; test: string; path: string }
  | { kind: 'agent-missing'; stepId: string; agent: string }

/** error 挡保存（与 kernel 校验一致）；warning 只在导航上标点。 */
export type LintIssue = LintKind & { severity: 'error' | 'warning' }

/**
 * default 必须保留的转移（与 kernel 的 CANONICAL_TRANSITIONS 逐条对齐）。包含两条回流：
 * build → spec（需求变了，退回规格）与 verify → build（验收不通过，退回实现）。删掉它们服务端会
 * 拒，前端先挡住，让用户看到原因而不是吃一个 400。
 */
const CONTRACT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  open: ['explore'],
  explore: ['spec'],
  spec: ['build'],
  build: ['verify', 'spec'],
  verify: ['ship', 'build'],
  ship: ['archive'],
  archive: [],
}

function documentScope(kind: string): 'change' | 'project' {
  return isDocumentKind(kind) ? DOCUMENT_KIND_CATALOG[kind].scope : 'change'
}

/** 文档契约的编辑期检查，与 kernel validateDocumentContract 对齐：技能缺失与顺序是错误，成对文档缺一是警告。 */
function documentIssues(def: WbWorkflowDef): LintIssue[] {
  const contract = def.documentContract
  if (def.openspec !== true || contract === undefined) return []
  const issues: LintIssue[] = []
  const index = (stepId: string): number => def.steps.findIndex((step) => step.id === stepId)
  const producerSeverity = isDefaultWorkflowName(def.name) ? 'warning' : 'error'
  const earlierProduce = (kind: string, stepId: string): boolean =>
    contract.slots.some((slot) => slot.kind === kind && slot.role === undefined && index(slot.ownerStep) < index(stepId))
  for (const slot of contract.slots) {
    if (slot.role !== undefined && documentScope(slot.kind) === 'change' && !earlierProduce(slot.kind, slot.ownerStep)) {
      issues.push({ kind: 'document-order', stepId: slot.ownerStep, document: slot.kind, severity: 'error' })
    }
    if (slot.role === 'require') continue
    const skills = def.steps.find((step) => step.id === slot.ownerStep)?.skills.map((skill) => skill.id) ?? []
    for (const producer of slot.producers) {
      if (!skills.some((skill) => skillsEquivalent(skill, producer))) {
        issues.push({ kind: 'document-producer-missing', stepId: slot.ownerStep, document: slot.kind, skill: producer, severity: producerSeverity })
      }
    }
  }
  for (const read of contract.reads) {
    for (const kind of read.kinds) {
      if (!contract.slots.some((slot) => slot.kind === kind && slot.role !== 'require' && index(slot.ownerStep) < index(read.step))) {
        issues.push({ kind: 'document-order', stepId: read.step, document: kind, severity: 'error' })
      }
    }
  }
  for (const [first, second] of DOCUMENT_CHAIN_PAIRS) {
    const left = contract.slots.find((slot) => slot.kind === first)
    const right = contract.slots.find((slot) => slot.kind === second)
    if (left !== undefined && right === undefined) issues.push({ kind: 'document-chain-gap', stepId: left.ownerStep, document: first, missing: second, severity: 'warning' })
    if (right !== undefined && left === undefined) issues.push({ kind: 'document-chain-gap', stepId: right.ownerStep, document: second, missing: first, severity: 'warning' })
  }
  return issues
}

/** 声明式测试输出只能落在工作区指纹排除的目录下（同 kernel TEST_OUTPUT_DIR_SEGMENTS）。 */
const TEST_OUTPUT_SEGMENTS: readonly string[] = ['test-results', 'playwright-report', 'coverage']

/** 测试项的编辑期检查，与 kernel compileStepTests 对齐：id 分支内唯一、命令非空、输出位置受限。 */
function testIssues(def: WbWorkflowDef): LintIssue[] {
  const issues: LintIssue[] = []
  const owner = new Map<string, string>()
  for (const step of def.steps) {
    for (const test of step.tests ?? []) {
      if (owner.has(test.id)) issues.push({ kind: 'test-id-duplicate', stepId: step.id, test: test.id, severity: 'error' })
      else owner.set(test.id, step.id)
      if (test.command.trim() === '') issues.push({ kind: 'test-command-empty', stepId: step.id, test: test.id, severity: 'error' })
      for (const output of test.outputs ?? []) {
        if (!output.path.split('/').some((segment) => TEST_OUTPUT_SEGMENTS.includes(segment))) {
          issues.push({ kind: 'test-output-location', stepId: step.id, test: test.id, path: output.path, severity: 'error' })
        }
      }
    }
  }
  return issues
}

/**
 * 编辑器保存前校验（kernel 校验之外的产品规则）：
 *   · 阶段没有输出是警告（运行时可以发现输出，不挡保存）；
 *   · 字段输入必须由更早阶段声明为输出；
 *   · 转移的事件名非空且在本阶段内唯一——引擎按事件名分派，重名无法判定走哪条；
 *   · 每条转移要么是去下一阶段的唯一一条，要么退回更早的阶段；
 *   · default 保留 CONTRACT_TRANSITIONS 要求的去向；
 *   · 开启 OpenSpec 时文档契约的技能、顺序与成对检查；
 *   · 测试 id 在分支内唯一、命令非空、声明输出落在测试目录下；
 *   · 步骤声明的 agent 必须在库里——库还没拉到（agents 为 null）就不判，不谎报。
 */
export function lintWorkflow(
  def: WbWorkflowDef,
  io: WbEffectiveIo | undefined,
  agents?: readonly string[] | null,
): LintIssue[] {
  const issues: LintIssue[] = []
  const canonical = def.openspec === true && isDefaultWorkflowName(def.name)
  def.steps.forEach((step, index) => {
    const next = def.steps[index + 1]
    const earlier = new Set(def.steps.slice(0, index).map((candidate) => candidate.id))
    const outputs = io?.[step.id]?.outputs.length ?? step.outputs.length
    if (outputs === 0) issues.push({ kind: 'step-no-output', stepId: step.id, severity: 'warning' })
    for (const input of step.inputs) {
      const upstream = def.steps.slice(0, index)
      if (!upstream.some((candidate) => candidate.outputs.some((output) => output.field === input.field))) {
        issues.push({ kind: 'input-not-upstream', stepId: step.id, field: input.field, severity: 'error' })
      }
    }
    const seen = new Set<string>()
    for (const transition of step.transitions) {
      if (transition.event.trim() === '') {
        issues.push({ kind: 'transition-empty-event', stepId: step.id, severity: 'error' })
        continue
      }
      if (seen.has(transition.event)) issues.push({ kind: 'transition-duplicate-event', stepId: step.id, event: transition.event, severity: 'error' })
      seen.add(transition.event)
    }
    let forwardSeen = false
    for (const transition of step.transitions) {
      if (!forwardSeen && next !== undefined && transition.to === next.id) {
        forwardSeen = true
        continue
      }
      if (earlier.has(transition.to)) continue
      // An explicit `archived` self-edge is the kernel's completion edge written out in YAML.
      if (transition.event === 'archived' && transition.to === step.id) continue
      issues.push({ kind: 'transition-not-next-or-back', stepId: step.id, event: transition.event, to: transition.to, severity: 'error' })
    }
    if (canonical) {
      for (const to of CONTRACT_TRANSITIONS[step.id] ?? []) {
        if (!step.transitions.some((transition) => transition.to === to)) {
          issues.push({ kind: 'transition-contract-required', stepId: step.id, to, severity: 'error' })
        }
      }
    }
  })
  issues.push(...documentIssues(def))
  issues.push(...testIssues(def))
  if (agents != null) {
    for (const step of def.steps) {
      const declared = [
        ...(step.agents?.executors ?? []).map((ref) => ref.agent),
        ...(step.agents?.reviewers ?? []).map((ref) => ref.agent),
      ]
      for (const agent of declared) {
        if (!agents.includes(agent)) issues.push({ kind: 'agent-missing', stepId: step.id, agent, severity: 'error' })
      }
    }
  }
  return issues
}

export function issuesFor(issues: readonly LintIssue[], stepId: string): LintIssue[] {
  return issues.filter((issue) => issue.stepId === stepId)
}

/**
 * 草稿（未保存）的物化 IO：与 kernel materializeWorkflowIo 同一规则——字段槽位按 inputs / outputs，
 * 文档槽位来自分支视图的文档契约（OpenSpec 开启时）：produce / update 是输出，read / require 是输入。
 */
export function draftEffectiveIo(def: WbWorkflowDef): WbEffectiveIo {
  const out: WbEffectiveIo = {}
  const contract = def.openspec === true ? def.documentContract : undefined
  const slots = contract?.slots ?? []
  const reads = contract?.reads ?? []
  const document = (id: string, role: 'produce' | 'update' | 'read' | 'require', producers: string[], consumers: string[]): WbIoSlot =>
    ({ kind: 'document', id, role, scope: documentScope(id), producers, consumers })
  const consumersOf = (kind: string, after: number): string[] => def.steps.slice(after + 1)
    .filter((candidate) => reads.some((read) => read.step === candidate.id && read.kinds.includes(kind))
      || slots.some((slot) => slot.ownerStep === candidate.id && slot.kind === kind && slot.role === 'require'))
    .map((candidate) => candidate.id)
  const sourceOf = (kind: string, before: number): string[] => {
    const produce = slots.find((slot) => slot.kind === kind && slot.role === undefined)
    if (produce !== undefined) return [produce.ownerStep]
    const update = def.steps.slice(0, before).reverse()
      .find((candidate) => slots.some((slot) => slot.ownerStep === candidate.id && slot.kind === kind && slot.role === 'update'))
    return update === undefined ? [] : [update.id]
  }
  def.steps.forEach((step, index) => {
    const upstream = def.steps.slice(0, index)
    const downstream = def.steps.slice(index + 1)
    const own = slots.filter((slot) => slot.ownerStep === step.id)
    out[step.id] = {
      outputs: [
        ...own.filter((slot) => slot.role === undefined).map((slot) => document(slot.kind, 'produce', slot.producers, consumersOf(slot.kind, index))),
        ...own.filter((slot) => slot.role === 'update').map((slot) => document(slot.kind, 'update', slot.producers, consumersOf(slot.kind, index))),
        ...step.outputs.map((output) => ({
          kind: 'field' as const,
          id: output.field,
          type: output.type,
          producer: null,
          consumers: downstream.filter((candidate) => candidate.inputs.some((input) => input.field === output.field)).map((candidate) => candidate.id),
        })),
      ],
      inputs: [
        ...(reads.find((read) => read.step === step.id)?.kinds ?? []).map((kind) => document(kind, 'read', sourceOf(kind, index), [])),
        ...own.filter((slot) => slot.role === 'require').map((slot) => document(slot.kind, 'require', [], [])),
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
