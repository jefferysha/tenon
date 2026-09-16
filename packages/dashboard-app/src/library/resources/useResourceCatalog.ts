import { useCallback, useEffect, useMemo, useState } from 'react'
import { filterResources, type ResourceQuery } from '@tenon/kernel/resources/query'
import {
  ResourceApiError, copyResource as copyResourceRequest, deleteResource, fetchResource, fetchResources,
  resourceErrorKey, saveResource,
} from '../../api/resourceClient'
import type { ResourceCatalogList, ResourceDocument, ResourceDto } from '../../api/resourceTypes'
import { isAbortError } from '../../api/transport'

export interface ResourceCatalogState {
  readonly loading: boolean
  readonly list: ResourceCatalogList
  readonly rows: readonly ResourceDto[]
  readonly query: ResourceQuery
  readonly selected: string | null
  readonly document: ResourceDocument | null
  readonly busy: boolean
  /** 词典键后缀（`resources.errors.<key>`）；null = 无错误。 */
  readonly errorKey: string | null
  /** server 返回的逐条校验错误（保存不合法条目时）。 */
  readonly errorList: readonly string[]
  setQuery: (next: ResourceQuery) => void
  select: (id: string | null) => void
  reload: () => Promise<void>
  save: (id: string, yaml: string, revision?: string) => Promise<boolean>
  copy: () => Promise<boolean>
  remove: () => Promise<boolean>
}

const EMPTY: ResourceCatalogList = { entries: [], errors: [] }

/** 资源目录数据面：一次拉全量，筛选在本地用 kernel 的谓词跑；写操作只作用于自定义条目。 */
export function useResourceCatalog(): ResourceCatalogState {
  const [loading, setLoading] = useState(true)
  const [list, setList] = useState<ResourceCatalogList>(EMPTY)
  const [query, setQuery] = useState<ResourceQuery>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [document, setDocument] = useState<ResourceDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [errorList, setErrorList] = useState<readonly string[]>([])

  const fail = useCallback((error: unknown): void => {
    setErrorKey(resourceErrorKey(error))
    setErrorList(error instanceof ResourceApiError ? error.errors : [])
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setList(await fetchResources())
      setErrorKey(null)
      setErrorList([])
    } catch (error) {
      if (!isAbortError(error)) fail(error)
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (selected === null) {
      setDocument(null)
      return
    }
    const controller = new AbortController()
    void (async () => {
      try {
        setDocument(await fetchResource(selected, controller.signal))
      } catch (error) {
        if (!isAbortError(error)) {
          setDocument(null)
          fail(error)
        }
      }
    })()
    return () => controller.abort()
  }, [fail, selected])

  const rows = useMemo(() => filterResources(list.entries, query), [list.entries, query])

  const select = useCallback((id: string | null): void => {
    setErrorKey(null)
    setErrorList([])
    setSelected(id)
  }, [])

  const write = useCallback(async (run: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true)
    setErrorKey(null)
    setErrorList([])
    try {
      const next = await run()
      await reload()
      setSelected(next)
      return true
    } catch (error) {
      fail(error)
      return false
    } finally {
      setBusy(false)
    }
  }, [fail, reload])

  const save = useCallback((id: string, yaml: string, revision?: string): Promise<boolean> => write(async () => {
    await saveResource(id, yaml, revision)
    setDocument(await fetchResource(id))
    return id
  }), [write])

  const copy = useCallback((): Promise<boolean> => {
    const id = selected
    if (id === null) return Promise.resolve(false)
    return write(async () => (await copyResourceRequest(id)).id)
  }, [selected, write])

  const remove = useCallback((): Promise<boolean> => {
    const current = document
    if (current === null || current.source !== 'custom') return Promise.resolve(false)
    return write(async () => {
      await deleteResource(current.entry.id, current.revision)
      return null
    })
  }, [document, write])

  return { loading, list, rows, query, selected, document, busy, errorKey, errorList, setQuery, select, reload, save, copy, remove }
}
