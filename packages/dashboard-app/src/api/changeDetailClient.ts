import type { ChangeSnapshot } from '../types'
import { decodeChange } from './snapshotDecoder'
import { ApiError, readJson, throwApiError, wrapNetwork } from './transport'

/** The last decoded detail per change and its ETag: a 304 reuses it as is. */
const known = new Map<string, { etag: string; change: ChangeSnapshot }>()

/**
 * One change with all its evidence (documents, skill / agent runs, tests, test policy, the rules' policy block), as
 * the full snapshot would carry it. The list snapshot omits these; the open task reads them here and reads again
 * when the row's `rev` moves.
 */
export async function fetchChangeDetail(root: string, name: string, signal?: AbortSignal): Promise<ChangeSnapshot> {
  const key = `${root}\u0000${name}`
  const cached = known.get(key)
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(name)}/snapshot?root=${encodeURIComponent(root)}`, {
      ...(signal === undefined ? {} : { signal }),
      headers: cached === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'If-None-Match': cached.etag },
    })
  } catch (error) {
    wrapNetwork(error)
  }
  if (response.status === 304 && cached !== undefined) return cached.change
  if (!response.ok) await throwApiError(response, 'change snapshot request failed')
  const change = decodeChange(await readJson(response))
  if (change === null) throw new ApiError('change snapshot response is invalid')
  const etag = response.headers?.get('ETag') ?? null
  if (etag === null) known.delete(key)
  else known.set(key, { etag, change })
  return change
}
