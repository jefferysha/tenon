/**
 * agent 库的读写状态。内建只读（复制成自定义再改），自定义可保存和删除。
 * 删除被工作流引用的 agent 时，server 的 409 带回引用位置，详情页逐行列出。
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/transport'
import {
  AgentReferencedError, copyAgent, createAgent, deleteAgent, fetchAgent, fetchAgents, saveAgent,
  type AgentDocument, type AgentReference, type AgentSummary,
} from '../api/agentClient'

export interface AgentLibraryState {
  readonly agents: readonly AgentSummary[]
  readonly selected: AgentDocument | null
  readonly draft: string
  readonly busy: boolean
  readonly error: string | null
  readonly blockedBy: readonly AgentReference[]
  select: (name: string) => void
  setDraft: (content: string) => void
  reload: () => Promise<void>
  create: (name: string, content: string) => Promise<boolean>
  save: () => Promise<boolean>
  copy: (name: string) => Promise<boolean>
  remove: () => Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof ApiError && error.message !== '' ? error.message : 'error'
}

export function useAgentLibrary(): AgentLibraryState {
  const [agents, setAgents] = useState<readonly AgentSummary[]>([])
  const [selected, setSelected] = useState<AgentDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blockedBy, setBlockedBy] = useState<readonly AgentReference[]>([])

  const reload = useCallback(async (): Promise<void> => {
    try {
      setAgents(await fetchAgents())
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const open = useCallback(async (name: string): Promise<void> => {
    try {
      const document = await fetchAgent(name)
      setSelected(document)
      setDraft(document.content)
      setError(null)
      setBlockedBy([])
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

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

  const create = useCallback(async (name: string, content: string): Promise<boolean> =>
    guarded(async () => {
      await createAgent(name, content)
      await after(name)
    }), [guarded, after])

  const save = useCallback(async (): Promise<boolean> => {
    const current = selected
    if (current === null || current.source === 'builtin') return false
    return guarded(async () => {
      await saveAgent(current.name, draft, current.digest)
      await after(current.name)
    })
  }, [selected, draft, guarded, after])

  const copy = useCallback(async (name: string): Promise<boolean> => {
    const current = selected
    if (current === null) return false
    return guarded(async () => {
      await copyAgent(current.name, name)
      await after(name)
    })
  }, [selected, guarded, after])

  const remove = useCallback(async (): Promise<boolean> => {
    const current = selected
    if (current === null || current.source === 'builtin') return false
    return guarded(async () => {
      await deleteAgent(current.name, current.digest)
      setSelected(null)
      setDraft('')
      await reload()
    })
  }, [selected, guarded, reload])

  return { agents, selected, draft, busy, error, blockedBy, select, setDraft, reload, create, save, copy, remove }
}
