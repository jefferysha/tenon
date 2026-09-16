/**
 * 测试方向库的读写状态。内建只读（复制成自定义再改），自定义可保存和删除。
 * 错误文案直接来自 server 的 400 体——解析器已经说清楚哪一行不对，前端不再翻译一遍。
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/transport'
import {
  deleteTestDirection, fetchTestDirections, putTestDirection, type TestDirection,
} from '../api/testDirectionsClient'

export interface TestDirectionLibrary {
  readonly directions: readonly TestDirection[]
  readonly selected: TestDirection | null
  readonly draft: string
  readonly busy: boolean
  readonly error: string | null
  select: (id: string) => void
  setDraft: (yaml: string) => void
  reload: () => Promise<void>
  save: () => Promise<boolean>
  copy: () => Promise<boolean>
  remove: () => Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof ApiError && error.message !== '' ? error.message : 'error'
}

export function useTestDirections(): TestDirectionLibrary {
  const [directions, setDirections] = useState<readonly TestDirection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = directions.find((direction) => direction.id === selectedId) ?? null

  const reload = useCallback(async (): Promise<void> => {
    try {
      setDirections(await fetchTestDirections())
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const select = useCallback((id: string): void => {
    setSelectedId(id)
    setError(null)
  }, [])

  useEffect(() => {
    setDraft(selected?.yaml ?? '')
  }, [selected?.id, selected?.yaml])

  const write = useCallback(async (id: string, yaml: string): Promise<boolean> => {
    setBusy(true)
    try {
      await putTestDirection(id, yaml)
      await reload()
      setSelectedId(id)
      setError(null)
      return true
    } catch (caught) {
      setError(messageOf(caught))
      return false
    } finally {
      setBusy(false)
    }
  }, [reload])

  const save = useCallback(async (): Promise<boolean> => {
    if (selected === null || selected.source === 'builtin') return false
    return write(selected.id, draft)
  }, [selected, draft, write])

  const copy = useCallback(async (): Promise<boolean> => {
    if (selected === null) return false
    const id = `${selected.id}-copy`
    return write(id, selected.yaml.replace(`id: ${selected.id}`, `id: ${id}`))
  }, [selected, write])

  const remove = useCallback(async (): Promise<boolean> => {
    if (selected === null || selected.source === 'builtin') return false
    setBusy(true)
    try {
      await deleteTestDirection(selected.id)
      setSelectedId(null)
      await reload()
      return true
    } catch (caught) {
      setError(messageOf(caught))
      return false
    } finally {
      setBusy(false)
    }
  }, [selected, reload])

  return { directions, selected, draft, busy, error, select, setDraft, reload, save, copy, remove }
}
