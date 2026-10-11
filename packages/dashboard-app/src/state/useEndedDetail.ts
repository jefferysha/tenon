import { useCallback, useEffect, useState } from 'react'
import { fetchChangeDetail } from '../api/changeDetailClient'
import type { ChangeSnapshot } from '../types'

export type EndedDetailState =
  /** No ended task is open. */
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; change: ChangeSnapshot }
  | { status: 'error'; error: unknown }

/**
 * The open ended task, read once and read-only: `GET /api/change/:dir/snapshot?archived=1` (`dir` = the archive
 * directory name). An ended directory never changes, so there is no revision to follow; a retry is the only re-read.
 * Switching to another task goes back to loading so nothing of the previous one shows.
 */
export function useEndedDetail(root: string, dir: string): { state: EndedDetailState; retry: () => void } {
  const key = `${root}\u0000${dir}`
  const enabled = root !== '' && dir !== ''
  const [held, setHeld] = useState<{ key: string; state: EndedDetailState }>({ key: '', state: { status: 'loading' } })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setHeld({ key, state: { status: 'loading' } })
    setAttempt((value) => value + 1)
  }, [key])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetchChangeDetail(root, dir, controller.signal, true)
      .then((change) => { if (!controller.signal.aborted) setHeld({ key, state: { status: 'ready', change } }) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setHeld({ key, state: { status: 'error', error } }) })
    return () => controller.abort()
  }, [enabled, key, root, dir, attempt])
  if (!enabled) return { state: { status: 'off' }, retry }
  return { state: held.key === key ? held.state : { status: 'loading' }, retry }
}
