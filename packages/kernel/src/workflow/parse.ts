/**
 * workflow 定义文件窄解析器——同 packages/kernel/src/flow/manifest.ts 的策略：手写扫描，
 * 只支持本文件格式实际用到的 YAML 子集（flat key/value + 固定形状的 block 序列 +
 * `[a, b]` 单行 flow-list），禁引入 yaml 包（kernel 零第三方依赖硬规则）。格式错误
 * fail-loud（throw），不吞错静默返回残缺结构。
 */
import { GUARD_DATA_KEYS } from './types.js'
import type {
  FieldRef, GateKind, SkillRef, StepDef, StepTransition,
  StepAgentsDef, StepTestDef, WorkflowActionConfig, WorkflowArtifactConfig, WorkflowConditional, WorkflowDef,
  WorkflowDocumentContractV1, WorkflowGuardConfig, TrackBranchDef,
} from './types.js'
import type { FieldName } from '../types.js'
import type { TrackPredicate } from './predicates.js'
import { parseDocumentContract, type WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { parseDecompositionPolicy, parseInteractionPolicy } from './parse-policy.js'
import { parseSkillRefs } from './parse-skill-refs.js'
import { parseStepAgents } from './parse-agents.js'
import { parseStepTests } from './parse-tests.js'
import { indentOf, parseInlineList, parsePromptBlock, parseFieldRefBlock, parseWhenBlock } from './parse-primitives.js'
import { parseArtifactsBlock } from './parse-artifacts.js'
import { REMOVED_KEY_ERROR } from './removed-keys.js'


interface GuardFields {
  n?: number
  field?: string
  value?: string
  values?: string[]
  when?: TrackPredicate
}

/** Read the closed sub-fields nested below one guard entry. */
function parseGuardEntry(cur: Cursor, type: string, itemIndent: number): WorkflowGuardConfig {
  const f: GuardFields = {}
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= itemIndent) break
    let m: RegExpExecArray | null
    if ((m = /^\s*n:\s*(\d+)\s*$/.exec(line))) { f.n = Number(m[1]); cur.i++; continue }
    if ((m = /^\s*field:\s*(\S+)\s*$/.exec(line))) { f.field = m[1]; cur.i++; continue }
    // value permits internal spaces so serializer output remains parseable.
    if ((m = /^\s*value:\s*(.+?)\s*$/.exec(line))) { f.value = m[1]; cur.i++; continue }
    if ((m = /^\s*values:\s*(\[.*\])\s*$/.exec(line))) { f.values = parseInlineList(m[1] ?? ''); cur.i++; continue }
    if (/^\s*when:\s*$/.test(line)) { const wi = indentOf(line); cur.i++; f.when = parseWhenBlock(cur, wi); continue }
    throw new Error(`workflow 解析错误：guard '${type}' 出现未知字段行 '${line.trim()}'`)
  }
  return buildGuard(type, f)
}

function requireGuardField(f: GuardFields, type: string): FieldName {
  if (f.field === undefined) throw new Error(`workflow 解析错误：guard '${type}' 缺 field`)
  return f.field as FieldName // FIELD_ORDER 闭集校验在 compileWorkflow，parse 只做语法层构造
}

/** YAML flattens file-exists path.field to field; other guard keys share the definition table. */
const GUARD_FLAT_FIELDS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(GUARD_DATA_KEYS).map(([type, keys]) => [type, keys.map((k) => (k === 'path' ? 'field' : k))]),
)

/** Reject extra fields for known variants; buildGuard reports unknown variants. */
function rejectExtraGuardFields(type: string, f: GuardFields): void {
  // Own-key lookup keeps prototype members from becoming guard variants.
  if (!Object.prototype.hasOwnProperty.call(GUARD_FLAT_FIELDS, type)) return
  const allowed = GUARD_FLAT_FIELDS[type]!
  for (const key of ['n', 'field', 'value', 'values'] as const) {
    if (f[key] !== undefined && !allowed.includes(key)) {
      const permitted = allowed.length ? `${allowed.join('/')}（+ 可选 when）` : '仅可选 when'
      throw new Error(`workflow 解析错误：guard '${type}' 不接受附加字段 '${key}'（该变体只允许 ${permitted}）`)
    }
  }
}

/** Construct a definition guard; compileWorkflow performs the semantic field closure. */
function buildGuard(type: string, f: GuardFields): WorkflowGuardConfig {
  rejectExtraGuardFields(type, f)
  const cond: WorkflowConditional = f.when ? { when: f.when } : {}
  switch (type) {
    case 'tasks-at-least':
      if (f.n === undefined) throw new Error("workflow 解析错误：guard 'tasks-at-least' 缺 n")
      return { type: 'tasks-at-least', n: f.n, ...cond }
    case 'nonempty-output':
      return { type: 'nonempty-output', ...cond }
    case 'field-nonempty':
      return { type: 'field-nonempty', field: requireGuardField(f, type), ...cond }
    case 'file-exists':
      return { type: 'file-exists', path: { kind: 'field', field: requireGuardField(f, type) }, ...cond }
    case 'field-equals':
      if (f.value === undefined) throw new Error("workflow 解析错误：guard 'field-equals' 缺 value")
      return { type: 'field-equals', field: requireGuardField(f, type), value: f.value, ...cond }
    case 'field-in':
      if (f.values === undefined || f.values.length === 0) {
        throw new Error("workflow 解析错误：guard 'field-in' 缺非空 values")
      }
      return { type: 'field-in', field: requireGuardField(f, type), values: f.values as [string, ...string[]], ...cond }
    case 'full-direct-override':
      return { type: 'full-direct-override', ...cond }
    case 'build-head-unchanged':
      return { type: 'build-head-unchanged', field: requireGuardField(f, type) as 'build_sha', ...cond }
    case 'spec-migration-applied':
      return { type: 'spec-migration-applied', ...cond }
    default:
      throw new Error(`workflow 解析错误：未知 guard type '${type}'（闭集见 types.ts WorkflowGuardConfig）`)
  }
}

function parseGuardsBlock(cur: Cursor, baseIndent: number): WorkflowGuardConfig[] {
  const guards: WorkflowGuardConfig[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const m = /^\s*-\s+type:\s*(\S+)\s*$/.exec(line)
    if (!m) break
    const itemIndent = indentOf(line)
    cur.i++
    guards.push(parseGuardEntry(cur, m[1] ?? '', itemIndent))
  }
  return guards
}

const ACTION_TYPES = [
  'freeze-build-sha',
  'reset-pre-verify-review',
  'mark-verification-passed',
  'mark-verification-failed',
  'archive-run',
] as const

/** edge action 块（G2 P2）：`- type: X` 逐项（闭集、无 sub-field）；未知 type → fail-loud。 */
function parseActionsBlock(cur: Cursor, baseIndent: number): WorkflowActionConfig[] {
  const actions: WorkflowActionConfig[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const m = /^\s*-\s+type:\s*(\S+)\s*$/.exec(line)
    if (!m) break
    const type = m[1] ?? ''
    cur.i++
    if (!(ACTION_TYPES as readonly string[]).includes(type)) {
      throw new Error(`workflow 解析错误：未知 action type '${type}'（闭集见 types.ts WorkflowActionConfig）`)
    }
    actions.push({ type: type as WorkflowActionConfig['type'] })
  }
  return actions
}

function parseTransitionsBlock(cur: Cursor, baseIndent: number): StepTransition[] {
  const transitions: StepTransition[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const eventMatch = /^\s*-\s+event:\s*(\S+)\s*$/.exec(line)
    if (!eventMatch) break
    const itemIndent = indentOf(line)
    cur.i++
    const toLine = cur.lines[cur.i] ?? ''
    const toMatch = /^\s*to:\s*(\S+)\s*$/.exec(toLine)
    if (!toMatch) throw new Error(`workflow 解析错误：transitions 里 event '${eventMatch[1]}' 缺 to`)
    cur.i++
    // 可选 edge 级 guards/actions（缩进深于 `- event:` 行）；缺省 = undefined（旧 YAML 逐字不变）。
    let guards: WorkflowGuardConfig[] | undefined
    let actions: WorkflowActionConfig[] | undefined
    while (cur.i < cur.lines.length) {
      const l = cur.lines[cur.i] ?? ''
      if (l.trim() === '') { cur.i++; continue }
      if (indentOf(l) <= itemIndent) break
      if (/^\s*guards:\s*\[\]\s*$/.test(l)) { guards = []; cur.i++; continue }
      if (/^\s*guards:\s*$/.test(l)) { const gi = indentOf(l); cur.i++; guards = parseGuardsBlock(cur, gi); continue }
      if (/^\s*actions:\s*\[\]\s*$/.test(l)) { actions = []; cur.i++; continue }
      if (/^\s*actions:\s*$/.test(l)) { const ai = indentOf(l); cur.i++; actions = parseActionsBlock(cur, ai); continue }
      throw new Error(`workflow 解析错误：transition event '${eventMatch[1]}' 出现未知字段行 '${l.trim()}'`)
    }
    transitions.push({
      event: eventMatch[1] ?? '', to: toMatch[1] ?? '',
      ...(guards !== undefined ? { guards } : {}),
      ...(actions !== undefined ? { actions } : {}),
    })
  }
  return transitions
}

function parseStep(cur: Cursor): StepDef {
  const idLine = cur.lines[cur.i] ?? ''
  const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(idLine)
  if (!idMatch) throw new Error(`workflow 解析错误：期望 '- id: <name>'，实际 '${idLine}'`)
  const id = idMatch[1] ?? ''
  const baseIndent = indentOf(idLine) + 2 // step 内字段比 "- id:" 多缩进 2
  cur.i++

  let label = ''
  let gate: GateKind = null
  let prompt: string | undefined
  let skills: SkillRef[] = []
  let inputs: FieldRef[] = []
  let outputs: FieldRef[] = []
  let artifacts: WorkflowArtifactConfig[] | undefined
  let tests: StepTestDef[] | undefined
  let agents: StepAgentsDef | undefined
  let guards: WorkflowGuardConfig[] = []
  let transitions: StepTransition[] = []

  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent - 2) break
    const labelMatch = /^\s*label:\s*(.+)$/.exec(line)
    if (labelMatch) { label = (labelMatch[1] ?? '').trim(); cur.i++; continue }
    if (/^\s*gate:\s*confirm\s*$/.test(line)) {
      throw new Error(`workflow 解析错误：step '${id}' 的 gate 'confirm' 已移除——需要人工停下用 review，输出齐全即放行用 auto`)
    }
    const gateMatch = /^\s*gate:\s*(review|auto|null)\s*$/.exec(line)
    if (gateMatch) {
      const v = gateMatch[1] ?? ''
      gate = v === 'null' ? null : (v as GateKind)
      cur.i++
      continue
    }
    if (/^\s*prompt:\s*\|-\s*$/.test(line)) {
      const keyIndent = indentOf(line)
      cur.i++
      prompt = parsePromptBlock(cur, keyIndent)
      continue
    }
    if (/^\s*review_lanes:/.test(line)) throw new Error(REMOVED_KEY_ERROR('review_lanes'))
    if (/^\s*skills:\s*\[\]\s*$/.test(line)) { skills = []; cur.i++; continue }
    if (/^\s*skills:\s*$/.test(line)) { cur.i++; skills = parseSkillRefs(cur, baseIndent); continue }
    if (/^\s*inputs:\s*\[\]\s*$/.test(line)) { inputs = []; cur.i++; continue }
    if (/^\s*inputs:\s*$/.test(line)) { cur.i++; inputs = parseFieldRefBlock(cur, baseIndent); continue }
    if (/^\s*outputs:\s*\[\]\s*$/.test(line)) { outputs = []; cur.i++; continue }
    if (/^\s*outputs:\s*$/.test(line)) { cur.i++; outputs = parseFieldRefBlock(cur, baseIndent); continue }
    if (/^\s*artifacts:\s*\[\]\s*$/.test(line)) { artifacts = []; cur.i++; continue }
    if (/^\s*artifacts:\s*$/.test(line)) { cur.i++; artifacts = parseArtifactsBlock(cur, baseIndent); continue }
    if (/^\s*tests:\s*\[\]\s*$/.test(line)) { tests = []; cur.i++; continue }
    if (/^\s*tests:\s*$/.test(line)) { cur.i++; tests = parseStepTests(cur, baseIndent); continue }
    if (/^\s*agents:\s*$/.test(line)) {
      if (agents !== undefined) throw new Error(`workflow 解析错误：step '${id}' 重复声明 agents`)
      const keyIndent = indentOf(line)
      cur.i++
      agents = parseStepAgents(cur, keyIndent, id)
      continue
    }
    if (/^\s*guards:\s*\[\]\s*$/.test(line)) { cur.i++; continue }
    if (/^\s*guards:\s*$/.test(line)) { cur.i++; guards = parseGuardsBlock(cur, baseIndent); continue }
    if (/^\s*transitions:\s*\[\]\s*$/.test(line)) { transitions = []; cur.i++; continue }
    if (/^\s*transitions:\s*$/.test(line)) { cur.i++; transitions = parseTransitionsBlock(cur, baseIndent); continue }
    break
  }

  return {
    id, label, gate, skills, inputs, outputs, guards, transitions,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(tests !== undefined ? { tests } : {}),
    ...(agents !== undefined ? { agents } : {}),
  }
}

export function parseWorkflow(content: string): WorkflowDef {
  const lines = content.split('\n')
  const nameMatch = /^name:\s*(\S+)\s*$/.exec(lines[0] ?? '')
  if (!nameMatch) throw new Error("workflow 解析错误：第一行必须是 'name: <name>'")
  let openspec: boolean | undefined
  let documentContract: WorkflowDocumentContractV1 | undefined
  let decomposition: WorkflowDef['decomposition']
  let interaction: WorkflowDef['interaction']
  let steps: StepDef[] | undefined
  let tracks: Record<string, TrackBranchDef> | undefined
  // name 之后的顶层键顺序无关：每个键各自解析到下一个顶层（缩进 0）行为止。
  const cur: Cursor = { lines, i: 1 }
  while (cur.i < lines.length) {
    const line = lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) !== 0) {
      throw new Error(`workflow 解析错误：顶层出现无法识别的内容 '${line.trim()}'`)
    }
    if (/^openspec_contract:/.test(line)) throw new Error('workflow 解析错误：openspec_contract 已移除——改为 openspec: true 并声明 document_contract')
    const openspecLine = /^openspec:\s*(.*?)\s*$/.exec(line)
    if (openspecLine) {
      if (openspec !== undefined) throw new Error('workflow 解析错误：openspec 重复声明')
      if (openspecLine[1] !== 'true' && openspecLine[1] !== 'false') {
        throw new Error('workflow 解析错误：openspec 只支持 true 或 false')
      }
      openspec = openspecLine[1] === 'true'
      cur.i++
      continue
    }
    const key = line.trim()
    if (key === 'document_contract:') {
      if (documentContract !== undefined) throw new Error('workflow 解析错误：document_contract 重复声明')
      cur.i++
      documentContract = parseDocumentContract(cur, 0)
      continue
    }
    if (key === 'decomposition:') {
      if (decomposition !== undefined) throw new Error('workflow 解析错误：decomposition 重复声明')
      cur.i++
      decomposition = parseDecompositionPolicy(cur)
      continue
    }
    if (key === 'interaction:') {
      if (interaction !== undefined) throw new Error('workflow 解析错误：interaction 重复声明')
      cur.i++
      interaction = parseInteractionPolicy(cur)
      continue
    }
    if (key === 'steps:') {
      if (steps !== undefined) throw new Error('workflow 解析错误：steps 重复声明')
      cur.i++
      steps = parseStepList(cur, 'steps', 0)
      continue
    }
    if (key === 'tracks:') {
      if (tracks !== undefined) throw new Error('workflow 解析错误：tracks 重复声明')
      cur.i++
      tracks = parseTracksBlock(cur)
      continue
    }
    if (key === 'review_budget:') throw new Error(REMOVED_KEY_ERROR('review_budget'))
    throw new Error(`workflow 解析错误：无法识别的顶层键 '${key}'（支持 steps / tracks、openspec、document_contract、decomposition、interaction）`)
  }
  if (steps === undefined && tracks === undefined) {
    throw new Error("workflow 解析错误：缺少 'steps:' 或 'tracks:'")
  }
  // steps ⊕ tracks：有 tracks 的工作流每条轨道各写自己的阶段，顶层 steps 缺省为空（validate 拒绝两者并存）。
  if (tracks !== undefined && documentContract !== undefined) {
    throw new Error('workflow 解析错误：有 tracks 时 document_contract 写在 tracks.<id> 下')
  }
  return {
    name: nameMatch[1] ?? '',
    ...(decomposition ? { decomposition } : {}),
    ...(interaction ? { interaction } : {}),
    ...(openspec === true ? { openspec: true } : {}),
    ...(documentContract ? { documentContract } : {}),
    steps: steps ?? [],
    ...(tracks === undefined ? {} : { tracks }),
  }
}

/**
 * 连续的 `- id:` 步骤项（缩进 > blockIndent）；遇到缩进 ≤ blockIndent 的非空行即停（交还上层判定）。
 * 顶层 steps 与 tracks.<id>.steps 共用，缩进差别由调用方的 blockIndent 表达。
 */
function parseStepList(cur: Cursor, path: string, blockIndent: number): StepDef[] {
  const steps: StepDef[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= blockIndent) break
    if (!/^\s*-\s+id:/.test(line)) {
      throw new Error(`workflow 解析错误：${path} 下每项必须以 '- id:' 开头，实际 '${line}'`)
    }
    steps.push(parseStep(cur))
  }
  return steps
}

/**
 * `tracks:` 块：每条 `  <id>:` 下可选 `label:`、可选 `document_contract:` 与必有的 `steps:`（步骤项缩进再深一层）。
 * 分支 id 词法与 track id 一致（小写字母开头，a-z0-9_-，≤32）。
 */
function parseTracksBlock(cur: Cursor): Record<string, TrackBranchDef> {
  const tracks: Record<string, TrackBranchDef> = {}
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) === 0) break
    const idMatch = /^\s*([a-z][a-z0-9_-]{0,31}):\s*$/.exec(line)
    if (!idMatch || indentOf(line) !== 2) {
      throw new Error(`workflow 解析错误：tracks 下每条分支必须是两空格缩进的 '<track-id>:'，实际 '${line}'`)
    }
    const id = idMatch[1] ?? ''
    if (tracks[id] !== undefined) throw new Error(`workflow 解析错误：tracks 重复声明分支 '${id}'`)
    const branchIndent = indentOf(line)
    cur.i++
    let label: string | undefined
    let documentContract: WorkflowDocumentContractV1 | undefined
    let steps: StepDef[] | undefined
    while (cur.i < cur.lines.length) {
      const inner = cur.lines[cur.i] ?? ''
      if (inner.trim() === '') { cur.i++; continue }
      if (indentOf(inner) <= branchIndent) break
      const labelMatch = /^\s*label:\s*(.+)$/.exec(inner)
      if (labelMatch) {
        if (label !== undefined) throw new Error(`workflow 解析错误：分支 '${id}' 重复声明 label`)
        label = (labelMatch[1] ?? '').trim()
        cur.i++
        continue
      }
      if (/^\s*document_contract:\s*$/.test(inner)) {
        if (documentContract !== undefined) throw new Error(`workflow 解析错误：分支 '${id}' 重复声明 document_contract`)
        cur.i++
        documentContract = parseDocumentContract(cur, indentOf(inner))
        continue
      }
      if (/^\s*steps:\s*$/.test(inner)) {
        if (steps !== undefined) throw new Error(`workflow 解析错误：分支 '${id}' 重复声明 steps`)
        const stepsIndent = indentOf(inner)
        cur.i++
        steps = parseStepList(cur, `tracks.${id}.steps`, stepsIndent)
        continue
      }
      throw new Error(`workflow 解析错误：分支 '${id}' 出现未知字段行 '${inner.trim()}'`)
    }
    if (steps === undefined) throw new Error(`workflow 解析错误：分支 '${id}' 缺 steps`)
    tracks[id] = { ...(label === undefined ? {} : { label }), ...(documentContract === undefined ? {} : { documentContract }), steps }
  }
  return tracks
}
