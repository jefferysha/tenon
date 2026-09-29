/**
 * 测试体系的审计行：计划写入、豁免批准、基线更新各在 change 的 `.pipeline-history.jsonl` 里留一行
 * `test:<action> key=value …`（kind `tool`，与 `review:request …` 同一形态；actor 由历史写入器按声明的
 * 操作者盖章）。这些写入都不可撤销地改变门禁的判定依据，历史行让「谁在什么时候改了什么」可查。
 *
 * 写入 best-effort：主写已经提交，历史失败只 WARN（同 fields.ts 的 recordHistory）。`tenon test
 * register|unregister|waive|plan --seed` 在 `writeTestPlan` 之后调用 `recordTestPlanWrite`，
 * `tenon test baseline` 在基线落盘之后调用 `recordBaselineUpdate`；批准豁免由 review acknowledge 调用。
 */
import type { CliDeps } from './deps.js'
import { recordHistory } from './commands/fields.js'

export type TestAuditAction = 'plan-write' | 'waiver-approve' | 'baseline-update'

type AuditValue = string | number | undefined

/** `key=value` 串；值里的空白与换行折成下划线，一行一条、可 grep。 */
export function formatAuditDetail(pairs: Readonly<Record<string, AuditValue>>): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/gu, '_')}`)
    .join(' ')
}

export async function recordTestAudit(
  deps: CliDeps,
  changeDir: string,
  action: TestAuditAction,
  pairs: Readonly<Record<string, AuditValue>>,
): Promise<void> {
  const detail = formatAuditDetail(pairs)
  await recordHistory(deps, changeDir, {
    ts: deps.clock(),
    kind: 'tool',
    raw: `test:${action}${detail === '' ? '' : ` ${detail}`}`,
  })
}

/** 计划写入：op 是触发写入的子命令（register / unregister / waive / seed …）。 */
export function recordTestPlanWrite(
  deps: CliDeps,
  changeDir: string,
  input: { readonly op: string; readonly digest: string; readonly subject?: string },
): Promise<void> {
  return recordTestAudit(deps, changeDir, 'plan-write', { op: input.op, subject: input.subject, plan: input.digest })
}

/** 基线更新：套件 × 机器画像 × 来源运行。 */
export function recordBaselineUpdate(
  deps: CliDeps,
  changeDir: string,
  input: { readonly suite: string; readonly profile: string; readonly run: string },
): Promise<void> {
  return recordTestAudit(deps, changeDir, 'baseline-update', { suite: input.suite, profile: input.profile, run: input.run })
}
