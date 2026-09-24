import { formatReadinessBlocker } from '../model/progressModel'
import type { TransitionReadinessBlockerSnapshot } from '../types'

/**
 * 一条阻断的展示：`label` 是按阻断 code 生成的短标签（i18n key + 变量），认不出的 code 为 null，
 * 视图退回整条 `text`。`text` 是与 CLI 同一份的完整文案，放在行的 title 里。
 */
export interface BlockerLine {
  text: string
  label: { key: string; vars: Record<string, string | number> } | null
}

const TEST_STATE: Record<string, string> = { 运行中: 'running', 未运行: 'missing', 过期: 'stale', 失败: 'failed' }

function tasksLabel(message: string, items: readonly string[] | undefined): BlockerLine['label'] {
  const count = items !== undefined && items.length > 0 ? items.length : Number(/(\d+)\s*项/u.exec(message)?.[1] ?? Number.NaN)
  return Number.isFinite(count) ? { key: 'workspace.blocker_tasks', vars: { n: count } } : { key: 'workspace.blocker_tasks_any', vars: {} }
}

function documentLabel(message: string): BlockerLine['label'] {
  const name = /'([^']+)'/u.exec(message)?.[1]
  if (name === undefined) return null
  return { key: message.startsWith('缺少') ? 'workspace.blocker_document_missing' : 'workspace.blocker_document_stale', vars: { name } }
}

function skillLabel(message: string): BlockerLine['label'] {
  const rest = message.slice(message.indexOf('：') + 1)
  const name = rest.split('（')[0]?.trim() ?? ''
  if (name === '') return null
  return { key: rest.includes('已调用') ? 'workspace.blocker_skill_unrecorded' : 'workspace.blocker_skill', vars: { name } }
}

function testLabel(message: string): BlockerLine['label'] {
  const match = /测试 (.+?)（[^）]+）(运行中|未运行|过期|失败)/u.exec(message)
  const name = match?.[1]
  const state = match?.[2] === undefined ? undefined : TEST_STATE[match[2]]
  return name === undefined || state === undefined ? null : { key: `workspace.blocker_test_${state}`, vars: { name } }
}

function stepExitLabel(code: string, message: string, items: readonly string[] | undefined): BlockerLine['label'] {
  switch (code) {
    case 'tasks-incomplete': return tasksLabel(message, items)
    case 'document-evidence': return documentLabel(message)
    case 'skill-incomplete': return skillLabel(message)
    case 'test-evidence': return testLabel(message)
    default: return null
  }
}

/** 一条阻断 → 展示行：agent 阻断每个 agent 一行，step-exit 按 code 给短标签，其余用完整文案。 */
export function blockerLines(blocker: TransitionReadinessBlockerSnapshot): BlockerLine[] {
  if (blocker.kind === 'agents-incomplete') return blocker.agents.map((item) => ({ text: `${item.agent} · ${item.reason}`, label: null }))
  if (blocker.kind === 'step-exit') return [{ text: blocker.message, label: stepExitLabel(blocker.code, blocker.message, blocker.items) }]
  return [{ text: formatReadinessBlocker(blocker), label: null }]
}
