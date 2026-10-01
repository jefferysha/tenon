/**
 * 交付提交的尾注与证据 note 条目（EvidenceBundle 的纯函数）。尾注是人读的指针：哪个任务、哪个链头；
 * 证据本体在记录链里，锚点在 refs/notes/tenon 的 note 里。
 */
import type { EvidenceNoteEntry } from './note.js'
import type { EvidenceBundle } from './types.js'

export const TRAILER_CHANGE = 'Tenon-Change'
export const TRAILER_EVIDENCE = 'Tenon-Evidence'

export function trailerLines(bundle: Pick<EvidenceBundle, 'change' | 'chain'>): readonly string[] {
  return [`${TRAILER_CHANGE}: ${bundle.change}`, `${TRAILER_EVIDENCE}: ${bundle.chain.head}`]
}

/** `git interpret-trailers --trailer` 的参数形式（`Key: value`）。 */
export function trailerArguments(bundle: Pick<EvidenceBundle, 'change' | 'chain'>): readonly string[] {
  return trailerLines(bundle).flatMap((line) => ['--trailer', line])
}

export function evidenceNoteEntry(bundle: EvidenceBundle, options: { readonly anchor: boolean }): EvidenceNoteEntry {
  const last = bundle.records.at(-1)
  return {
    change: bundle.change,
    user: bundle.chain.user,
    chain: {
      head: bundle.chain.head,
      records: bundle.chain.records,
      last_run: last?.run_id ?? 'none',
      last_finished_at: last?.finished_at ?? bundle.exported_at,
    },
    plan_digest: bundle.plan_digest,
    last_result: bundle.last_result,
    ...(options.anchor ? { anchor: { kind: 'chain-head' as const, head: bundle.chain.head } } : {}),
    tenon: bundle.tenon,
    created_at: bundle.exported_at,
  }
}
