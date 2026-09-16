import { useCallback, useEffect, useState } from 'react'
import { fetchCurrentUser, type CurrentUserState } from '../api/userClient'

/**
 * Declared user for a root (`''` = aggregate view). Refetches when the root changes and after `refresh()`; a failed
 * request leaves the state `null`, so the top bar simply shows no user.
 */
export function useCurrentUser(root: string): { state: CurrentUserState | null; refresh: () => void } {
  const [state, setState] = useState<CurrentUserState | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetchCurrentUser(root, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setState(next) })
      .catch(() => { if (!controller.signal.aborted) setState(null) })
    return () => controller.abort()
  }, [root, nonce])
  const refresh = useCallback(() => setNonce((value) => value + 1), [])
  return { state, refresh }
}
