/**
 * 测试方向库的读写状态。内建只读（复制成自定义再改），自定义可保存和删除。
 * 错误文案直接来自 server 的 400 体——解析器已经说清楚哪一行不对，前端不再翻译一遍。
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/transport'
import {
  deleteTestDirection, fetchTestDirections, putTestDirection, type TestDirection,
} from '../api/testDirectionsClient'
import { uniqueCopyId, uniqueCopyTitle } from './templateText'

export interface TestDirectionLibrary {
  /** 首次读取尚未返回：列表为空不代表「没有」。 */
  readonly loading: boolean
  readonly directions: readonly TestDirection[]
  readonly selected: TestDirection | null
  readonly draft: string
  readonly busy: boolean
  readonly error: string | null
  select: (id: string) => void
  setDraft: (yaml: string) => void
  reload: () => Promise<void>
  save: () => Promise<boolean>
  /** 新建自定义方向（标识 new-direction，重名时加序号），成功后选中它。 */
  create: () => Promise<boolean>
  /** 复制为自定义：标识 `<id>-copy`、名称「<名称> <suffix>」，都不与现有条目重名；成功后选中副本。 */
  copy: (suffix: string) => Promise<boolean>
  remove: () => Promise<boolean>
}

/** 改写 YAML 顶层的一行 `key: value`；没有就追加。 */
function withLine(yaml: string, key: string, value: string): string {
  const line = `${key}: ${JSON.stringify(value)}`
  const pattern = new RegExp(`^${key}:.*$`, 'mu')
  return pattern.test(yaml) ? yaml.replace(pattern, line) : `${yaml.replace(/\n?$/u, '\n')}${line}\n`
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

  const [loading, setLoading] = useState(true)
  const reload = useCallback(async (): Promise<void> => {
    try {
      setDirections(await fetchTestDirections())
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
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

  const create = useCallback(async (): Promise<boolean> => {
    const ids = new Set(directions.map((direction) => direction.id))
    let id = 'new-direction'
    for (let n = 2; ids.has(id); n += 1) id = `new-direction-${n}`
    return write(id, `id: ${id}\nlabel: ${id}\ncommand: npm test\n`)
  }, [directions, write])

  const copy = useCallback(async (suffix: string): Promise<boolean> => {
    if (selected === null) return false
    const id = uniqueCopyId(selected.id, new Set(directions.map((direction) => direction.id)))
    const label = uniqueCopyTitle(selected.label, suffix, new Set(directions.map((direction) => direction.label)))
    return write(id, withLine(withLine(selected.yaml, 'id', id), 'label', label))
  }, [directions, selected, write])

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

  return { loading, directions, selected, draft, busy, error, select, setDraft, reload, save, create, copy, remove }
}
