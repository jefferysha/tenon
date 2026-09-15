import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decodeRecordActor,
  HISTORY_FILE,
  transitionRecordToHistoryEntry,
  validateCanonicalRevisionHistory,
  type HistoryEntry,
  type StateStore,
  type TransitionRecordStore,
} from '@tenon/kernel'

export interface ChangeHistoryDeps {
  store: StateStore
  recordStore: TransitionRecordStore
}

function decodeHistoryEntry(value: unknown): HistoryEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const kinds: ReadonlySet<HistoryEntry['kind']> = new Set([
    'transition', 'set', 'init', 'tool', 'prompt', 'import',
  ])
  if (typeof record.ts !== 'string' || typeof record.kind !== 'string'
    || !kinds.has(record.kind as HistoryEntry['kind'])) return null
  const kind = record.kind as HistoryEntry['kind']
  // An invalid actor is dropped from the row rather than hiding the whole history line.
  const actor = decodeRecordActor(record.actor)
  return {
    ts: record.ts,
    kind,
    ...(typeof record.field === 'string' ? { field: record.field } : {}),
    ...(typeof record.from === 'string' ? { from: record.from } : {}),
    ...(typeof record.to === 'string' ? { to: record.to } : {}),
    ...(actor === undefined || actor === null ? {} : { actor }),
    ...(typeof record.raw === 'string' ? { raw: record.raw } : {}),
    ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record.transitionRecordId === 'string'
      ? { transitionRecordId: record.transitionRecordId }
      : {}),
  }
}

async function readJsonlHistory(changeDir: string): Promise<HistoryEntry[]> {
  let text: string
  try {
    text = await readFile(join(changeDir, HISTORY_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: HistoryEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = decodeHistoryEntry(JSON.parse(trimmed) as unknown)
      if (entry !== null) entries.push(entry)
    } catch {
      // A damaged line is isolated; file-level read failures remain fail-loud above.
    }
  }
  return entries
}

export async function readChangeHistory(
  changeDir: string,
  deps: ChangeHistoryDeps,
): Promise<HistoryEntry[]> {
  const jsonlEntries = await readJsonlHistory(changeDir)
  const state = await deps.store.read(changeDir)
  const metadata = state.runMetadata
  if (!metadata?.transitionHead) return sortByTs(jsonlEntries)

  const chain = await deps.recordStore.readChain(
    changeDir,
    metadata.transitionSequence,
    metadata.transitionHead,
    metadata.runId,
  )
  await validateCanonicalRevisionHistory(changeDir)
  const canonicalEntries = chain.map(transitionRecordToHistoryEntry)
  const legacyOrNonTransition = jsonlEntries.filter(
    (entry) => entry.kind !== 'transition' || entry.transitionRecordId === undefined,
  )
  return mergeCanonicalAndLegacy(canonicalEntries, sortByTs(legacyOrNonTransition))
}

function sortByTs(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

function mergeCanonicalAndLegacy(
  canonicalSorted: HistoryEntry[],
  legacySorted: HistoryEntry[],
): HistoryEntry[] {
  const merged: HistoryEntry[] = []
  let canonicalIndex = 0
  let legacyIndex = 0
  while (canonicalIndex < canonicalSorted.length && legacyIndex < legacySorted.length) {
    const canonical = canonicalSorted[canonicalIndex]
    const legacy = legacySorted[legacyIndex]
    if (canonical === undefined || legacy === undefined) break
    if (legacy.ts <= canonical.ts) {
      merged.push(legacy)
      legacyIndex++
    } else {
      merged.push(canonical)
      canonicalIndex++
    }
  }
  merged.push(...canonicalSorted.slice(canonicalIndex))
  merged.push(...legacySorted.slice(legacyIndex))
  return merged
}
