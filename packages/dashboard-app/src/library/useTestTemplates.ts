/**
 * 测试模板库的读状态。模板只读：Dashboard 不建、不改、不删；要把模板变成项目里的套件，
 * 走终端命令 `tenon test catalog add --from <id>`。
 */
import { useCallback, useEffect, useState } from 'react'
import { isAbortError } from '../api/transport'
import { fetchTestTemplates, type TestTemplate } from '../api/testTemplatesClient'

export interface TestTemplateLibrary {
  /** 首次读取尚未返回：列表为空不代表「没有」。 */
  readonly loading: boolean
  readonly templates: readonly TestTemplate[]
  readonly selected: TestTemplate | null
  /** 读取失败的原因（交给 formatApiError）；成功时 null。 */
  readonly error: unknown
  select: (id: string) => void
  reload: () => void
}

export function useTestTemplates(): TestTemplateLibrary {
  const [templates, setTemplates] = useState<readonly TestTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetchTestTemplates(controller.signal).then(
      (next) => { setTemplates(next); setError(null); setLoading(false) },
      (caught: unknown) => {
        if (isAbortError(caught)) return
        setError(caught)
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [tick])
  const reload = useCallback(() => setTick((value) => value + 1), [])
  const select = useCallback((id: string) => setSelectedId(id), [])
  const selected = templates.find((template) => template.id === selectedId) ?? null
  return { loading, templates, selected, error, select, reload }
}
