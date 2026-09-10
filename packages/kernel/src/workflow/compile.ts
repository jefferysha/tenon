/**
 * WorkflowDef → immutable WorkflowIR. Structured input is decoded against closed key/value
 * sets and fails loudly. Legacy lazy fields remain loadable, while typed guards and explicit
 * artifacts still require known scalar fields. Default/custom artifact policies stay separate.
 */
import { FIELD_ORDER, type FieldName } from '../types.js'
import type { TrackPredicate } from './predicates.js'
import type {
  ArtifactProducerPolicy, FieldRef, GateKind, SkillRef, StepDef, StepTransition, WorkflowDef,
  WorkflowDocumentContractV1, WorkflowDocumentRead, WorkflowDocumentSlot,
} from './types.js'
import { compileGuards, compileStepGuards, compileWhen } from './compile-guards.js'
import {
  compileWorkflowDecompositionPolicy,
  compileWorkflowInteractionPolicy,
  compileWorkflowReviewBudgetPolicy,
} from './policy.js'
import type {
  ActionConfig,
  ArtifactDeclaration,
  StepIR,
  StepTransitionIR,
  WorkflowIR,
} from './ir.js'

const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(FIELD_ORDER)
const FIELD_TYPES = ['string', 'file_path', 'boolean'] as const
const ACTION_TYPES: ReadonlySet<string> = new Set<ActionConfig['type']>([
  'freeze-build-sha',
  'reset-pre-verify-review',
  'mark-verification-passed',
  'mark-verification-failed',
  'archive-run',
])
// artifact producer policy 全闭集（G2 P4）：语法层「是不是合法 policy token」的判定（越界如
// effective-galaxy-skills → fail-loud）。是否**允许于当前 origin** 另由 allowedPolicies 收窄（A 契约）。
const PRODUCER_POLICIES: ReadonlySet<string> = new Set<ArtifactProducerPolicy>(['effective-step-skills', 'effective-phase-skills'])
// A 契约（G2 P5 · D4）：origin 相容的 producer policy 白名单。**不以 def.name 猜 origin**——由编译入口
// 显式选定（通用 compileWorkflow=custom 契约 / compileDefaultWorkflow=default 生成校验专用）。
//   · custom：只允 effective-step-skills；显式 effective-phase-skills 编译期 fail-loud（custom step id 不必
//     是 default phase，manifest phase×track key 空间对它无定义，跨接 default manifest 无意义）。
//   · default：允许两者（default.yaml 显式 artifact 用 effective-phase-skills；file_path output 派生默认仍
//     effective-step-skills）。default 运行时 artifact 走 P4 codegen 表，本入口只服务生成校验/内部测试。
const CUSTOM_PRODUCER_POLICIES: ReadonlySet<string> = new Set<ArtifactProducerPolicy>(['effective-step-skills'])
const DEFAULT_PRODUCER_POLICIES: ReadonlySet<string> = new Set<ArtifactProducerPolicy>(['effective-step-skills', 'effective-phase-skills'])
const WORKFLOW_KEYS: ReadonlySet<string> = new Set([
  'name', 'decomposition', 'interaction', 'reviewBudget', 'openspecContract', 'documentContract', 'steps', 'tracks',
])
const STEP_KEYS: ReadonlySet<string> = new Set([
  'id', 'label', 'gate', 'prompt', 'reviewLanes', 'skills', 'inputs', 'outputs', 'artifacts', 'guards', 'transitions',
])
const SKILL_KEYS: ReadonlySet<string> = new Set(['id', 'kind', 'review_lane', 'depends_on'])
const FIELD_REF_KEYS: ReadonlySet<string> = new Set(['field', 'type'])
const ARTIFACT_KEYS: ReadonlySet<string> = new Set(['field', 'type', 'kind', 'producerPolicy', 'requiredWhen'])
const TRANSITION_KEYS: ReadonlySet<string> = new Set(['event', 'to', 'guards', 'actions'])
const ACTION_KEYS: ReadonlySet<string> = new Set(['type'])
const DOCUMENT_CONTRACT_KEYS: ReadonlySet<string> = new Set(['version', 'slots', 'reads'])
const DOCUMENT_SLOT_KEYS: ReadonlySet<string> = new Set(['kind', 'ownerStep', 'producers'])
const DOCUMENT_READ_KEYS: ReadonlySet<string> = new Set(['step', 'kinds'])
function compileError(path: string, msg: string): never {
  throw new Error(`compileWorkflow: ${path}: ${msg}`)
}

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    compileError(path, `必须是对象（实际 ${JSON.stringify(v)}）`)
  }
  return v as Record<string, unknown>
}

function asArray(v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) compileError(path, `必须是数组（实际 ${JSON.stringify(v)}）`)
  return v
}

/** 对象键闭集校验（阻断 3）：出现 allowed 之外的键 → fail-loud。结构化输入（server workflows 直调
 *  绕过 parse）的附加字段此前能过 compile 再被 serialize 静默丢弃；这里在编译层挡住。 */
function rejectExtraKeys(rec: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      compileError(path, `出现该变体不接受的附加键 '${key}'（闭集：${[...allowed].join('/')}）`)
    }
  }
}

function nonemptyString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') compileError(path, `必须是非空字符串（实际 ${JSON.stringify(v)}）`)
  return v
}

function stringArray(v: unknown, path: string): string[] {
  const arr = asArray(v, path)
  return arr.map((x, i) => {
    if (typeof x !== 'string') compileError(`${path}[${i}]`, `必须是字符串（实际 ${JSON.stringify(x)}）`)
    return x
  })
}

function knownField(value: unknown, path: string): FieldName {
  if (typeof value !== 'string' || !KNOWN_FIELDS.has(value)) {
    compileError(path, `'${String(value)}' 不是已知状态字段（../types.ts FIELD_ORDER 闭集）`)
  }
  return value as FieldName
}

export { compileStepGuards }

function compileAction(raw: unknown, path: string): ActionConfig {
  const rec = asRecord(raw, path)
  rejectExtraKeys(rec, ACTION_KEYS, path)
  if (typeof rec.type !== 'string' || !ACTION_TYPES.has(rec.type)) {
    compileError(`${path}.type`, `未知 action type ${JSON.stringify(rec.type)}（闭集见 ir.ts ActionConfig）`)
  }
  return { type: rec.type as ActionConfig['type'] }
}

function compileActions(raw: unknown, path: string): ActionConfig[] {
  if (raw === undefined) return []
  return asArray(raw, path).map((a, j) => compileAction(a, `${path}[${j}]`))
}

/**
 * inputs/outputs 的 field 编译（G2 P2 兼容回退——pre-P2 的 FieldRef.field 是 string）：
 *   · 三种 type（string|boolean|file_path）一视同仁 → 允许未知惰性字段（field ∉ FIELD_ORDER 原样
 *     保留，非空即可）。pre-P2 声明非 FIELD_ORDER 惰性 output/input（不挂 guard/显式 artifact）的旧
 *     workflow 能加载、能跑转换图、能参与「前序 output→后序 input」定义层依赖校验——惰性 ref 不参与
 *     状态写入，但保留在 IR 里供依赖校验/展示。字符集/往返合法性由 validate.ts 的 IDENT_RE 把关
 *     （serialize/parse 往返域）。
 *   · 阻断 1：此前对未知 type:'file_path' field 直接 knownField 拒（残留 P1 严格面），误杀 pre-P2 能载的
 *     `outputs: [{field: custom_report, type: file_path}]`——artifact 派生规则不能倒推改变旧 definition
 *     的合法域。现放宽为惰性 ref，artifact 派生下沉到 compileArtifacts 只对**已知** file_path output 生效。
 * guard/显式 artifact 对字段的 FIELD_ORDER 严格校验各自在其编译点保留（scalarField / compileArtifact
 * 的 knownField），不受本放宽影响——即「新 typed guard / 显式 artifact 声明仍只能引用 FIELD_ORDER」。
 */
function compileFieldRef(raw: FieldRef, path: string): FieldRef {
  const rec = asRecord(raw, path)
  rejectExtraKeys(rec, FIELD_REF_KEYS, path)
  const type = rec.type
  if (type !== 'string' && type !== 'file_path' && type !== 'boolean') {
    compileError(`${path}.type`, `必须是 ${FIELD_TYPES.join(' | ')}（实际 ${JSON.stringify(type)}）`)
  }
  // 阻断 1：三种 type（string|boolean|file_path）的 field 一律作惰性 ref 保留（非空字符串即可）——
  // pre-P2 的 FieldRef.field 是任意 string、不按 type 收窄，未知 file_path output 也能加载。字符集/
  // 往返合法性由 validate.ts 的 IDENT_RE 把关。artifact 只在「已知 file_path output」派生
  // （compileArtifacts 用 KNOWN_FIELDS 过滤），未知 file_path 不派生——新增 artifact IR 不能倒推收窄
  // 旧 definition 的合法域（此前对未知 file_path 直接 knownField 拒，误杀 pre-P2 能载的惰性 output）。
  const field = nonemptyString(rec.field, `${path}.field`)
  return { field, type }
}

function compileReviewLanes(raw: unknown, path: string): readonly string[] {
  if (raw === undefined) return []
  const lanes = stringArray(raw, path)
  const seen = new Set<string>()
  for (const lane of lanes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(lane)) {
      compileError(path, `Review lane '${lane}' 含非法字符`)
    }
    if (seen.has(lane)) compileError(path, `Review lane '${lane}' 重复声明`)
    seen.add(lane)
  }
  return lanes
}

function compileSkillRef(raw: SkillRef, path: string, reviewLanes: readonly string[]): SkillRef {
  const rec = asRecord(raw, path)
  rejectExtraKeys(rec, SKILL_KEYS, path)
  const id = nonemptyString(rec.id, `${path}.id`)
  const kind = rec.kind ?? 'work'
  if (kind !== 'work' && kind !== 'review') {
    compileError(`${path}.kind`, `必须是 'work' | 'review'（实际 ${JSON.stringify(kind)}）`)
  }
  if (kind === 'review') {
    const reviewLane = nonemptyString(rec.review_lane, `${path}.review_lane`)
    if (!reviewLanes.includes(reviewLane)) {
      compileError(`${path}.review_lane`, `Review lane '${reviewLane}' 未在所属 step.reviewLanes 声明`)
    }
    return {
      id, kind, review_lane: reviewLane,
      ...(rec.depends_on === undefined ? {} : { depends_on: stringArray(rec.depends_on, `${path}.depends_on`) }),
    }
  }
  if (rec.review_lane !== undefined) {
    compileError(`${path}.review_lane`, 'kind=work 不得声明 review_lane')
  }
  return {
    id, kind,
    ...(rec.depends_on === undefined ? {} : { depends_on: stringArray(rec.depends_on, `${path}.depends_on`) }),
  }
}

/** 显式 artifact 声明的编译。kind 只一个合法值；producerPolicy 属 PRODUCER_POLICIES 闭集，缺省补
 *  'effective-step-skills'（custom 派生默认），给错拒绝。声明保留作者给定的 policy（default.yaml 用
 *  'effective-phase-skills'）。 */
function compileArtifact(raw: unknown, path: string, outputs: readonly FieldRef[], allowedPolicies: ReadonlySet<string>): ArtifactDeclaration {
  const rec = asRecord(raw, path)
  rejectExtraKeys(rec, ARTIFACT_KEYS, path)
  if (rec.type !== undefined && rec.type !== 'file_path') {
    compileError(`${path}.type`, `必须是 'file_path'（实际 ${JSON.stringify(rec.type)}）`)
  }
  if (rec.kind !== undefined && rec.kind !== 'file') {
    compileError(`${path}.kind`, `必须是 'file'（实际 ${JSON.stringify(rec.kind)}）`)
  }
  if (rec.producerPolicy !== undefined) {
    // 先过语法层全闭集（越界 token fail-loud），再过 origin 相容白名单（A 契约 fail-loud）。
    if (typeof rec.producerPolicy !== 'string' || !PRODUCER_POLICIES.has(rec.producerPolicy)) {
      compileError(`${path}.producerPolicy`, `必须是 ${[...PRODUCER_POLICIES].map((p) => `'${p}'`).join(' | ')}（实际 ${JSON.stringify(rec.producerPolicy)}）`)
    }
    if (!allowedPolicies.has(rec.producerPolicy)) {
      compileError(
        `${path}.producerPolicy`,
        `custom workflow 不允许 producerPolicy '${rec.producerPolicy}'（A 契约：custom artifact 只能 ${[...allowedPolicies].map((p) => `'${p}'`).join(' | ')}；effective-phase-skills 仅 default 轨适用）`,
      )
    }
  }
  const producerPolicy = (rec.producerPolicy ?? 'effective-step-skills') as ArtifactProducerPolicy
  const field = knownField(rec.field, `${path}.field`)
  const ref = outputs.find((o) => o.field === field)
  if (!ref) {
    compileError(`${path}.field`, `artifact 只能挂在本 step outputs 声明的字段上（'${field}' 不在 outputs 里）`)
  }
  if (ref.type !== 'file_path') {
    compileError(`${path}.field`, `artifact 只许挂 type:'file_path' 的 FieldRef（'${field}' 声明为 '${ref.type}'）`)
  }
  const requiredWhen = compileWhen(rec.requiredWhen, `${path}.requiredWhen`)
  const base: ArtifactDeclaration = { kind: 'file', field, producerPolicy }
  return requiredWhen === undefined ? base : { ...base, requiredWhen }
}

/** 派生默认（file_path 输出逐条）+ 显式声明按 field 替换派生条目；顺序 = outputs 声明序。 */
function compileArtifacts(
  rawExplicit: unknown,
  path: string,
  outputs: readonly FieldRef[],
  outputsPath: string,
  allowedPolicies: ReadonlySet<string>,
): ArtifactDeclaration[] {
  const byField = new Map<FieldName, ArtifactDeclaration>()
  outputs.forEach((o, j) => {
    if (o.type !== 'file_path') return
    // 阻断 1：只有「已知 file_path output」派生 artifact；未知 file_path 是惰性 ref（不派生、不参与
    // 状态写入），与未知 string/boolean 一视同仁——不能因 artifact 派生规则倒推拒绝 pre-P2 能载的
    // 未知 file_path output。同 field 的重复 file_path output 仍在此拦（仅对已知字段有 artifact 派生
    // 语义，才谈得上「重复派生同一 artifact」）。
    if (!KNOWN_FIELDS.has(o.field)) return
    const field = o.field as FieldName
    if (byField.has(field)) {
      compileError(`${outputsPath}[${j}].field`, `'${field}' 重复声明（同 field 的 file_path output 已在前面出现）`)
    }
    byField.set(field, { kind: 'file', field, producerPolicy: 'effective-step-skills' })
  })
  if (rawExplicit !== undefined) {
    const seen = new Set<FieldName>()
    asArray(rawExplicit, path).forEach((a, j) => {
      const artifact = compileArtifact(a, `${path}[${j}]`, outputs, allowedPolicies)
      if (seen.has(artifact.field)) {
        compileError(`${path}[${j}].field`, `'${artifact.field}' 重复声明`)
      }
      seen.add(artifact.field)
      byField.set(artifact.field, artifact)
    })
  }
  return [...byField.values()]
}

function compileTransition(raw: StepTransition, path: string, outputs: readonly FieldRef[]): StepTransitionIR {
  const rec = asRecord(raw, path)
  rejectExtraKeys(rec, TRANSITION_KEYS, path)
  return {
    event: nonemptyString(rec.event, `${path}.event`),
    to: nonemptyString(rec.to, `${path}.to`),
    guards: compileGuards(rec.guards, `${path}.guards`, outputs),
    actions: compileActions(rec.actions, `${path}.actions`),
  }
}

function compileStep(step: unknown, index: number, allowedPolicies: ReadonlySet<string>, pathPrefix = 'steps'): StepIR {
  const path = `${pathPrefix}[${index}]`
  const rec = asRecord(step, path)
  rejectExtraKeys(rec, STEP_KEYS, path)
  const id = nonemptyString(rec.id, `${path}.id`)
  if (typeof rec.label !== 'string') compileError(`${path}.label`, `必须是字符串（实际 ${JSON.stringify(rec.label)}）`)
  const gate = rec.gate
  if (gate === 'confirm') {
    compileError(`${path}.gate`, `gate 'confirm' 已移除——需要人工停下用 review，输出齐全即放行用 auto`)
  }
  if (gate !== null && gate !== 'review' && gate !== 'auto') {
    compileError(`${path}.gate`, `必须是 null | 'review' | 'auto'（实际 ${JSON.stringify(gate)}）`)
  }
  const prompt = rec.prompt
  if (prompt !== undefined) {
    if (typeof prompt !== 'string') compileError(`${path}.prompt`, `必须是字符串（实际 ${JSON.stringify(prompt)}）`)
    if (prompt.includes('\0')) compileError(`${path}.prompt`, '不得含 NUL（环境与子进程参数无法保真承载）')
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(prompt)) {
      compileError(`${path}.prompt`, '含未配对 UTF-16 surrogate，UTF-8 落盘无法往返')
    }
  }
  const reviewLanes = compileReviewLanes(rec.reviewLanes, `${path}.reviewLanes`)
  const skills = asArray(rec.skills, `${path}.skills`).map((s, j) =>
    compileSkillRef(s as SkillRef, `${path}.skills[${j}]`, reviewLanes),
  )
  const inputs = asArray(rec.inputs, `${path}.inputs`).map((r, j) => compileFieldRef(r as FieldRef, `${path}.inputs[${j}]`))
  const outputs = asArray(rec.outputs, `${path}.outputs`).map((r, j) => compileFieldRef(r as FieldRef, `${path}.outputs[${j}]`))
  // 不预折 `?? []`：null/非数组的显式 malformed 必须进 compileGuards 被 fail-loud 拒绝，
  // 只有 undefined（真未声明）才吃默认 []（compileGuards 自身的口径）。
  const guards = compileGuards(rec.guards, `${path}.guards`, outputs)
  const artifacts = compileArtifacts(rec.artifacts, `${path}.artifacts`, outputs, `${path}.outputs`, allowedPolicies)
  // gate=auto：自动评审 = 本阶段声明的全部输出齐全即放行——编译成每条出边上的 nonempty-output
  //（展开为逐输出 field-nonempty / output-present），与显式守卫同一条评估链，不另起门类。
  const autoGuards = gate === 'auto' ? compileGuards([{ type: 'nonempty-output' }], `${path}.gate(auto)`, outputs) : []
  const transitions = asArray(rec.transitions, `${path}.transitions`).map((t, j) => {
    const compiled = compileTransition(t as StepTransition, `${path}.transitions[${j}]`, outputs)
    return autoGuards.length === 0 ? compiled : { ...compiled, guards: [...autoGuards, ...compiled.guards] }
  })
  const transitionEvents = new Set<string>()
  transitions.forEach((transition, transitionIndex) => {
    if (transitionEvents.has(transition.event)) {
      compileError(
        `${path}.transitions[${transitionIndex}].event`,
        `同一步不得重复声明 event '${transition.event}'`,
      )
    }
    transitionEvents.add(transition.event)
  })
  return {
    id, label: rec.label, gate: gate as GateKind,
    ...(prompt === undefined ? {} : { prompt }),
    reviewLanes, skills, inputs, outputs, guards, artifacts, transitions,
  }
}

function compileNonemptyStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, index) => nonemptyString(item, `${path}[${index}]`))
}

function compileDocumentContract(value: unknown): WorkflowDocumentContractV1 | undefined {
  if (value === undefined) return undefined
  const rec = asRecord(value, 'documentContract')
  rejectExtraKeys(rec, DOCUMENT_CONTRACT_KEYS, 'documentContract')
  if (rec.version !== 'v1') {
    compileError('documentContract.version', `必须是 'v1'（实际 ${JSON.stringify(rec.version)}）`)
  }
  const slots: WorkflowDocumentSlot[] = asArray(rec.slots, 'documentContract.slots').map((slot, index) => {
    const item = asRecord(slot, `documentContract.slots[${index}]`)
    rejectExtraKeys(item, DOCUMENT_SLOT_KEYS, `documentContract.slots[${index}]`)
    return {
      kind: nonemptyString(item.kind, `documentContract.slots[${index}].kind`),
      ownerStep: nonemptyString(item.ownerStep, `documentContract.slots[${index}].ownerStep`),
      producers: compileNonemptyStringArray(item.producers, `documentContract.slots[${index}].producers`),
    }
  })
  if (slots.length === 0) compileError('documentContract.slots', '不得为空')
  const reads: WorkflowDocumentRead[] = asArray(rec.reads, 'documentContract.reads').map((read, index) => {
    const item = asRecord(read, `documentContract.reads[${index}]`)
    rejectExtraKeys(item, DOCUMENT_READ_KEYS, `documentContract.reads[${index}]`)
    const kinds = compileNonemptyStringArray(item.kinds, `documentContract.reads[${index}].kinds`)
    if (kinds.length === 0) compileError(`documentContract.reads[${index}].kinds`, '不得为空')
    return {
      step: nonemptyString(item.step, `documentContract.reads[${index}].step`),
      kinds,
    }
  })
  return { version: 'v1', slots, reads }
}

/** 产物全是本文件新建的纯数据树（无环、无函数键），直接后序递归冻结。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function compileWith(def: unknown, allowedPolicies: ReadonlySet<string>): WorkflowIR {
  const rec = asRecord(def, 'workflow')
  rejectExtraKeys(rec, WORKFLOW_KEYS, 'workflow')
  const name = nonemptyString(rec.name, 'name')
  const decomposition = compileWorkflowDecompositionPolicy(rec.decomposition)
  const interaction = compileWorkflowInteractionPolicy(rec.interaction)
  const reviewBudget = compileWorkflowReviewBudgetPolicy(rec.reviewBudget)
  const openspecContract = rec.openspecContract
  if (openspecContract !== undefined && openspecContract !== 'required') {
    compileError('openspecContract', `必须是 'required'（实际 ${JSON.stringify(openspecContract)}）`)
  }
  const documentContract = compileDocumentContract(rec.documentContract)
  if (openspecContract !== undefined && documentContract !== undefined) {
    compileError('documentContract', '不得与 openspecContract 同时声明')
  }
  const steps = asArray(rec.steps, 'steps').map((s, i) => compileStep(s, i, allowedPolicies))
  const tracks = compileTracks(rec.tracks, allowedPolicies)
  return deepFreeze({
    name,
    decomposition,
    interaction,
    reviewBudget,
    ...(openspecContract === undefined ? {} : { openspecContract }),
    ...(documentContract === undefined ? {} : { documentContract }),
    steps,
    ...(tracks === undefined ? {} : { tracks }),
  })
}

const TRACK_BRANCH_KEYS: ReadonlySet<string> = new Set(['label', 'steps'])
const TRACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** `tracks.<id>` 分支：每条分支的 steps 与顶层同构编译（路径前缀 tracks.<id>.steps）。 */
function compileTracks(raw: unknown, allowedPolicies: ReadonlySet<string>): WorkflowIR['tracks'] | undefined {
  if (raw === undefined) return undefined
  const rec = asRecord(raw, 'tracks')
  const out: Record<string, { label?: string; steps: readonly StepIR[] }> = {}
  for (const [id, branchRaw] of Object.entries(rec)) {
    if (!TRACK_ID_RE.test(id)) compileError(`tracks.${id}`, '分支 id 须为小写字母开头的 a-z0-9_-（≤32）')
    const branch = asRecord(branchRaw, `tracks.${id}`)
    rejectExtraKeys(branch, TRACK_BRANCH_KEYS, `tracks.${id}`)
    if (branch.label !== undefined && (typeof branch.label !== 'string' || branch.label === '')) {
      compileError(`tracks.${id}.label`, `必须是非空字符串（实际 ${JSON.stringify(branch.label)}）`)
    }
    const steps = asArray(branch.steps, `tracks.${id}.steps`).map((s, i) => compileStep(s, i, allowedPolicies, `tracks.${id}.steps`))
    out[id] = { ...(branch.label === undefined ? {} : { label: branch.label }), steps }
  }
  return out
}

/**
 * 通用编译入口 = **custom 契约**（G2 P5 · A 契约钉死）：拒绝任何 effective-phase-skills artifact
 * （fail-loud）。loadWorkflow（项目 custom yaml 的 validate/compile 路径）、cli/server 的 custom
 * transition adapter 全走此入口——它们加载的都是 custom workflow。default 运行时 artifact 走 P4
 * codegen 表、不经本函数；default 生成校验/内部测试走下方 compileDefaultWorkflow。
 */
export function compileWorkflow(def: unknown): WorkflowIR {
  return compileWith(def, CUSTOM_PRODUCER_POLICIES)
}

/**
 * HTTP/JSON 等结构化边界的定义层 decoder。compileWorkflow 已完整校验所有必填键、嵌套
 * 变体和值域；校验成功后保留原始定义层形状，避免把编译后的 artifact IR 误当作可序列化 DTO。
 */
export function decodeWorkflowDef(value: unknown, origin: 'custom' | 'default' = 'custom'): WorkflowDef {
  if (origin === 'default') compileDefaultWorkflow(value)
  else compileWorkflow(value)
  return value as WorkflowDef
}

/**
 * default 生成校验/内部专用入口（G2 P5 · A 契约钉死）：允许 effective-phase-skills（default.yaml 的
 * phase policy 声明）。**绝不以 def.name==='default' 猜 origin**——本入口是显式的、内部/生成验证专用
 * 边界；default 运行时 artifact 消费 P4 codegen 表，不由通用 compileWorkflow 承担 default 运行。
 */
export function compileDefaultWorkflow(def: unknown): WorkflowIR {
  return compileWith(def, DEFAULT_PRODUCER_POLICIES)
}
