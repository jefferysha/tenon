import { useCallback, useEffect, useState } from 'react'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { deleteTemplate, fetchTemplate, fetchTemplates, saveTemplate } from '../api/instructionsClient'
import type { BuiltinSync, TemplateCategory, TemplateDocument, TemplateRef, TemplateSummary } from '../api/instructionsDecoders'
import { isAbortError } from '../api/transport'

export interface TemplateLibrary {
  readonly loading: boolean
  readonly sync: BuiltinSync | null
  readonly templates: readonly TemplateSummary[]
  readonly selected: TemplateRef | null
  readonly document: TemplateDocument | null
  readonly busy: boolean
  /** 词典键后缀（`library.errors.<key>`）；null = 无错误。 */
  readonly errorKey: string | null
  select: (ref: TemplateRef | null) => void
  reload: () => Promise<void>
  /** 保存当前自定义模板；`category` 与原分类不同时写到新分类下并删掉旧文件。 */
  save: (text: string, category?: TemplateCategory) => Promise<boolean>
  /** 新建自定义模板（「新建」与「复制为自定义」共用），成功后选中它。 */
  create: (category: TemplateCategory, id: string, text: string) => Promise<boolean>
  remove: () => Promise<boolean>
}

const sameRef = (a: TemplateRef | null, b: TemplateRef | null): boolean =>
  a !== null && b !== null && a.source === b.source && a.category === b.category && a.id === b.id

/** 模板库数据面：列表 + 当前选中模板的正文，以及新建 / 保存 / 删除三个写操作。 */
export function useTemplateLibrary(): TemplateLibrary {
  const [loading, setLoading] = useState(true)
  const [sync, setSync] = useState<BuiltinSync | null>(null)
  const [templates, setTemplates] = useState<readonly TemplateSummary[]>([])
  const [selected, setSelected] = useState<TemplateRef | null>(null)
  const [document, setDocument] = useState<TemplateDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await fetchTemplates()
      setSync(list.sync)
      setTemplates(list.templates)
      setErrorKey(null)
    } catch (error) {
      if (!isAbortError(error)) setErrorKey(instructionErrorKey(error))
    } finally {
      setLoading(false)
    }
  }, [])

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
        const loaded = await fetchTemplate(selected, controller.signal)
        setDocument(loaded)
      } catch (error) {
        if (!isAbortError(error)) {
          setDocument(null)
          setErrorKey(instructionErrorKey(error))
        }
      }
    })()
    return () => controller.abort()
  }, [selected])

  const select = useCallback((ref: TemplateRef | null): void => {
    setErrorKey(null)
    setSelected((current) => (sameRef(current, ref) ? current : ref))
  }, [])

  const write = useCallback(async (run: () => Promise<TemplateRef | null>): Promise<boolean> => {
    setBusy(true)
    setErrorKey(null)
    try {
      const next = await run()
      await reload()
      if (next !== null) setSelected(next)
      else setSelected(null)
      return true
    } catch (error) {
      setErrorKey(instructionErrorKey(error))
      return false
    } finally {
      setBusy(false)
    }
  }, [reload])

  const save = useCallback(async (text: string, category?: TemplateCategory): Promise<boolean> => {
    const ref = selected
    const current = document
    if (ref === null || ref.source !== 'custom' || current === null) return false
    if (category !== undefined && category !== ref.category) {
      return write(async () => {
        await saveTemplate(category, ref.id, text, 'absent')
        await deleteTemplate(ref.category, ref.id, current.digest)
        return { source: 'custom', category, id: ref.id }
      })
    }
    return write(async () => {
      await saveTemplate(ref.category, ref.id, text, current.digest)
      const reloaded = await fetchTemplate(ref)
      setDocument(reloaded)
      return ref
    })
  }, [document, selected, write])

  const create = useCallback((category: TemplateCategory, id: string, text: string): Promise<boolean> => write(async () => {
    await saveTemplate(category, id, text, 'absent')
    return { source: 'custom', category, id }
  }), [write])

  const remove = useCallback((): Promise<boolean> => {
    const ref = selected
    const current = document
    if (ref === null || ref.source !== 'custom' || current === null) return Promise.resolve(false)
    return write(async () => {
      await deleteTemplate(ref.category, ref.id, current.digest)
      return null
    })
  }, [document, selected, write])

  return { loading, sync, templates, selected, document, busy, errorKey, select, reload, save, create, remove }
}
