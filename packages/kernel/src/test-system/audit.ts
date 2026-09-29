/**
 * 测试体系的审计行：计划写入、豁免批准、基线更新各在 change 的 `.pipeline-history.jsonl` 里留一行
 * `test:<action> key=value …`（kind `tool`，与 `review:request …` 同一形态；actor 是声明的操作者）。
 * 这些写入都会改变门禁的判定依据，历史行让「谁在什么时候改了什么」可查。
 *
 * 计划写入与基线更新由各自的写入口（`writeTestPlan`、`writeTestBaselineV2`）在落盘之后自动留行，
 * 所以任何调用方（CLI 命令、夹具）不需要各自记账；豁免批准由 `tenon review acknowledge` 记。
 * 主写已经提交，审计失败不回滚它：追加失败返回 `failed`，由调用方决定要不要提示。
 */
import type { HistoryEntry } from '../types.js'
import { createHistoryWriter } from '../state/history.js'
import type { RecordActor } from '../users/user.js'

export type TestAuditAction = 'plan-write' | 'waiver-approve' | 'baseline-update'
export type TestAuditOutcome = 'recorded' | 'failed'

type AuditValue = string | number | undefined

/** `key=value` 串；值里的空白折成下划线，一行一条、可 grep；空值省略。 */
export function formatAuditDetail(pairs: Readonly<Record<string, AuditValue>>): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/gu, '_')}`)
    .join(' ')
}

export function testAuditRaw(action: TestAuditAction, pairs: Readonly<Record<string, AuditValue>>): string {
  const detail = formatAuditDetail(pairs)
  return `test:${action}${detail === '' ? '' : ` ${detail}`}`
}

export function testAuditEntry(
  action: TestAuditAction,
  pairs: Readonly<Record<string, AuditValue>>,
  meta: { readonly ts: string; readonly actor: RecordActor },
): HistoryEntry {
  return { ts: meta.ts, kind: 'tool', raw: testAuditRaw(action, pairs), actor: meta.actor }
}

export async function appendTestAudit(changeDir: string, entry: HistoryEntry): Promise<TestAuditOutcome> {
  try {
    await createHistoryWriter().append(changeDir, entry)
    return 'recorded'
  } catch {
    return 'failed'
  }
}
