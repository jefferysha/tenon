/**
 * 挂在提交上的证据 note（`refs/notes/tenon`）：一个提交可以交付多个任务，所以正文是一个 JSON 对象，
 * `changes[]` 里每个 (任务, 用户) 一条。带 `anchor` 的条目是 opt-in 的锚定：它声明「这个链头在这个提交上被锚定」，
 * `tenon verify --ci` 才据此核对链；不带 `anchor` 的条目只是证据摘要，verify 不据它判定。
 */

export const EVIDENCE_NOTE_SCHEMA = 'tenon-evidence-note/v1'
export const EVIDENCE_NOTES_REF = 'refs/notes/tenon'
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u
const MAX_ENTRIES = 256
const MAX_TEXT = 512

export interface EvidenceNoteAnchor {
  readonly kind: 'chain-head'
  readonly head: string
}

export interface EvidenceNoteEntry {
  readonly change: string
  /** 记录链所属的用户目录名。 */
  readonly user: string
  readonly chain: {
    readonly head: string
    readonly records: number
    readonly last_run: string
    readonly last_finished_at: string
  }
  readonly plan_digest: string | null
  /** 链上最近一条记录的结论（不是门禁判定；门禁判定要看策略）。 */
  readonly last_result: 'pass' | 'fail'
  readonly anchor?: EvidenceNoteAnchor
  readonly tenon: string
  readonly created_at: string
}

export interface EvidenceNote {
  readonly schema: typeof EVIDENCE_NOTE_SCHEMA
  readonly changes: readonly EvidenceNoteEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_TEXT ? value : undefined
}

function digest(value: unknown): string | undefined {
  return typeof value === 'string' && DIGEST_RE.test(value) ? value : undefined
}

function decodeEntry(value: unknown): EvidenceNoteEntry | undefined {
  if (!isRecord(value) || !isRecord(value.chain)) return undefined
  const change = text(value.change)
  const user = text(value.user)
  const head = digest(value.chain.head)
  const lastRun = text(value.chain.last_run)
  const lastFinished = text(value.chain.last_finished_at)
  const records = value.chain.records
  const tenon = text(value.tenon)
  const createdAt = text(value.created_at)
  if (change === undefined || user === undefined || head === undefined || lastRun === undefined || lastFinished === undefined) return undefined
  if (typeof records !== 'number' || !Number.isInteger(records) || records < 0 || tenon === undefined || createdAt === undefined) return undefined
  const plan = value.plan_digest === null ? null : digest(value.plan_digest)
  if (plan === undefined || (value.last_result !== 'pass' && value.last_result !== 'fail')) return undefined
  let anchor: EvidenceNoteAnchor | undefined
  if (value.anchor !== undefined) {
    const anchored = isRecord(value.anchor) && value.anchor.kind === 'chain-head' ? digest(value.anchor.head) : undefined
    if (anchored === undefined) return undefined
    anchor = { kind: 'chain-head', head: anchored }
  }
  return {
    change, user, chain: { head, records, last_run: lastRun, last_finished_at: lastFinished },
    plan_digest: plan, last_result: value.last_result, ...(anchor === undefined ? {} : { anchor }), tenon, created_at: createdAt,
  }
}

/** 解码一个 note 正文；任何不认识的形状整体判无效（调用方把它当作「没有证据 note」）。 */
export function decodeEvidenceNote(source: string): EvidenceNote | undefined {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.schema !== EVIDENCE_NOTE_SCHEMA || !Array.isArray(value.changes) || value.changes.length > MAX_ENTRIES) return undefined
  const changes: EvidenceNoteEntry[] = []
  for (const raw of value.changes as unknown[]) {
    const entry = decodeEntry(raw)
    if (entry === undefined) return undefined
    changes.push(entry)
  }
  return { schema: EVIDENCE_NOTE_SCHEMA, changes }
}

/** 同 (任务, 用户) 的条目被替换，其余保留；顺序按任务名与用户名，输出稳定。 */
export function mergeEvidenceNote(existing: EvidenceNote | undefined, entry: EvidenceNoteEntry): EvidenceNote {
  const kept = (existing?.changes ?? []).filter((item) => !(item.change === entry.change && item.user === entry.user))
  const changes = [...kept, entry].sort((left, right) =>
    left.change === right.change ? left.user.localeCompare(right.user) : left.change.localeCompare(right.change))
  return { schema: EVIDENCE_NOTE_SCHEMA, changes }
}

export function serializeEvidenceNote(note: EvidenceNote): string {
  return `${JSON.stringify(note, null, 2)}\n`
}
