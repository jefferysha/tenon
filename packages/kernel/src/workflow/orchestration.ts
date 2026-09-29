/**
 * 编排投影：一条工作流每个阶段「谁、按什么顺序、做什么」，外加阶段门禁、回流边与输入输出的流向。
 *
 * 纯函数、无 I/O，Dashboard 经包子路径直接复用（编辑中的草稿与服务端冻结计划用同一份实现画同一张图）。
 * 阶段内顺序与 runner 一致（`tenon status` 的 next）：执行者波次 → 技能波次（含 OpenSpec 注入）→ 测试 →
 * 评审者波次。技能排序取 skill-order 的唯一口径；执行者、评审者的波次与 agent-verdict 同一个 dependencyWaves。
 */
import { dependencyWaves, directDependencies, type DependencyRef } from './dag-waves.js'
import { aliasesForSkill, TENON_PRODUCER } from './document-contract-validation.js'
import type { WorkflowIoSlot } from './effective-io.js'
import { orderSkillSlots, type SkillRefLike } from './skill-order.js'

export type OrchestrationKind = 'executor' | 'skill' | 'test' | 'reviewer'
/** declared = 阶段里声明；openspec = 文档契约要求本阶段产出者登记、阶段却没声明；manifest = 轨道矩阵叠加。 */
export type OrchestrationSource = 'declared' | 'openspec' | 'manifest'

export interface OrchestrationEntry {
  readonly kind: OrchestrationKind
  readonly id: string
  readonly label: string
  /** 阶段内的执行位次（跨身份递增）；同位次并行。 */
  readonly wave: number
  /** 同身份的直接前置（传递约简后）。 */
  readonly dependsOn: readonly string[]
  readonly required: boolean
  readonly source: OrchestrationSource
}

export interface OrchestrationStage {
  readonly id: string
  readonly label: string
  readonly gate: 'review' | 'auto' | null
  readonly entries: readonly OrchestrationEntry[]
}

/** 退回边：from 做完之后可以回到更早的 to。 */
export interface OrchestrationReturn {
  readonly from: string
  readonly to: string
  readonly event: string
}

/** 一份输出从产出阶段流向读取它的阶段；producers 是本阶段里产出它的技能。 */
export interface OrchestrationFlow {
  readonly slot: 'document' | 'field'
  readonly id: string
  readonly from: string
  readonly producers: readonly string[]
  readonly to: readonly string[]
}

export interface WorkflowOrchestration {
  readonly stages: readonly OrchestrationStage[]
  readonly returns: readonly OrchestrationReturn[]
  readonly flows: readonly OrchestrationFlow[]
}

export interface OrchestrationStepSource {
  readonly id: string
  readonly label: string
  readonly gate: 'review' | 'auto' | null
  readonly skills: readonly SkillRefLike[]
  readonly agents?: {
    readonly executors: readonly { readonly agent: string; readonly depends_on?: readonly string[] }[]
    readonly reviewers: readonly { readonly agent: string; readonly required: boolean; readonly depends_on?: readonly string[] }[]
  }
  readonly tests?: readonly { readonly id: string; readonly label?: string; readonly required?: boolean }[]
  readonly transitions: readonly { readonly event: string; readonly to: string }[]
}

export interface OrchestrationInput {
  readonly steps: readonly OrchestrationStepSource[]
  /** 物化 IO（materializeWorkflowIo 同形）：文档 produce 槽的产出者决定 OpenSpec 注入，consumers 决定流向。 */
  readonly io?: Readonly<Record<string, { readonly outputs: readonly WorkflowIoSlot[] }>>
  /** 每步的 manifest 叠加 token（`a|b` 备选记法）；与声明同 token 的去重，其余排在声明之后串行。 */
  readonly overlay?: Readonly<Record<string, readonly string[]>>
}

export function skillsEquivalent(left: string, right: string): boolean {
  const aliases = new Set(aliasesForSkill(left))
  return aliasesForSkill(right).some((alias) => aliases.has(alias))
}

/**
 * OpenSpec 注入的技能：本阶段文档契约里 role produce 槽点名的产出技能——运行时按同一份契约要求它登记产物。
 * 每个槽位的候选互为别名（openspec-propose ≡ opsx:propose），取第一个；阶段已有其中任一个、或候选只有
 * 编排器 `tenon` 时不算注入。
 */
export function openspecInjectedSkills(outputs: readonly WorkflowIoSlot[], stageSkills: readonly string[]): readonly string[] {
  const injected: string[] = []
  for (const slot of outputs) {
    if (slot.kind !== 'document' || slot.role !== 'produce') continue
    const candidates = slot.producers.filter((candidate) => !aliasesForSkill(candidate).includes(TENON_PRODUCER))
    const first = candidates[0]
    if (first === undefined) continue
    const known = [...stageSkills, ...injected]
    if (candidates.some((candidate) => known.some((skill) => skillsEquivalent(skill, candidate)))) continue
    injected.push(first)
  }
  return injected
}

function lastWave(entries: readonly OrchestrationEntry[], fallback: number): number {
  return entries.length === 0 ? fallback : Math.max(...entries.map((entry) => entry.wave)) + 1
}

/** 一组同身份引用 → 带全局位次的条目（前置未写 = 与同组并行，agent 的口径）。 */
function agentEntries(
  kind: 'executor' | 'reviewer',
  refs: readonly { readonly agent: string; readonly required?: boolean; readonly depends_on?: readonly string[] }[],
  offset: number,
): OrchestrationEntry[] {
  const graph: DependencyRef[] = refs.map((ref) => ({ id: ref.agent, dependsOn: ref.depends_on ?? [] }))
  const waves = dependencyWaves(graph)
  const direct = directDependencies(graph)
  return refs.map((ref) => ({
    kind,
    id: ref.agent,
    label: ref.agent,
    wave: offset + (waves.get(ref.agent) ?? 0),
    dependsOn: direct.get(ref.agent) ?? [],
    required: ref.required ?? true,
    source: 'declared',
  }))
}

function skillEntries(step: OrchestrationStepSource, input: OrchestrationInput, offset: number): OrchestrationEntry[] {
  const declared = step.skills.map((skill) => ({ token: skill.id, alternatives: [skill.id], source: 'declared' as const }))
  const tokens = new Set(declared.map((slot) => slot.token))
  const overlay = (input.overlay?.[step.id] ?? [])
    .filter((token) => !tokens.has(token) && tokens.add(token))
    .map((token) => ({ token, alternatives: token.split('|').map((part) => part.trim()).filter((part) => part !== ''), source: 'manifest' as const }))
  const slots = [...declared, ...overlay]
  const ordered = orderSkillSlots(slots, step.skills.map((skill) => ({
    id: skill.id,
    dependsOn: skill.depends_on ?? [],
    dependsOnDeclared: skill.depends_on !== undefined,
  })))
  const direct = directDependencies(ordered.map((slot) => ({ id: slot.token, dependsOn: slot.dependsOn })))
  const entries: OrchestrationEntry[] = ordered.map((slot, index) => ({
    kind: 'skill',
    id: slot.token,
    label: slot.token,
    wave: offset + slot.wave,
    dependsOn: direct.get(slot.token) ?? [],
    required: true,
    source: slots[index]?.source ?? 'declared',
  }))
  const known = slots.flatMap((slot) => slot.alternatives)
  const injected = openspecInjectedSkills(input.io?.[step.id]?.outputs ?? [], known)
  if (injected.length === 0) return entries
  // 注入的技能在声明的技能之后登记产物（next 先 load-skill，再发文档写入），接在声明技能的末端之后。
  const dependents = new Set(entries.flatMap((entry) => entry.dependsOn))
  const sinks = entries.filter((entry) => !dependents.has(entry.id)).map((entry) => entry.id)
  const wave = lastWave(entries, offset)
  return [...entries, ...injected.map((id): OrchestrationEntry => ({
    kind: 'skill', id, label: id, wave, dependsOn: sinks, required: true, source: 'openspec',
  }))]
}

function stageEntries(step: OrchestrationStepSource, input: OrchestrationInput): OrchestrationEntry[] {
  const executors = agentEntries('executor', step.agents?.executors ?? [], 0)
  const skills = skillEntries(step, input, lastWave(executors, 0))
  const afterSkills = lastWave(skills, lastWave(executors, 0))
  const tests: OrchestrationEntry[] = (step.tests ?? []).map((test) => ({
    kind: 'test',
    id: test.id,
    label: test.label ?? test.id,
    wave: afterSkills,
    dependsOn: [],
    required: test.required ?? true,
    source: 'declared',
  }))
  const reviewers = agentEntries('reviewer', step.agents?.reviewers ?? [], lastWave(tests, afterSkills))
  return [...executors, ...skills, ...tests, ...reviewers]
}

function flowsOf(input: OrchestrationInput, stages: readonly OrchestrationStage[]): OrchestrationFlow[] {
  const flows: OrchestrationFlow[] = []
  for (const stage of stages) {
    const skills = stage.entries.filter((entry) => entry.kind === 'skill').map((entry) => entry.id)
    for (const slot of input.io?.[stage.id]?.outputs ?? []) {
      if (slot.consumers.length === 0) continue
      if (flows.some((flow) => flow.slot === slot.kind && flow.id === slot.id && flow.from === stage.id)) continue
      const producers = slot.kind === 'document'
        ? skills.filter((skill) => slot.producers.some((candidate) => skillsEquivalent(skill, candidate)))
        : []
      flows.push({ slot: slot.kind, id: slot.id, from: stage.id, producers, to: [...slot.consumers] })
    }
  }
  return flows
}

export function orchestrate(input: OrchestrationInput): WorkflowOrchestration {
  const index = new Map(input.steps.map((step, position) => [step.id, position]))
  const stages: OrchestrationStage[] = input.steps.map((step) => ({
    id: step.id,
    label: step.label || step.id,
    gate: step.gate,
    entries: stageEntries(step, input),
  }))
  const returns = input.steps.flatMap((step, position) => step.transitions
    .filter((transition) => (index.get(transition.to) ?? Number.POSITIVE_INFINITY) < position)
    .map((transition) => ({ from: step.id, to: transition.to, event: transition.event })))
  return { stages, returns, flows: flowsOf(input, stages) }
}
