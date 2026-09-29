/**
 * agent 库的读写状态。官方只读（复制成自定义再改），自定义与项目级可保存正文和删除；新建在终端。
 * 选中项目时一并读项目层（`root`）。终端里登记的 agent 在窗口重新获得焦点时刷新进列表。
 * 删除被工作流引用的 agent 时，server 的 409 带回引用位置，详情页逐行列出。
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/transport'
import {
  AgentReferencedError, copyAgent, deleteAgent, fetchAgent, fetchAgents, saveAgent,
  type AgentDocument, type AgentReference, type AgentSummary,
} from '../api/agentClient'

export interface AgentLibraryState {
  /** 首次读取尚未返回：列表为空不代表「没有」。 */
  readonly loading: boolean
  readonly agents: readonly AgentSummary[]
  readonly selected: AgentDocument | null
  readonly draft: string
  readonly busy: boolean
  readonly error: string | null
  readonly blockedBy: readonly AgentReference[]
  select: (name: string) => void
  setDraft: (content: string) => void
  reload: () => Promise<void>
  save: () => Promise<boolean>
  copy: (name: string) => Promise<boolean>
  remove: () => Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof ApiError && error.message !== '' ? error.message : 'error'
}

export function useAgentLibrary(root = ''): AgentLibraryState {
  const [agents, setAgents] = useState<readonly AgentSummary[]>([])
  const [selected, setSelected] = useState<AgentDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blockedBy, setBlockedBy] = useState<readonly AgentReference[]>([])

  const [loading, setLoading] = useState(true)
  const reload = useCallback(async (): Promise<void> => {
    try {
      setAgents(await fetchAgents(undefined, root))
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [root])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    const onFocus = (): void => { void reload() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  const open = useCallback(async (name: string): Promise<void> => {
    try {
      const document = await fetchAgent(name, undefined, root)
      setSelected(document)
      setDraft(document.content)
      setError(null)
      setBlockedBy([])
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [root])

  const select = useCallback((name: string): void => { void open(name) }, [open])

  const after = useCallback(async (name: string): Promise<void> => {
    await reload()
    await open(name)
  }, [reload, open])

  const guarded = useCallback(async (run: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setBlockedBy([])
    try {
      await run()
      setError(null)
      return true
    } catch (caught) {
      if (caught instanceof AgentReferencedError) setBlockedBy(caught.references)
      setError(messageOf(caught))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    const current = selected
    if (current === null || current.source === 'builtin') return false
    return guarded(async () => {
      await saveAgent(current.name, draft, current.digest, current.source, root)
      await after(current.name)
    })
  }, [selected, draft, guarded, after, root])

  const copy = useCallback(async (name: string): Promise<boolean> => {
    const current = selected
    if (current === null) return false
    return guarded(async () => {
      await copyAgent(current.name, name, root)
      await after(name)
    })
  }, [selected, guarded, after, root])

  const remove = useCallback(async (): Promise<boolean> => {
    const current = selected
    if (current === null || current.source === 'builtin') return false
    return guarded(async () => {
      await deleteAgent(current.name, current.digest, current.source, root)
      setSelected(null)
      setDraft('')
      await reload()
    })
  }, [selected, guarded, reload, root])

  return { loading, agents, selected, draft, busy, error, blockedBy, select, setDraft, reload, save, copy, remove }
}
