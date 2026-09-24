import type { Snapshot } from '../types'
import { decodeSnapshot } from './snapshotDecoder'
import { ApiError, getToken, isRecord, readJson, throwDetailedApiError, wrapNetwork } from './transport'

/** The last decoded snapshot and its ETag: when the server answers 304, a refresh reuses it as is. */
let lastSnapshot: { etag: string; snapshot: Snapshot } | undefined

export async function fetchSnapshot(): Promise<Snapshot> {
  const known = lastSnapshot
  let response: Response
  try {
    response = await fetch('/api/snapshot', {
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

export function subscribeSnapshot(
  onSnapshot: (snapshot: Snapshot) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource('/api/stream')
  const handleSnapshot = (event: Event): void => {
    if (!isRecord(event) || typeof event.data !== 'string') {
      onError?.()
      return
    }
    try {
      const snapshot = decodeSnapshot(JSON.parse(event.data))
      if (snapshot === null) {
        onError?.()
        return
      }
      onSnapshot(snapshot)
    } catch {
      // An invalid frame cannot be treated as an authoritative state update. Surface the same
      // failure signal as EventSource.onerror so consumers stop presenting stale data as live.
      onError?.()
    }
  }
  const handleError = (): void => onError?.()
  source.addEventListener('snapshot', handleSnapshot)
  if (onError) source.addEventListener('error', handleError)
  return () => {
    source.removeEventListener('snapshot', handleSnapshot)
    if (onError) source.removeEventListener('error', handleError)
    source.close()
  }
}
