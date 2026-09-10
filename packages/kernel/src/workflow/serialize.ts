/**
 * workflow 定义文件序列化——`parseWorkflow`（parse.ts）的反向操作。往返等价
 * （`parseWorkflow(serializeWorkflow(wf))` 深度等于 `wf`）是唯一正确性判据，
 * 不是字面字符串匹配；字段/缩进写法逐条对齐 parse.ts 的读入期望，改动前先读一遍
 * parse.ts 各 parse*Block 函数确认没有漂移。
 *
 * G2 P2：guard 定义层扩为闭集（+ edge 级 guards/actions + when 谓词）后，serializeGuard 改成
 * **exhaustive switch**——旧实现对「非 tasks-at-least」一律兜底写 `- type: nonempty-output`，
 * 联合扩宽后会把任何新变体静默腐蚀成 nonempty-output；现在闭集 exhaustive，未覆盖变体编译期
 * `never` 报错、运行期 throw（fail-loud），保存不再静默丢真相。
 */
import type {
  FieldRef, SkillRef, StepDef, StepTransition, WorkflowActionConfig, WorkflowArtifactConfig, WorkflowDef,
  WorkflowDecompositionPolicyV1, WorkflowDocumentContractV1, WorkflowGuardConfig,
  WorkflowInteractionPolicyV1,
  WorkflowReviewBudgetPolicyV1,
} from './types.js'
import type { TrackPredicate } from './predicates.js'

function serializeSkill(s: SkillRef): string[] {
  const lines = [`      - id: ${s.id}`]
  if (s.kind !== undefined) lines.push(`        kind: ${s.kind}`)
  if (s.review_lane !== undefined) lines.push(`        review_lane: ${s.review_lane}`)
  if (s.depends_on !== undefined) {
    lines.push(`        depends_on: [${s.depends_on.join(', ')}]`)
  }
  if (s.when !== undefined) lines.push(...serializeWhen(s.when, '        '))
  return lines
}

function serializeDecomposition(
  policy: Omit<Partial<WorkflowDecompositionPolicyV1>, 'version'> & { readonly version: 'v1' },
): string[] {
  return [
    'decomposition:',
    `  version: ${policy.version}`,
    ...(policy.mode === undefined ? [] : [`  mode: ${policy.mode}`]),
    ...(policy.target === undefined ? [] : [`  target: ${policy.target}`]),
    ...(policy.strategy === undefined ? [] : [`  strategy: ${policy.strategy}`]),
    ...(policy.max_items === undefined ? [] : [`  max_items: ${policy.max_items}`]),
    ...(policy.max_depth === undefined ? [] : [`  max_depth: ${policy.max_depth}`]),
    ...(policy.auto_when === undefined ? [] : [`  auto_when: [${policy.auto_when.join(', ')}]`]),
    ...(policy.ask_when === undefined ? [] : [`  ask_when: [${policy.ask_when.join(', ')}]`]),
  ]
}

function serializeInteraction(
  policy: Omit<Partial<WorkflowInteractionPolicyV1>, 'version'> & { readonly version: 'v1' },
): string[] {
  return [
    'interaction:',
    `  version: ${policy.version}`,
    ...(policy.mode === undefined ? [] : [`  mode: ${policy.mode}`]),
  ]
}

function serializeReviewBudget(
  policy: Omit<Partial<WorkflowReviewBudgetPolicyV1>, 'version'> & { readonly version: 'v1' },
): string[] {
  return [
    'review_budget:',
    `  version: ${policy.version}`,
    ...(policy.max_attempts === undefined ? [] : [`  max_attempts: ${policy.max_attempts}`]),
  ]
}

function serializeFieldRef(r: FieldRef): string[] {
  return [`      - field: ${r.field}`, `        type: ${r.type}`]
}

/** required_when 块（G2 P4）：kind kebab → YAML snake（同 serializeWhen，但键名 required_when）。 */
function serializeRequiredWhen(when: TrackPredicate, pad: string): string[] {
  const key = when.kind === 'track-in' ? 'track_in' : 'track_not_in'
  return [`${pad}required_when:`, `${pad}  ${key}: [${when.values.join(', ')}]`]
}

/** 单条显式 artifact → 行（parse parseArtifactsBlock 的反向）：field/type/producer_policy + 可选
 *  required_when，缩进对齐 outputs 块（`- field:` 6 空格、子字段 8 空格、谓词 10 空格）。 */
function serializeArtifact(a: WorkflowArtifactConfig): string[] {
  const lines = [
    `      - field: ${a.field}`,
    `        type: ${a.type}`,
    `        producer_policy: ${a.producerPolicy}`,
  ]
  if (a.requiredWhen) lines.push(...serializeRequiredWhen(a.requiredWhen, '        '))
  return lines
}

/** artifacts 块：undefined（旧 YAML 无本键）→ 不写；`[]` → 写 `artifacts: []`；非空 → 逐条写。
 *  与 StepDef.artifacts? 的三态（缺省 / 空 / 非空）一一对应，往返保真。 */
function serializeArtifactsBlock(artifacts: readonly WorkflowArtifactConfig[] | undefined): string[] {
  if (artifacts === undefined) return []
  if (artifacts.length === 0) return ['    artifacts: []']
  return ['    artifacts:', ...artifacts.flatMap(serializeArtifact)]
}

/** track 条件块：kind kebab → YAML snake（track-in→track_in），谓词行缩进 = when 键 +2。 */
function serializeWhen(when: TrackPredicate, pad: string): string[] {
  const key = when.kind === 'track-in' ? 'track_in' : 'track_not_in'
  return [`${pad}when:`, `${pad}  ${key}: [${when.values.join(', ')}]`]
}

/** 单个 guard → 行；pad = `- type:` 行的前导空格，sub-field 缩进 pad+2。exhaustive：未覆盖
 *  变体 `never` 编译报错 + 运行期 throw，杜绝旧兜底把新变体静默写成 nonempty-output。 */
function serializeGuard(g: WorkflowGuardConfig, pad: string): string[] {
  const sub = `${pad}  `
  const lines = [`${pad}- type: ${g.type}`]
  switch (g.type) {
    case 'tasks-at-least': lines.push(`${sub}n: ${g.n}`); break
    case 'nonempty-output': break
    case 'field-nonempty': lines.push(`${sub}field: ${g.field}`); break
    case 'file-exists': lines.push(`${sub}field: ${g.path.field}`); break
    case 'field-equals': lines.push(`${sub}field: ${g.field}`, `${sub}value: ${g.value}`); break
    case 'field-in': lines.push(`${sub}field: ${g.field}`, `${sub}values: [${g.values.join(', ')}]`); break
    case 'full-direct-override': break
    case 'build-head-unchanged': lines.push(`${sub}field: ${g.field}`); break
    case 'spec-migration-applied': break
    default: {
      const exhaustive: never = g
      throw new Error(`serializeWorkflow: 未知 guard 变体 ${JSON.stringify(exhaustive)}（闭集见 types.ts WorkflowGuardConfig）`)
    }
  }
  if (g.when) lines.push(...serializeWhen(g.when, sub))
  return lines
}

function serializeAction(a: WorkflowActionConfig, pad: string): string[] {
  return [`${pad}- type: ${a.type}`]
}

/** edge 级可选块（guards/actions）：定义时写出（空数组写 `key: []`），未定义（旧 YAML）不写。 */
function serializeEdgeBlock<T>(name: string, items: readonly T[] | undefined, each: (item: T) => string[]): string[] {
  if (items === undefined) return []
  if (items.length === 0) return [`        ${name}: []`]
  return [`        ${name}:`, ...items.flatMap(each)]
}

function serializeTransition(t: StepTransition): string[] {
  return [
    `      - event: ${t.event}`,
    `        to: ${t.to}`,
    ...serializeEdgeBlock('guards', t.guards, (g) => serializeGuard(g, '          ')),
    ...serializeEdgeBlock('actions', t.actions, (a) => serializeAction(a, '          ')),
  ]
}

function serializeBlockField<T>(name: string, items: readonly T[], each: (item: T) => string[]): string[] {
  if (items.length === 0) return [`    ${name}: []`]
  return [`    ${name}:`, ...items.flatMap(each)]
}

function serializeStep(step: StepDef): string[] {
  const lines = [`  - id: ${step.id}`]
  if (step.label !== '') lines.push(`    label: ${step.label}`)
  lines.push(`    gate: ${step.gate ?? 'null'}`)
  if (step.prompt !== undefined) {
    lines.push('    prompt: |-')
    lines.push(...step.prompt.split('\n').map((line) => `      ${line}`))
  }
  if (step.reviewLanes !== undefined) {
    lines.push(`    review_lanes: [${step.reviewLanes.join(', ')}]`)
  }
  lines.push(...serializeBlockField('skills', step.skills, serializeSkill))
  lines.push(...serializeBlockField('inputs', step.inputs, serializeFieldRef))
  lines.push(...serializeBlockField('outputs', step.outputs, serializeFieldRef))
  lines.push(...serializeArtifactsBlock(step.artifacts))
  lines.push(...serializeBlockField('guards', step.guards, (g) => serializeGuard(g, '      ')))
  lines.push(...serializeBlockField('transitions', step.transitions, serializeTransition))
  return lines
}

function serializeDocumentContract(contract: WorkflowDocumentContractV1): string[] {
  return [
    'document_contract:',
    `  version: ${contract.version}`,
    '  slots:',
    ...contract.slots.flatMap((slot) => [
      `    - kind: ${slot.kind}`,
      `      owner_step: ${slot.ownerStep}`,
      `      producers: [${slot.producers.join(', ')}]`,
    ]),
    ...(contract.reads.length === 0
      ? ['  reads: []']
      : [
          '  reads:',
          ...contract.reads.flatMap((read) => [
            `    - step: ${read.step}`,
            `      kinds: [${read.kinds.join(', ')}]`,
          ]),
        ]),
  ]
}

export function serializeWorkflow(wf: WorkflowDef): string {
  if (wf.openspecContract !== undefined && wf.documentContract !== undefined) {
    throw new Error('serializeWorkflow: openspecContract 与 documentContract 不得同时声明')
  }
  const lines = [
    `name: ${wf.name}`,
    ...(wf.decomposition === undefined ? [] : serializeDecomposition(wf.decomposition)),
    ...(wf.interaction === undefined ? [] : serializeInteraction(wf.interaction)),
    ...(wf.reviewBudget === undefined ? [] : serializeReviewBudget(wf.reviewBudget)),
    ...(wf.openspecContract === undefined ? [] : [`openspec_contract: ${wf.openspecContract}`]),
    ...(wf.documentContract === undefined ? [] : serializeDocumentContract(wf.documentContract)),
    'steps:',
    ...wf.steps.flatMap(serializeStep),
  ]
  return lines.join('\n') + '\n'
}
