/**
 * 受保护测试配置（目录、基线、已知失败、工作流）的评审批准，CI 侧的核对。
 *
 * 批准本身写在用户本机的封存里（CI 读不到）；`tenon review acknowledge`（与 Dashboard 的确认）另在任务的
 * `.pipeline-history.jsonl` 留一行 `test:protected-approve files=… digests=<路径>@<摘要>,… by=…`，这一行随任务提交。
 * CI 只能核对「历史里有没有这样一行、行里的摘要是否等于当前内容」。历史是明文：行可以手写，所以这是
 * 「没走评审流程」的探测，不是批准真实性的证明——报告的信任边界里写明这一点。
 */
import type { ProtectedChange } from '../test-system/protected-files.js'
import { protectedChangeLine } from '../test-system/protected-files.js'
import type { CiFinding } from './types.js'

export interface ProtectedApproval {
  readonly path: string
  /** 批准时的内容摘要；老格式的审计行没有，null。 */
  readonly digest: string | null
  readonly by: string | null
  readonly ts: string | null
}

const APPROVE_PREFIX = 'test:protected-approve'

function fields(raw: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const token of raw.slice(APPROVE_PREFIX.length).split(/\s+/u)) {
    const eq = token.indexOf('=')
    if (eq > 0) out.set(token.slice(0, eq), token.slice(eq + 1))
  }
  return out
}

/** 历史 JSONL 里的批准行，按出现顺序；损坏的行跳过（历史里还有别的行，坏行不该让整份历史作废）。 */
export function parseProtectedApprovals(historyText: string): readonly ProtectedApproval[] {
  const out: ProtectedApproval[] = []
  for (const line of historyText.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const raw: unknown = Reflect.get(row, 'raw')
    if (typeof raw !== 'string' || !(raw === APPROVE_PREFIX || raw.startsWith(`${APPROVE_PREFIX} `))) continue
    const kv = fields(raw)
    const files = (kv.get('files') ?? '').split(',').filter((path) => path !== '')
    const digests = new Map<string, string>()
    for (const entry of (kv.get('digests') ?? '').split(',')) {
      const at = entry.lastIndexOf('@')
      if (at > 0) digests.set(entry.slice(0, at), entry.slice(at + 1))
    }
    const ts: unknown = Reflect.get(row, 'ts')
    for (const path of files) {
      out.push({ path, digest: digests.get(path) ?? null, by: kv.get('by') ?? null, ts: typeof ts === 'string' ? ts : null })
    }
  }
  return out
}

/** 本任务 diff 里的受保护改动，逐项对批准行：同一路径取最后一次批准。 */
export function protectedApprovalFindings(input: {
  readonly change: string
  readonly changes: readonly ProtectedChange[]
  readonly approvals: readonly ProtectedApproval[]
}): readonly CiFinding[] {
  const out: CiFinding[] = []
  const reviewFix = `tenon review request ${input.change}`
  for (const item of input.changes) {
    const approval = [...input.approvals].reverse().find((entry) => entry.path === item.path)
    const base = { change: input.change, path: item.path, subject: item.path, source: 'ci' as const }
    if (approval === undefined) {
      out.push({
        ...base, code: 'protected-unapproved', severity: 'error', fix: reviewFix,
        message: `${protectedChangeLine(item)} 在本任务里改动过，任务历史里没有对应的评审批准行`,
      })
    } else if (approval.digest === null) {
      out.push({
        ...base, code: 'protected-approval-unbound', severity: 'warning',
        message: `${item.path} 的批准行没有记录内容摘要（旧版本写的），无法确认批准之后文件没有再变`,
      })
    } else if (approval.digest !== item.digest) {
      out.push({
        ...base, code: 'protected-changed-after-approval', severity: 'error', fix: reviewFix,
        message: `${item.path} 的当前内容（${item.digest}）与批准过的内容（${approval.digest}）不同`,
      })
    }
  }
  return out
}
