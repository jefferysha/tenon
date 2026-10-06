/**
 * 链头锚定的核对（纯函数）。交付提交上的 git note 带着当时的链头摘要，note 在 `refs/notes/tenon`，
 * 不在 PR 分支里：把已提交的链整条重写（重算每个摘要）会让锚定的链头不在链里。
 * 锚点不证明链头出自受信机器，也不挡「锚点之后追加」的记录（那是 `anchor-behind`，`--require-anchor` 才升为 error）。
 */
import type { ChainReport } from '../test-system/record-chain.js'
import type { EvidenceNoteEntry } from '../evidence-export/note.js'
import type { CiText } from './text.js'
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
  /** 发现文案的文本源（语言由调用方定）。 */
  readonly text: CiText
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
        ? [finding(input, 'anchor-missing', 'error', input.text('anchor.missing', { change: input.change }))]
        : [],
    }
  }
  const chain = input.chain
  if (chain === undefined || chain.state === 'empty') {
    return {
      state: 'mismatch',
      findings: [finding(input, 'anchor-mismatch', 'error', input.text('anchor.emptyChain', { commit: anchored.commit.slice(0, 12), head: anchorHead }), anchorHead)],
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
        ? finding(input, 'anchor-unverifiable', 'warning', input.text('anchor.unverifiable', { commit: anchored.commit.slice(0, 12), head: anchorHead }), anchorHead)
        : finding(input, 'anchor-mismatch', 'error', input.text('anchor.rewritten', { commit: anchored.commit.slice(0, 12), head: anchorHead }), anchorHead)],
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
      input.text('anchor.behind', { commit: commit.slice(0, 12), head, behind }), head,
    )],
  }
}
