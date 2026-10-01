import { useCallback, useEffect, useState } from 'react'
import { fetchChangeDetail } from '../api/changeDetailClient'
import type { ChangeSnapshot } from '../types'

export type ChangeDetailState =
  /** The row already holds its evidence (full snapshot, older server) or nothing is selected. */
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; change: ChangeSnapshot }
  | { status: 'error'; error: unknown }

/**
 * The open task's evidence, read on demand: `GET /api/change/:name/snapshot`. A row from the list snapshot carries a
 * `rev`; it names the inputs the server read the row from, so the detail is read again exactly when it moves. A row
 * without one came from a snapshot that already holds everything and is used as is.
 *
 * Switching to another task goes back to loading so nothing of the previous one shows. A re-read for the same task
 * keeps the evidence it already has until the new one arrives, so a busy task does not flicker.
 */
export function useChangeDetail(root: string, name: string, rev: string | undefined): { state: ChangeDetailState; retry: () => void } {
  const key = `${root}\u0000${name}`
  const enabled = rev !== undefined && root !== '' && name !== ''
  const [held, setHeld] = useState<{ key: string; state: ChangeDetailState }>({ key: '', state: { status: 'loading' } })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setHeld({ key, state: { status: 'loading' } })
    setAttempt((value) => value + 1)
  }, [key])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetchChangeDetail(root, name, controller.signal)
      .then((change) => { if (!controller.signal.aborted) setHeld({ key, state: { status: 'ready', change } }) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setHeld({ key, state: { status: 'error', error } }) })
    return () => controller.abort()
  }, [enabled, key, root, name, rev, attempt])
  if (!enabled) return { state: { status: 'off' }, retry }
  return { state: held.key === key ? held.state : { status: 'loading' }, retry }
}
