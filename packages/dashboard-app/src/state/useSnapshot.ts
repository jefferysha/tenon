import { useCallback, useEffect, useState } from 'react'
import { ApiError, fetchSnapshot, NETWORK_ERROR_CODE, subscribeSnapshot } from '../api/client'
import type { Snapshot } from '../types'

export interface SnapshotState {
  snapshot: Snapshot | null
  loading: boolean
  error: ApiError | null
  /** SSE 是否在线（在线 = 实时推送；离线时依赖手动 refresh）。 */
  connected: boolean
  refresh: () => void
  /**
   * 断线横幅「重连」钮驱动（评审修复，task-5-report.md 担忧①）：关闭当前 SSE 订阅、立即重建
   * 一条新的，并补一次全量快照 GET。重连必须发生在这条真订阅本体上——`connected` 才能真正
   * 由新连接的 open/收帧驱动翻正，横幅才会自愈；此前 App.tsx 另开一条独立订阅不满足这一点。
   */
  reconnect: () => void
}

/**
 * 整机快照状态：挂载时 GET /api/snapshot 拉初值 + 订阅 /api/stream SSE 实时更新。
 * SSE 帧到达即替换 snapshot（server 已按指纹去抖，见 snapshot.computeFingerprint）。
 */
export function useSnapshot(): SnapshotState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [connected, setConnected] = useState(false)
  const [nonce, setNonce] = useState(0)
  // 订阅世代计数器，独立于 nonce：只有它变化才关旧连接、开新连接。refresh() 平时被高频调用
  // （例如每次 transition 之后)，不该顺带抖动 SSE 连接；只有 reconnect() 才需要这一步。
  const [streamGen, setStreamGen] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // 重连：bump streamGen 触发下面订阅 effect 的 cleanup（关闭当前 EventSource，复用
  // subscribeSnapshot 已有的 unsub 路径）+ 重跑（开一条新的，同一段既有 subscribe 逻辑，
  // 不复制）；顺带 refresh() 补一次全量 GET，保持“断线期间可能漏帧”的既有补偿语义。
  const reconnect = useCallback(() => {
    setStreamGen((g) => g + 1)
    refresh()
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchSnapshot()
      .then((s) => {
        if (cancelled) return
        setSnapshot(s)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const failure = err instanceof ApiError ? err : new ApiError('snapshot request failed')
        setError(failure)
        // 请求根本没到服务端（进程已退出 / 网络断开）：连接点与断线横幅立即反映。
        if (failure.code === NETWORK_ERROR_CODE) setConnected(false)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  useEffect(() => {
    const unsub = subscribeSnapshot(
      (s) => {
        setSnapshot(s)
        setError(null)
        setConnected(true)
      },
      () => setConnected(false),
    )
    setConnected(true)
    return () => {
      setConnected(false)
      unsub()
    }
  }, [streamGen])

  return { snapshot, loading, error, connected, refresh, reconnect }
}
