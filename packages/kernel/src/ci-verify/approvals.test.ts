import { describe, expect, it } from 'vitest'
import type { ProtectedChange } from '../test-system/protected-files.js'
import { parseProtectedApprovals, protectedApprovalFindings } from './approvals.js'
import { ciKeyText } from './text.js'

const D1 = `sha256:${'1'.repeat(64)}`
const D2 = `sha256:${'2'.repeat(64)}`
const CATALOG = '.tenon/tests/catalog.yaml'
const KNOWN = '.tenon/tests/known-failures.yaml'

function line(raw: string, ts = '2026-08-01T00:00:00Z'): string {
  return JSON.stringify({ ts, kind: 'tool', raw })
}

const change = (path: string, digest: string): ProtectedChange => ({
  path, kind: path === CATALOG ? 'catalog' : 'known-failures', status: 'modified', digest,
})

describe('parseProtectedApprovals', () => {
  it('读出路径、摘要与批准人；老格式没有摘要；无关行和损坏行跳过', () => {
    const text = [
      line('Skill: tenon'),
      '{ not json',
      line(`test:protected-approve files=${CATALOG},${KNOWN} digests=${CATALOG}@${D1},${KNOWN}@${D2} by=a@x.io`),
      line(`test:protected-approve files=${KNOWN} by=b@x.io`, '2026-08-02T00:00:00Z'),
      line('test:protected-approvex files=nope'),
    ].join('\n')
    expect(parseProtectedApprovals(text)).toEqual([
      { path: CATALOG, digest: D1, by: 'a@x.io', ts: '2026-08-01T00:00:00Z' },
      { path: KNOWN, digest: D2, by: 'a@x.io', ts: '2026-08-01T00:00:00Z' },
      { path: KNOWN, digest: null, by: 'b@x.io', ts: '2026-08-02T00:00:00Z' },
    ])
  })
})

describe('protectedApprovalFindings', () => {
  const approvals = (digest: string | null) => [{ path: CATALOG, digest, by: 'a@x.io', ts: null }]

  it('没有批准行：protected-unapproved（error，带评审命令）', () => {
    const [finding] = protectedApprovalFindings({ change: 'demo', changes: [change(CATALOG, D1)], approvals: [], text: ciKeyText })
    expect(finding).toMatchObject({ code: 'protected-unapproved', severity: 'error', path: CATALOG, fix: 'tenon review request demo' })
    // 文案按键取：对象说成「种类 路径（状态，摘要）」，语言由调用方的文本源决定。
    expect(finding?.message).toContain('protected.unapproved')
    expect(finding?.message).toContain('protected.kind.catalog')
    expect(finding?.message).toContain('protected.status.')
  })

  it('摘要相等放行；不等 = 批准之后又改了；老格式没有摘要只给警告', () => {
    expect(protectedApprovalFindings({ change: 'demo', changes: [change(CATALOG, D1)], approvals: approvals(D1), text: ciKeyText })).toEqual([])
    expect(protectedApprovalFindings({ change: 'demo', changes: [change(CATALOG, D2)], approvals: approvals(D1), text: ciKeyText }))
      .toEqual([expect.objectContaining({ code: 'protected-changed-after-approval', severity: 'error' })])
    expect(protectedApprovalFindings({ change: 'demo', changes: [change(CATALOG, D2)], approvals: approvals(null), text: ciKeyText }))
      .toEqual([expect.objectContaining({ code: 'protected-approval-unbound', severity: 'warning' })])
  })

  it('同一路径取最后一次批准', () => {
    const later = [...approvals(D1), { path: CATALOG, digest: D2, by: 'a@x.io', ts: null }]
    expect(protectedApprovalFindings({ change: 'demo', changes: [change(CATALOG, D2)], approvals: later, text: ciKeyText })).toEqual([])
  })
})
