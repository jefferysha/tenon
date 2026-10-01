import { formatReadinessBlocker } from '../model/progressModel'
import type { TransitionReadinessBlockerSnapshot } from '../types'

/**
 * 一条阻断的展示：`label` 是按阻断 code 与服务端给的结构化字段（subject / state / count）生成的短标签
 * （i18n key + 变量），认不出的 code 或字段缺席时为 null，视图退回整条 `text`。`text` 是与 CLI 同一份的
 * 完整文案，只放在行的 title 里——这里绝不解析它（它是服务端的中文整句，不是协议）。
 */
export interface BlockerLine {
  text: string
  label: { key: string; vars: Record<string, string | number> } | null
}

type StepExitBlocker = Extract<TransitionReadinessBlockerSnapshot, { kind: 'step-exit' }>

const DOCUMENT_KEYS: Readonly<Record<string, string>> = {
  missing: 'workspace.blocker_document_missing',
  stale: 'workspace.blocker_document_stale',
  unread: 'workspace.blocker_document_unread',
}
const SKILL_KEYS: Readonly<Record<string, string>> = {
  'not-run': 'workspace.blocker_skill',
  unrecorded: 'workspace.blocker_skill_unrecorded',
}
/** 内联测试阻断：状态 + 测试显示名。 */
const TEST_KEYS: Readonly<Record<string, string>> = {
  running: 'workspace.blocker_test_running',
  missing: 'workspace.blocker_test_missing',
  stale: 'workspace.blocker_test_stale',
  failed: 'workspace.blocker_test_failed',
}
/** 策略阻断：测试完整性与读不到改动不指向某一个测试，只有状态、没有名字。 */
const TEST_POLICY_KEYS: Readonly<Record<string, string>> = {
  integrity: 'workspace.blocker_test_integrity',
  'diff-unavailable': 'workspace.blocker_test_diff_unavailable',
}
const REVIEWER_KEYS: Readonly<Record<string, string>> = {
  'wrong-host': 'workspace.blocker_reviewer_wrong_host',
}
const WRONG_HOST_REASON = 'reviewer-wrong-host'

function tasksLabel(blocker: StepExitBlocker): BlockerLine['label'] {
  const count = blocker.count ?? (blocker.items !== undefined && blocker.items.length > 0 ? blocker.items.length : undefined)
  return count === undefined
    ? { key: 'workspace.blocker_tasks_any', vars: {} }
    : { key: 'workspace.blocker_tasks', vars: { n: count } }
}

function namedLabel(keys: Readonly<Record<string, string>>, blocker: StepExitBlocker): BlockerLine['label'] {
  const key = blocker.state === undefined ? undefined : keys[blocker.state]
  return key === undefined || blocker.subject === undefined || blocker.subject === ''
    ? null
    : { key, vars: { name: blocker.subject } }
}

function testLabel(blocker: StepExitBlocker): BlockerLine['label'] {
  if (blocker.state === undefined) return null
  const policyKey = TEST_POLICY_KEYS[blocker.state]
  if (policyKey !== undefined) return { key: policyKey, vars: {} }
  return namedLabel(TEST_KEYS, blocker)
}

function stepExitLabel(blocker: StepExitBlocker): BlockerLine['label'] {
  switch (blocker.code) {
    case 'tasks-incomplete': return tasksLabel(blocker)
    case 'document-evidence': return namedLabel(DOCUMENT_KEYS, blocker)
    case 'skill-incomplete': return namedLabel(SKILL_KEYS, blocker)
    case 'test-evidence': return testLabel(blocker)
    case WRONG_HOST_REASON: return namedLabel(REVIEWER_KEYS, blocker)
    default: return null
  }
}

/** agent 阻断一行：reason 是 kernel 的阻断码；宿主不符给短标签（评审者名 + 词），其余沿用「agent · 码」。 */
function agentLine(item: { agent: string; reason: string }): BlockerLine {
  const text = `${item.agent} · ${item.reason}`
  return item.reason === WRONG_HOST_REASON && item.agent !== ''
    ? { text, label: { key: 'workspace.blocker_reviewer_wrong_host', vars: { name: item.agent } } }
    : { text, label: null }
}

/** 一条阻断 → 展示行：agent 阻断每个 agent 一行，step-exit 按 code 与结构化字段给短标签，其余用完整文案。 */
export function blockerLines(blocker: TransitionReadinessBlockerSnapshot): BlockerLine[] {
  if (blocker.kind === 'agents-incomplete') return blocker.agents.map(agentLine)
  if (blocker.kind === 'step-exit') return [{ text: blocker.message, label: stepExitLabel(blocker) }]
  return [{ text: formatReadinessBlocker(blocker), label: null }]
}

/** 「下一步」里的一行：`label` 是短标签，`title` 是它背后完整的 CLI 文案。 */
export interface BlockerRow {
  label: string
  title: string
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

interface Draft {
  key: string | null
  vars: Record<string, string | number>
  names: string[]
  texts: string[]
  single: string
}

/**
 * 同类阻断合并成一行：同一个短标签模板（如「缺少文档 {name}」）且带 `name` 的多条，合成一行
 * 「缺少文档 proposal · openspec-design · tasks」，完整文案逐条进 title；合并行落在该类第一条的位置，
 * 其余（认不出的、没有 name 的）保持原顺序。
 */
export function mergeBlockerRows(lines: readonly BlockerLine[], t: Translate): BlockerRow[] {
  const drafts: Draft[] = []
  const byKey = new Map<string, Draft>()
  for (const line of lines) {
    const label = line.label
    if (label === null) {
      drafts.push({ key: null, vars: {}, names: [], texts: [line.text], single: line.text })
      continue
    }
    const name = label.vars.name
    const existing = typeof name === 'string' ? byKey.get(label.key) : undefined
    if (typeof name === 'string' && existing !== undefined) {
      existing.names.push(name)
      existing.texts.push(line.text)
      continue
    }
    const draft: Draft = { key: label.key, vars: label.vars, names: typeof name === 'string' ? [name] : [], texts: [line.text], single: t(label.key, label.vars) }
    if (typeof name === 'string') byKey.set(label.key, draft)
    drafts.push(draft)
  }
  return drafts.map((draft) => ({
    label: draft.key !== null && draft.names.length > 1 ? t(draft.key, { ...draft.vars, name: draft.names.join(' · ') }) : draft.single,
    title: draft.texts.join('\n'),
  }))
}
