import { useCallback, useEffect, useRef, useState } from 'react'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { fetchProjectClients, saveProjectClients } from '../api/instructionsClient'
import { isAbortError } from '../api/transport'

export interface EnabledClients {
  readonly loading: boolean
  readonly enabled: readonly string[]
  /** 读取失败：词典键后缀（`projects.errors.<key>`）；null = 无错误。 */
  readonly loadErrorKey: string | null
  /** 最近一次启用 / 停用写入失败：词典键后缀；null = 无错误。 */
  readonly errorKey: string | null
  enable: (id: string) => void
  disable: (id: string) => void
  reload: () => void
}

/**
 * 项目启用了哪些客户端：随项目存在 `.tenon/clients.json`（经 /api/projects/clients），没有文件时由 server
 * 按现有指令文件推断。启用 / 停用立即整份写入：先乐观更新，失败回滚到上次确认的集合并给出错误。
 */
export function useEnabledClients(root: string, revision = ''): EnabledClients {
  const [enabled, setEnabled] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(root !== '')
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // 最后一次被 server 确认的集合（回滚目标）与最新一次写请求的序号（旧请求的回包不覆盖新状态）。
  const confirmedRef = useRef<readonly string[]>([])
  const enabledRef = useRef<readonly string[]>([])
  enabledRef.current = enabled
  const seqRef = useRef(0)
  const rootRef = useRef(root)
  rootRef.current = root

  useEffect(() => {
    seqRef.current += 1
    setEnabled([])
    confirmedRef.current = []
    setErrorKey(null)
    setLoadErrorKey(null)
    if (root === '') {
      setLoading(false)
      return undefined
    }
    const controller = new AbortController()
    setLoading(true)
    fetchProjectClients(root, controller.signal)
      .then((clients) => {
        confirmedRef.current = clients.enabled
        setEnabled(clients.enabled)
      })
      .catch((error: unknown) => { if (!isAbortError(error)) setLoadErrorKey(instructionErrorKey(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [root, attempt])

  // 读失败后，快照恢复（revision 变化，例如断线重连）或窗口重新聚焦时自动重试一次。
  const failedRef = useRef(false)
  failedRef.current = loadErrorKey !== null
  const retry = useCallback((): void => setAttempt((value) => value + 1), [])
  const seenRevision = useRef(revision)
  useEffect(() => {
    if (seenRevision.current === revision) return
    seenRevision.current = revision
    if (failedRef.current) retry()
  }, [revision, retry])
  useEffect(() => {
    const onFocus = (): void => { if (failedRef.current) retry() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [retry])

  const save = useCallback((next: readonly string[]): void => {
    const seq = ++seqRef.current
    const at = rootRef.current
    setEnabled(next)
    setErrorKey(null)
    saveProjectClients(at, next).then((saved) => {
      if (rootRef.current !== at) return
      confirmedRef.current = saved.enabled
      if (seqRef.current === seq) setEnabled(saved.enabled)
    }, (error: unknown) => {
      if (rootRef.current !== at || seqRef.current !== seq) return
      setEnabled(confirmedRef.current)
      setErrorKey(instructionErrorKey(error))
    })
  }, [])

  return {
    loading,
    enabled,
    loadErrorKey,
    errorKey,
    reload: retry,
    enable: (id) => { if (!enabledRef.current.includes(id)) save([...enabledRef.current, id]) },
    disable: (id) => save(enabledRef.current.filter((candidate) => candidate !== id)),
  }
}
