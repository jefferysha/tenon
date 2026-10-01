/**
 * 链头锚定的核对（纯函数）。交付提交上的 git note 带着当时的链头摘要，note 在 `refs/notes/tenon`，
 * 不在 PR 分支里：把已提交的链整条重写（重算每个摘要）会让锚定的链头不在链里。
 * 锚点不证明链头出自受信机器，也不挡「锚点之后追加」的记录（那是 `anchor-behind`，`--require-anchor` 才升为 error）。
 */
import type { ChainReport } from '../test-system/record-chain.js'
import type { EvidenceNoteEntry } from '../evidence-export/note.js'
import type { AnchorState, CiFinding } from './types.js'

export interface AnchorEvidence {
  /** note 所在的提交。 */
  readonly commit: string
  readonly entry: EvidenceNoteEntry
}

export interface AnchorInput {
  readonly change: string
  /** 判定用的链所属的用户目录名；没有链时 null。 */
  readonly user: string | null
  /** 这个任务上可见的 note 条目，新的在前。 */
  readonly anchors: readonly AnchorEvidence[]
  readonly chain: ChainReport | undefined
  /** chain-base 标记里的基点摘要（最老一端被清理过时存在）。 */
  readonly baseDigest: string | undefined
  readonly requireAnchor: boolean
}

export interface AnchorOutcome {
  readonly state: AnchorState
  readonly findings: readonly CiFinding[]
}

function finding(
  input: AnchorInput, code: string, severity: CiFinding['severity'], message: string, subject?: string,
): CiFinding {
  return {
    code, severity, change: input.change, message, source: 'ci',
    ...(subject === undefined ? {} : { subject }),
    // 重新锚定只修「落后 / 缺失」；链被重写时再锚定一次等于给伪造的链盖章，所以不给修复命令。
    ...(code === 'anchor-behind' || code === 'anchor-missing'
      ? { fix: `tenon evidence export ${input.change} --format git-notes --anchor --apply` } : {}),
  }
}

export function evaluateAnchor(input: AnchorInput): AnchorOutcome {
  const anchored = input.anchors.find((item) => item.entry.anchor !== undefined && item.entry.user === input.user)
  const anchorHead = anchored?.entry.anchor?.head
  if (anchored === undefined || anchorHead === undefined) {
    return {
      state: 'none',
      findings: input.requireAnchor
        ? [finding(input, 'anchor-missing', 'error', `任务 ${input.change} 的交付提交上没有 refs/notes/tenon 锚点（--require-anchor）`)]
        : [],
    }
  }
  const chain = input.chain
  if (chain === undefined || chain.state === 'empty') {
    return {
      state: 'mismatch',
      findings: [finding(input, 'anchor-mismatch', 'error', `提交 ${anchored.commit.slice(0, 12)} 锚定了链头 ${anchorHead}，但已提交的记录链是空的`, anchorHead)],
    }
  }
  // 链已经断了：`record-chain-broken` 是更根本的发现，这里不再重复。
  if (chain.state === 'broken') return { state: 'mismatch', findings: [] }
  const digests = chain.active.map((record) => record.digest)
  const index = digests.indexOf(anchorHead)
  if (index === -1 && input.baseDigest === anchorHead) {
    return outcomeFor(input, anchored.commit, anchorHead, digests.length)
  }
  if (index === -1) {
    const pruned = input.baseDigest !== undefined
    return {
      state: pruned ? 'unverifiable' : 'mismatch',
      findings: [pruned
        ? finding(input, 'anchor-unverifiable', 'warning', `提交 ${anchored.commit.slice(0, 12)} 锚定的链头 ${anchorHead} 不在保留的记录里（较老的记录已按保留上限清理）`, anchorHead)
        : finding(input, 'anchor-mismatch', 'error', `提交 ${anchored.commit.slice(0, 12)} 锚定的链头 ${anchorHead} 不在已提交的记录链里：链在锚定之后被重写`, anchorHead)],
    }
  }
  return outcomeFor(input, anchored.commit, anchorHead, digests.length - 1 - index)
}

function outcomeFor(input: AnchorInput, commit: string, head: string, behind: number): AnchorOutcome {
  if (behind === 0) return { state: 'verified', findings: [] }
  return {
    state: 'behind',
    findings: [finding(
      input, 'anchor-behind', input.requireAnchor ? 'error' : 'warning',
      `提交 ${commit.slice(0, 12)} 锚定了链头 ${head}，之后又追加了 ${behind} 条记录；这些记录没有被锚定`, head,
    )],
  }
}
