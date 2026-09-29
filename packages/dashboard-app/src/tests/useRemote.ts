import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../api/transport'

export type Remote<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly data: T }

/**
 * 读一个只读接口：依赖变化或 reload() 时重取；上一次未完成的请求被取消，晚到的响应不覆盖新的。
 * `enabled=false` 时不请求（保持 loading 之前的状态由调用方决定是否渲染）。
 */
export function useRemote<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): { state: Remote<T>; reload: () => void } {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setState({ status: 'loading' })
    loader.current(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ status: 'ready', data }) },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setState({ status: 'error', error })
      },
    )
    return () => controller.abort()
  }, [enabled, tick, ...deps])
  const reload = useCallback(() => setTick((value) => value + 1), [])
  return { state, reload }
}
