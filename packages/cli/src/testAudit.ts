/**
 * 测试体系的审计行（CLI 侧）：豁免批准在 change 的 `.pipeline-history.jsonl` 里留一行
 * `test:waiver-approve key=value …`（格式与 kernel 的 `testAuditRaw` 同源，actor 由历史写入器按声明的
 * 操作者盖章）。计划写入与基线更新由 kernel 的写入口（`writeTestPlan`、`writeTestBaselineV2`）在落盘之后
 * 自动留行，命令层不需要各自记账。
 *
 * 写入 best-effort：主写已经提交，历史失败只 WARN（同 fields.ts 的 recordHistory）。
 */
import { testAuditRaw, type TestAuditAction } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { recordHistory } from './commands/fields.js'

export async function recordTestAudit(
  deps: CliDeps,
  changeDir: string,
  action: TestAuditAction,
  pairs: Readonly<Record<string, string | number | undefined>>,
): Promise<void> {
  await recordHistory(deps, changeDir, { ts: deps.clock(), kind: 'tool', raw: testAuditRaw(action, pairs) })
}
