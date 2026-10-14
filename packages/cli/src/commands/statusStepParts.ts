/**
 * `tenon status <change> --json` 的 `step` 分块投影：技能、文档、字段。
 *
 * 每一块都读已有的判定源（技能证据、文档台账、guard 字段表），这里只把它们摆成 skill 能照做的形状。
 */
import {
  DOCUMENT_KIND_CATALOG, documentPathTemplateForKind, isDocumentKind, orderSkillSlots, renderDocumentPathForKind,
  readsRequiredForPolicyStep, readStepOutputs, recordProducerCandidatesForPolicyStep, requiredOutputSatisfied,
  requiresForPolicyStep, skillSlotStatuses, StepOutputLedgerError, stepOutputsContextFor, stepRequiredOutputs,
  type DocumentEvidenceItem, type DocumentGovernancePolicy, type DocumentKind,
  type EffectiveWorkflowPlan, type PipelineState, type StepIR, type StepObservation, type StepOutputsView,
} from '@tenon/kernel'
import type { StepSkillSlotProgress } from '../stepSkillGate.js'
import {
  legacyDecisionEnum, legacyDecisionRecommended, RECOMMENDED, STEP_FIELD_ENUMS, TRANSITION_MANAGED_FIELDS,
} from './field-values.js'
import { canonicalTenonSkillId } from './stepSkillEvidence.js'

export interface StepSkillView {
  readonly id: string
  readonly depends_on: readonly string[]
  readonly wave: number
  /**
   * `invoked` = 已调用，但本步契约绑定给它的文档还没在本次步骤访问里登记；剩下的动作是登记
   * `pending_documents`，不是再调用一次。
   */
  readonly status: 'done' | 'invoked' | 'ready' | 'waiting'
  /** 这个技能在本步还欠的文档 kind（契约 role produce 槽点名它为 producer）；空 = 调用即完成。 */
  readonly pending_documents: readonly string[]
}

export interface StepDocumentView {
  readonly kind: string
  /**
   * 已登记的实际路径，或该 kind 的规范路径；`null` = 这一条的路径还定不下来
   * （delta-spec 的 `{capability}` 由作者拍板，`tenon document scaffold` 要 `--capability`）。
   */
  readonly path: string | null
  /** 路径模板，占位符原样保留；path 为 null 时它说明还缺哪个变量。 */
  readonly path_template: string
  readonly producers: readonly string[]
  readonly status: string
}

export interface StepFieldView {
  readonly field: string
  readonly kind: 'output' | 'guard' | 'outcome'
  /**
   * 写这个字段该用哪条命令：`set` 是 `tenon set`，`artifact-register` 是
   * `tenon artifact register`（artifact 声明过的字段被 set/set-many/cas 拒写），`transition` 是
   * 转换副作用自己落的槽（archived / archived_at / review receipt 等），运行器不该去填。
   * 三者共用 fields.ts 那一份拒写判定，投影说的写法与命令实际接受的写法因此不会分家。
   */
  readonly writer: 'set' | 'artifact-register' | 'transition'
  /**
   * `missing` = 本步的出口还不接受当前值：要么没值，要么 guard 点名要别的值（branch_status=pending
   * 时 verify-pass 要 handled）。「有值但不是要的那个值」从前算 `set`，运行器因此收不到任何动作，
   * 只能去读 `ERROR: verify-pass 要求 branch_status=handled` 那行散文。
   */
  readonly status: 'set' | 'missing'
  readonly value: string | null
  readonly allowed: readonly string[] | null
  /** 本步 guard 只接受的值；null = 只要求非空。 */
  readonly required: readonly string[] | null
  readonly recommended: string | null
}

/** guard 对某字段点名的值集（同字段多条 guard 取交集口径：先到先得，与首错优先序一致）。 */
export interface StepFieldRequirement {
  readonly field: string
  readonly required?: readonly string[]
}

/** 步骤结果字段：本步的必需测试与评审者都过了才该填，所以单独成一类。 */
const OUTCOME_FIELDS = new Set(['verify_result', 'branch_status', 'pre_verify_review_result'])

function scalar(state: PipelineState, field: string): string {
  const value = state.fields[field as keyof PipelineState['fields']]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/**
 * 技能列表是解析出来的必需槽位（default 走 manifest 叠加，自定义走 step 声明）；前置与波次取 kernel
 * skill-order 的唯一口径——声明了 depends_on 的按声明成波，没声明的按声明顺序串行。技能门
 * （internal-skill-gate）与 Dashboard 画布读同一份排序。完成度直接取技能门的判定
 * （stepSkillGate.judgeStepSkills），投影与 transition 不各算一遍。
 */
export function stepSkills(
  plan: EffectiveWorkflowPlan,
  stepId: string,
  slots: readonly StepSkillSlotProgress[],
): readonly StepSkillView[] {
  const declared = plan.capabilities.skills.steps.find((step) => step.stepId === stepId)?.declared ?? []
  const ordered = orderSkillSlots(slots.map((slot) => ({ token: slot.token, alternatives: slot.token.split('|') })), declared)
  const statuses = skillSlotStatuses(ordered, slots)
  return slots.map((slot, index) => ({
    id: canonicalTenonSkillId(slot.token),
    depends_on: (ordered[index]?.dependsOn ?? []).map(canonicalTenonSkillId),
    wave: ordered[index]?.wave ?? index,
    status: statuses[index] ?? 'waiting',
    pending_documents: slot.pendingDocuments,
  }))
}

/**
 * 还没登记、模板又缺变量时返回 null，而不是抛。
 *
 * 这一条抛出去，`tenon status --json` 的 step 分块会被整块吞掉（status.ts 捕获后只打一行 WARN），
 * 数据驱动的执行者在 spec 相位就什么也拿不到——和技能门那个缺陷同一类：本该告诉执行者做什么的
 * 投影，一句话都不说。
 */
function documentPath(
  change: string,
  kind: DocumentKind,
  item: DocumentEvidenceItem | undefined,
): string | null {
  const recorded = item?.paths[0]
  if (recorded !== undefined) return recorded
  const projectPath = DOCUMENT_KIND_CATALOG[kind].projectPath
  if (projectPath !== undefined) return projectPath
  const rendered = renderDocumentPathForKind(kind, { change })
  return 'missing' in rendered ? null : rendered.path
}

function view(
  change: string,
  kind: DocumentKind,
  producers: readonly string[],
  items: readonly DocumentEvidenceItem[],
): StepDocumentView {
  const item = items.find((candidate) => candidate.kind === kind)
  return {
    kind,
    path: documentPath(change, kind, item),
    path_template: DOCUMENT_KIND_CATALOG[kind].projectPath ?? documentPathTemplateForKind(kind),
    producers,
    status: item?.status ?? 'missing',
  }
}

/** 契约模式（升级前创建、冻结计划带旧文档契约的任务）：契约声明的读 / 登记 / 更新三张表。 */
export interface StepContractDocumentsView {
  readonly mode: 'contract'
  readonly reads: readonly StepDocumentView[]
  readonly records: readonly StepDocumentView[]
  readonly updates: readonly StepDocumentView[]
}

/** 直接上游步骤交接来的一份文档输入；`status` 是本步访问有没有它的读取回执。 */
export interface ObservedStepInput {
  readonly path: string
  readonly from_step: string
  /** 产出它的技能；认不出来是 null（显示为「未知」）。 */
  readonly skill: string | null
  readonly status: 'read' | 'unread'
}

/** 本步访问里内容发生变化的文件（新增 / 修改 / 删除）。 */
export interface ObservedStepOutput {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly skill: string | null
}

/** 本步声明的一条必须产出；`path` 已把 `{change}` 渲染成任务名，可以含通配符。 */
export interface ObservedStepRequirement {
  readonly path: string
  readonly status: 'produced' | 'missing'
}

/**
 * 观察模式（新任务）：Tenon 离开步骤时观察实际产出，不预先规定文档。三张旧表恒为空——这样只认契约表的
 * 消费方（骨架 / 登记 / 按 kind 读取的动作）自然什么都不发，不必各自再判断一次模式。
 */
export interface StepObservedDocumentsView {
  readonly mode: 'observed'
  readonly observation: StepObservation
  readonly inputs: readonly ObservedStepInput[]
  readonly outputs: readonly ObservedStepOutput[]
  readonly required: readonly ObservedStepRequirement[]
  readonly reads: readonly StepDocumentView[]
  readonly records: readonly StepDocumentView[]
  readonly updates: readonly StepDocumentView[]
}

export type StepDocumentsView = StepContractDocumentsView | StepObservedDocumentsView

/** 没有任何文档信息的投影（已完结的任务、读不到计划时）；观察模式的观察状态记为不可用。 */
export function emptyStepDocuments(mode: 'contract'): StepContractDocumentsView
export function emptyStepDocuments(mode: 'observed'): StepObservedDocumentsView
export function emptyStepDocuments(mode: StepDocumentsView['mode']): StepDocumentsView
export function emptyStepDocuments(mode: StepDocumentsView['mode']): StepDocumentsView {
  return mode === 'observed'
    ? { mode, observation: 'unavailable', inputs: [], outputs: [], required: [], reads: [], records: [], updates: [] }
    : { mode, reads: [], records: [], updates: [] }
}

/** 账本读不了（损坏）时的退路：没有访问记录，必须产出按「存在匹配的文件」判定；阻断本身由出口报告提出。 */
const UNAVAILABLE_VIEW: StepOutputsView = { visit: null, observation: 'unavailable', inputs: [], outputs: [], steps: {}, produced: {} }

/**
 * 观察模式的 `step.documents`：当前访问的交接输入（含已读）、实时比较得到的本步产出，以及本步每条必须产出的
 * 满足情况。三项都来自 kernel 的同一份 `readStepOutputs` 视图，与转换、`tenon check` 和 Dashboard 同源。
 *
 * 账本损坏（`StepOutputLedgerError`）不让整块投影消失：退成「观察不可用」的空视图，修复办法由出口报告里的
 * `step-output-ledger-invalid` 阻断（`next` 的 `fix`）给出；其余异常照实抛。
 */
export async function observedStepDocuments(
  change: string,
  dir: string,
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  stepId: string,
): Promise<StepObservedDocumentsView> {
  const ctx = stepOutputsContextFor(dir)
  let observed: StepOutputsView
  try {
    observed = await readStepOutputs(ctx, { live: true })
  } catch (error) {
    if (!(error instanceof StepOutputLedgerError)) throw error
    observed = UNAVAILABLE_VIEW
  }
  const required = await Promise.all(stepRequiredOutputs(plan, stepId, scalar(state, 'track')).map(
    async (pattern): Promise<ObservedStepRequirement> => ({
      path: pattern.replaceAll('{change}', change),
      status: await requiredOutputSatisfied(ctx, observed, stepId, pattern) ? 'produced' : 'missing',
    }),
  ))
  return {
    mode: 'observed',
    observation: observed.observation,
    inputs: observed.inputs.map((input) => ({
      path: input.path, from_step: input.fromStep, skill: input.skill, status: input.read ? 'read' : 'unread',
    })),
    outputs: observed.outputs.map((output) => ({ path: output.path, change: output.change, skill: output.skill })),
    required,
    reads: [],
    records: [],
    updates: [],
  }
}

/**
 * 三类文档分别来自契约的 reads / role produce / role update；`role: require` 的项目文档与 reads
 * 同属「必须先在」的输入面，因此也列在 reads 里。
 *
 * 读清单的 producers 是**当前步**接受的那组，不是空表：输入文档被改动后状态变 stale，读不动了，
 * 要的是一次重新登记，而登记命令只认当前步合法的 producer（`explore` 的 proposal 只认 `tenon`，
 * 不认当初在 `open` 写它的 `openspec-propose`）。空表让投影说不出这件事。
 */
export function stepDocuments(
  change: string,
  policy: DocumentGovernancePolicy | undefined,
  stepId: string,
  items: readonly DocumentEvidenceItem[],
): StepContractDocumentsView {
  if (policy === undefined) return emptyStepDocuments('contract')
  const reads = [...readsRequiredForPolicyStep(policy, stepId), ...requiresForPolicyStep(policy, stepId)]
  const seen = new Set<string>()
  return {
    mode: 'contract',
    reads: reads.filter((kind) => !seen.has(kind) && seen.add(kind))
      .map((kind) => view(change, kind, recordProducerCandidatesForPolicyStep(policy, kind, stepId), items)),
    records: (policy.outputsByStep[stepId] ?? [])
      .map((requirement) => view(change, requirement.kind, requirement.producerCandidates, items)),
    updates: (policy.mutableByStep[stepId] ?? [])
      .map((requirement) => view(change, requirement.kind, requirement.producerCandidates, items)),
  }
}

function fieldView(
  state: PipelineState,
  field: string,
  kind: StepFieldView['kind'],
  artifacts: ReadonlySet<string>,
  required: readonly string[] | undefined,
  legacyDecision: boolean,
): StepFieldView {
  const value = scalar(state, field)
  const present = value !== '' && value !== 'null'
  const satisfied = present && (required === undefined || required.includes(value))
  return {
    field,
    kind,
    writer: TRANSITION_MANAGED_FIELDS.has(field)
      ? 'transition'
      : artifacts.has(field) ? 'artifact-register' : 'set',
    status: satisfied ? 'set' : 'missing',
    value: present ? value : null,
    allowed: (legacyDecision ? legacyDecisionEnum(field) : undefined) ?? STEP_FIELD_ENUMS[field] ?? null,
    required: required ?? null,
    recommended: (legacyDecision ? legacyDecisionRecommended(field, state) : undefined) ?? RECOMMENDED(field) ?? null,
  }
}

/**
 * 本步要填的字段：声明的 outputs 是产出，guard 里点名的字段是门禁前置，结果字段单列。
 * 只列当前步骤真正读得到的那些，避免 skill 去填与本步无关的槽。
 *
 * `step.guards` 传的是离开条件（按 YAML 执行的任务：步骤 guards ∪ 前进边 guards，见 exitGuards.ts）。
 * `nativeGuardFields` 是旧执行模型的补充来源：那条轨的前置 guard 写在 flow/default-event-policy.ts
 * 的事件政策表里，不在 step.guards 上，光看 IR 会漏掉 build_mode / isolation / direct_override /
 * branch_status 这些真正卡住转换的槽；这些决定字段的枚举与推荐值也只随它们带出（新任务没有这些决定）。
 * 按 YAML 执行的任务传空数组即可。
 */
export function stepFields(
  state: PipelineState,
  step: StepIR | undefined,
  artifacts: ReadonlySet<string> = new Set(),
  nativeGuardFields: readonly StepFieldRequirement[] = [],
): readonly StepFieldView[] {
  if (step === undefined) return []
  const requiredOf = new Map<string, readonly string[]>()
  for (const guard of step.guards) {
    if (guard.type === 'field-equals') requiredOf.set(guard.field, [guard.value])
    else if (guard.type === 'field-in') requiredOf.set(guard.field, guard.values)
  }
  for (const item of nativeGuardFields) {
    if (item.required !== undefined && !requiredOf.has(item.field)) requiredOf.set(item.field, item.required)
  }
  const nativeFields = new Set(nativeGuardFields.map((item) => item.field))
  const seen = new Set<string>()
  const fields: StepFieldView[] = []
  const push = (field: string, kind: StepFieldView['kind']): void => {
    if (seen.has(field)) return
    seen.add(field)
    fields.push(fieldView(
      state,
      field,
      OUTCOME_FIELDS.has(field) ? 'outcome' : kind,
      artifacts,
      requiredOf.get(field),
      nativeFields.has(field),
    ))
  }
  for (const output of step.outputs) push(output.field, 'output')
  for (const guard of step.guards) {
    const field = (guard as { readonly field?: string }).field
    if (typeof field === 'string') push(field, 'guard')
  }
  for (const item of nativeGuardFields) push(item.field, 'guard')
  return fields
}

export function isKnownDocumentKind(kind: string): kind is DocumentKind {
  return isDocumentKind(kind)
}
