/**
 * Hook-facing projections: <changeDir>/.breadcrumb is a current-phase cache; the root-level
 * review marker is a versioned projection of a canonical review request.  Transition never writes
 * the latter — only `tenon review request` does — so work inside explore/spec/verify cannot be
 * blocked merely because the phase was entered.
 *
 * REVIEW_MARKER_FILE 的字面量与 types.ts::GATE_MARKERS[1] 相同但并非派生自它——GATE_MARKERS
 * 目前在 TS 代码里没有消费方（marker 拦截的运行时真相源是 hooks/gate.sh 动态拼接
 * `.pipeline-pending-$kind`），两处独立持有同一个稳定协议文件名，不是「决策逻辑」重复。
 *
 * `REVIEW_MARKER_FILE` remains a stable hook ABI.  Its identity fields are deliberately parsed by
 * shell hooks as well as TypeScript readers, so do not change the v2 first line without a migration.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const BREADCRUMB_FILE = '.breadcrumb'
export const REVIEW_MARKER_FILE = '.pipeline-pending-review'
/** Versioned so a newly installed runtime can safely recognise and retire entry-time legacy markers. */
export const REVIEW_MARKER_PROTOCOL = 'pipeline-review-v2'

export interface ReviewMarkerReceipt {
  readonly phase: string
  readonly changeName: string
  /** Exact outgoing transition selected for this human decision. */
  readonly event: string
  readonly requestedAt: string
}

export interface BreadcrumbWriter {
  write(changeDir: string, content: string): Promise<void>
}

export function createBreadcrumbWriter(): BreadcrumbWriter {
  return {
    async write(changeDir: string, content: string): Promise<void> {
      await writeFile(join(changeDir, BREADCRUMB_FILE), content, 'utf8')
    },
  }
}

/** review 相位的 marker 指引文案。自定义 workflow 的非标准 step 也必须能获得安全的通用提示。 */
export function reviewHint(phase: string): string {
  switch (phase) {
    case 'explore': return 'design_doc（深度设计 / 调研 + 关键决策）'
    case 'spec': return 'plan / 用户旅程 / delta spec（实施计划）'
    case 'verify': return 'verification_report（验证结论）'
    default: return '（待复核）'
  }
}

/**
 * Review request 的版本化 marker：只由 `tenon review request` 在 canonical pending state 成功
 * 后写入。它是 hook 的即时拦截投影；真正的 approval receipt 保存在 canonical state。
 */
export function formatReviewMarker(receipt: ReviewMarkerReceipt): string {
  return [
    REVIEW_MARKER_PROTOCOL,
    `phase=${receipt.phase}`,
    `change=${receipt.changeName}`,
    `event=${receipt.event}`,
    `requested_at=${receipt.requestedAt}`,
    reviewHint(receipt.phase),
    '',
  ].join('\n')
}

/**
 * Parse the additive event field while retaining v2 marker identity compatibility. A pre-event v2
 * projection returns `event: ''`: hooks can still identify its Change, but transition refuses the
 * corresponding legacy canonical receipt until a new event-bound request is made.
 */
export function parseReviewMarker(content: string): ReviewMarkerReceipt | null {
  const lines = content.split('\n')
  if (lines[0] !== REVIEW_MARKER_PROTOCOL) return null
  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const index = line.indexOf('=')
    if (index <= 0) break
    fields.set(line.slice(0, index), line.slice(index + 1))
  }
  const phase = fields.get('phase') ?? ''
  const changeName = fields.get('change') ?? ''
  const event = fields.get('event') ?? ''
  const requestedAt = fields.get('requested_at') ?? ''
  if (phase === '' || changeName === '' || requestedAt === '') return null
  return { phase, changeName, event, requestedAt }
}

/**
 * The single review marker cleanup used by terminal and Dashboard acknowledgements. A marker that
 * belongs to another Change or event is left alone: it is not this decision's projection. Unlink
 * errors other than ENOENT propagate so the caller can report a non-fatal marker warning.
 */
export async function clearReviewMarkerFor(root: string, change: string, event: string): Promise<void> {
  const marker = join(root, REVIEW_MARKER_FILE)
  let content: string
  try {
    content = await readFile(marker, 'utf8')
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  const receipt = parseReviewMarker(content)
  if (receipt === null || receipt.changeName !== change) return
  if (receipt.event !== '' && receipt.event !== event) return
  try {
    await unlink(marker)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
