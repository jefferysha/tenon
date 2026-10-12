import type { WorkflowActionConfig } from './types.js'
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { indentOf } from './parse-primitives.js'

const ACTION_TYPES = [
  'freeze-build-sha',
  'reset-pre-verify-review',
  'mark-verification-passed',
  'mark-verification-failed',
  'archive-run',
] as const

/** edge action 块（G2 P2）：`- type: X` 逐项（闭集、无 sub-field）；未知 type → fail-loud。 */
export function parseActionsBlock(cur: Cursor, baseIndent: number): WorkflowActionConfig[] {
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
