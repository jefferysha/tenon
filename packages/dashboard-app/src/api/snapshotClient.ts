import type { Snapshot } from '../types'
import { applySnapshotDelta, decodeSnapshot, decodeSnapshotDelta } from './snapshotDecoder'
import { ApiError, getToken, isRecord, readJson, throwDetailedApiError, wrapNetwork } from './transport'

/** The last decoded snapshot and its ETag: when the server answers 304, a refresh reuses it as is. */
let lastSnapshot: { etag: string; snapshot: Snapshot } | undefined

export async function fetchSnapshot(): Promise<Snapshot> {
  const known = lastSnapshot
  let response: Response
  try {
    // The list tier: rows without the per-change evidence, which the open task reads from /api/change/:name/snapshot.
    response = await fetch('/api/snapshot?view=list', {
      headers: known === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'If-None-Match': known.etag },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (response.status === 304 && known !== undefined) return known.snapshot
  if (!response.ok) throw new ApiError(`snapshot request failed (${response.status})`, response.status)
  let body: unknown
  try {
    body = await readJson(response)
  } catch {
    throw new ApiError('snapshot response is invalid')
  }
  const snapshot = decodeSnapshot(body)
  if (!snapshot) throw new ApiError('snapshot response is invalid')
  const etag = response.headers?.get('ETag') ?? null
  lastSnapshot = etag === null ? undefined : { etag, snapshot }
  return snapshot
}

export async function postTransition(name: string, root: string, event: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(name)}/transition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ root, event }),
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwDetailedApiError(response, '转换失败')
}

/**
 * The stream delivers the list tier: one full `snapshot` frame, then a `snapshot-delta` frame holding only the
 * projects whose bytes moved. The last snapshot delivered is the base every delta applies to; a delta that cannot be
 * applied (no base, a project neither side knows) is reported like a broken connection so the caller reconnects.
 */
export function subscribeSnapshot(
  onSnapshot: (snapshot: Snapshot) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource('/api/stream?view=list')
  let current: Snapshot | null = null
  const frameData = (event: Event): unknown => {
    if (!isRecord(event) || typeof event.data !== 'string') return undefined
    try {
      return JSON.parse(event.data)
    } catch {
      return undefined
    }
  }
  // An invalid frame cannot be treated as an authoritative state update. Surface the same
  // failure signal as EventSource.onerror so consumers stop presenting stale data as live.
  const handleSnapshot = (event: Event): void => {
    const snapshot = decodeSnapshot(frameData(event))
    if (snapshot === null) {
      onError?.()
      return
    }
    current = snapshot
    onSnapshot(snapshot)
  }
  const handleDelta = (event: Event): void => {
    const delta = decodeSnapshotDelta(frameData(event))
    const next = delta === null || current === null ? null : applySnapshotDelta(current, delta)
    if (next === null) {
      onError?.()
      return
    }
    current = next
    onSnapshot(next)
  }
  const handleError = (): void => onError?.()
  source.addEventListener('snapshot', handleSnapshot)
  source.addEventListener('snapshot-delta', handleDelta)
  if (onError) source.addEventListener('error', handleError)
  return () => {
    source.removeEventListener('snapshot', handleSnapshot)
    source.removeEventListener('snapshot-delta', handleDelta)
    if (onError) source.removeEventListener('error', handleError)
    source.close()
  }
}
