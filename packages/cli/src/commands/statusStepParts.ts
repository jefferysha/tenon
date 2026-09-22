/**
 * `tenon status <change> --json` 的 `step` 分块投影：技能、文档、字段。
 *
 * 每一块都读已有的判定源（技能证据、文档台账、guard 字段表），这里只把它们摆成 skill 能照做的形状。
 */
import {
  DOCUMENT_KIND_CATALOG, documentPathTemplateForKind, isDocumentKind, renderDocumentPathForKind,
  readsRequiredForPolicyStep, requiresForPolicyStep, resolveRequiredSkillSlots,
  type DocumentEvidenceItem, type DocumentGovernancePolicy, type DocumentKind,
  type EffectiveWorkflowPlan, type PipelineState, type StepIR,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { RECOMMENDED, STEP_FIELD_ENUMS, TRANSITION_MANAGED_FIELDS } from './field-values.js'
import { canonicalTenonSkillId } from './stepSkillEvidence.js'

export interface StepSkillView {
  readonly id: string
  readonly depends_on: readonly string[]
  readonly wave: number
  readonly status: 'done' | 'ready' | 'waiting'
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
 * 技能顺序的唯一真相源仍是解析出来的必需槽位：default 走 manifest 叠加，自定义走 step 声明。
 * 槽位是有序的，所以第 n 个槽位的前置就是它前面所有槽位。
 */
export function stepSkills(
  deps: CliDeps,
  plan: EffectiveWorkflowPlan,
  stepId: string,
  completed: ReadonlySet<string>,
): readonly StepSkillView[] {
  const declared = plan.capabilities.skills.steps.find((step) => step.stepId === stepId)?.declared ?? []
  const slots = resolveRequiredSkillSlots(deps.resolver, plan.capabilities.skills, stepId)
  const views: StepSkillView[] = []
  let unlocked = true
  for (const [index, slot] of slots.entries()) {
    const id = canonicalTenonSkillId(slot.token)
    const done = slot.alternatives.some((candidate) => completed.has(canonicalTenonSkillId(candidate)))
    views.push({
      id,
      depends_on: declared.find((ref) => canonicalTenonSkillId(ref.id) === id)?.dependsOn.map(canonicalTenonSkillId)
        ?? views.slice(0, index).map((view) => view.id),
      wave: index,
      status: done ? 'done' : unlocked ? 'ready' : 'waiting',
    })
    if (!done) unlocked = false
  }
  return views
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

export interface StepDocumentsView {
  readonly reads: readonly StepDocumentView[]
  readonly records: readonly StepDocumentView[]
  readonly updates: readonly StepDocumentView[]
}

/**
 * 三类文档分别来自契约的 reads / role produce / role update；`role: require` 的项目文档与 reads
 * 同属「必须先在」的输入面，因此也列在 reads 里。
 */
export function stepDocuments(
  change: string,
  policy: DocumentGovernancePolicy | undefined,
  stepId: string,
  items: readonly DocumentEvidenceItem[],
): StepDocumentsView {
  if (policy === undefined) return { reads: [], records: [], updates: [] }
  const reads = [...readsRequiredForPolicyStep(policy, stepId), ...requiresForPolicyStep(policy, stepId)]
  const seen = new Set<string>()
  return {
    reads: reads.filter((kind) => !seen.has(kind) && seen.add(kind))
      .map((kind) => view(change, kind, [], items)),
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
    allowed: STEP_FIELD_ENUMS[field] ?? null,
    required: required ?? null,
    recommended: RECOMMENDED(field, state) ?? null,
  }
}

/**
 * 本步要填的字段：声明的 outputs 是产出，guard 里点名的字段是门禁前置，结果字段单列。
 * 只列当前步骤真正读得到的那些，避免 skill 去填与本步无关的槽。
 *
 * `nativeGuardFields` 是 default 轨的补充来源：那条轨的前置 guard 写在 flow/default-event-policy.ts
 * 的事件政策表里，不在 step.guards 上，光看 IR 会漏掉 build_mode / isolation / direct_override /
 * branch_status 这些真正卡住转换的槽。custom 轨传空数组即可——它的 guard 本来就都在 step 上。
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
