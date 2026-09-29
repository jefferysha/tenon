import { useCallback, useEffect, useState } from 'react'
import { fetchResources } from '../api/resourceClient'
import type { ResourceEntry } from '../api/resourceTypes'
import { isAbortError } from '../api/transport'

export interface DesignResources {
  readonly entries: readonly ResourceEntry[]
  readonly loading: boolean
  /** 目录读不到：「资源」步骤显示错误与重试，其余步骤不受影响。 */
  readonly failed: boolean
  reload: () => void
}

/** 新建项目向导用的资源目录（GET /api/resources），挂载即读一次。 */
export function useDesignResources(): DesignResources {
  const [entries, setEntries] = useState<readonly ResourceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    fetchResources(controller.signal)
      .then((list) => setEntries(list.entries.map((item) => item.entry)))
      .catch((error: unknown) => { if (!isAbortError(error)) setFailed(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [nonce])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { entries, loading, failed, reload }
}
