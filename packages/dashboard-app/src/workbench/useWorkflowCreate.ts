import { useEffect, useMemo, useRef, useState } from 'react'
import { BUILTIN_WORKFLOW_IDS, isBuiltinWorkflowName, isTemplateWorkflowName, isValidWorkflowName } from '@tenon/kernel/workflow/identifier'
import { fetchWorkflow, postWorkflowDef } from '../api/client'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { formatApiError } from '../api/transport'
import { putWorkflowYaml } from '../api/workflowYamlClient'
import { useT } from '../i18n'
import { setOpenspecInDef } from './documentContractEdits'
import { readSaveErrors } from './workbenchApiDecoders'
import { readWorkflowWriteSuccess } from './workbenchWriteResponse'
import { blankWorkflow, copyWorkflowDef, definitionForWrite } from './workbenchDefinition'
import type { CreateNameError, CreatePreview, CreatePreviewTrack, CreateSource, CreateState, PreviewSource } from './workflowEditorTypes'
import { IMPORT_SOURCE, readWorkflowImport, renameWorkflowYaml } from './workflowImport'

export type { CreateNameError, CreatePreview, CreatePreviewTrack, CreateSource, CreateState } from './workflowEditorTypes'
export { IMPORT_SOURCE } from './workflowImport'

export interface WorkflowCreateInput {
  root: string
  /** 项目里已有的工作流名（GET /api/workflows）；null = 还没拉到。 */
  names: readonly string[] | null
  hasToken: boolean
  /** 当前打开的工作流：新建时默认从它复制。 */
  current: string | null
  /** 编辑器正在保存：不开新建。 */
  blocked: boolean
  /** 写入成功（对话框随即关闭）。 */
  onCreated: (root: string, name: string) => void
}

/** `<源>-copy`，占用则 `-copy-2`、`-3`…；空白与导入起点不预填（导入随 YAML 里的名字）。 */
export function suggestedName(source: CreateSource, taken: ReadonlySet<string>): string {
  if (source === null || source === IMPORT_SOURCE) return ''
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${source}-copy` : `${source}-copy-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 名称合法 + 不与内建 / 模板 / 已有工作流重名。 */
export function workflowNameError(name: string, names: readonly string[]): CreateNameError {
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (!isValidWorkflowName(trimmed)) return 'invalid'
  return isTemplateWorkflowName(trimmed) || isBuiltinWorkflowName(trimmed) || names.includes(trimmed) ? 'duplicate' : null
}

const stepName = (step: { readonly id: string; readonly label: string }): string => step.label || step.id

/** 起点的阶段名：有轨道时取第一条轨道（与编辑器打开时一致），否则是单条 pipeline。 */
export function stageNames(def: PreviewSource): string[] {
  const first = Object.values(def.tracks ?? {})[0]
  return (first ?? def).steps.map(stepName)
}

/** 起点的每条轨道（按声明序）及其阶段名；没有 tracks 的工作流为空。 */
export function trackPreviews(def: PreviewSource): CreatePreviewTrack[] {
  return Object.entries(def.tracks ?? {}).map(([id, branch]) => ({ id, label: branch.label ?? id, stages: branch.steps.map(stepName) }))
}

const previewOf = (def: PreviewSource): CreatePreview => ({ status: 'ready', stages: stageNames(def), tracks: trackPreviews(def) })

/** 新建工作流：选起点（空白 / 导入 YAML / 复制某个工作流）→ 右侧预览轨道与阶段 → 命名 → 写入并切过去。 */
export function useWorkflowCreate({ root, names, hasToken, current, blocked, onCreated }: WorkflowCreateInput): CreateState {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const [source, setSourceState] = useState<CreateSource>(null)
  const [name, setNameState] = useState('')
  const [openspec, setOpenspecState] = useState(false)
  const [touched, setTouched] = useState({ name: false, openspec: false, any: false })
  const [yaml, setYamlState] = useState('')
  const [loaded, setLoaded] = useState<CreatePreview>({ status: 'ready', stages: [], tracks: [] })
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const definitions = useRef(new Map<string, WbWorkflowDef>())
  const generation = useRef(0)
  const rootRef = useRef(root)
  rootRef.current = root
  const onCreatedRef = useRef(onCreated)
  onCreatedRef.current = onCreated
  const localeRef = useRef({ t, lang })
  localeRef.current = { t, lang }

  const imported = useMemo(() => readWorkflowImport(yaml), [yaml])
  const importing = source === IMPORT_SOURCE
  // 导入起点的预览来自输入框里的 YAML（解析不了就是空的，错误在输入框下方）；其它起点来自读接口。
  const preview = importing ? (imported.status === 'ready' ? previewOf(imported.def) : { status: 'ready' as const, stages: [], tracks: [] }) : loaded

  const sources = useMemo(() => [...new Set(['default', ...BUILTIN_WORKFLOW_IDS, ...(names ?? [])])], [names])
  const taken = useMemo(() => new Set([...sources]), [sources])

  // 换项目：关掉对话框、丢掉缓存的定义，在途请求作废。
  useEffect(() => {
    generation.current += 1
    definitions.current.clear()
    setOpen(false)
    setErrors([])
    setBusy(false)
  }, [root])
  useEffect(() => { setErrors([]) }, [lang])

  // 预览：起点的定义按 root + 名称缓存；空白是一个阶段、没有轨道。拉到后若用户没拨过开关，OpenSpec 跟随起点。
  const blankStage = t('workflow.blank_stage')
  useEffect(() => {
    if (!open || source === IMPORT_SOURCE) return
    if (source === null) {
      setLoaded({ status: 'ready', stages: [blankStage], tracks: [] })
      if (!touched.openspec) setOpenspecState(false)
      return
    }
    const key = `${root}\n${source}`
    const apply = (def: WbWorkflowDef): void => {
      setLoaded(previewOf(def))
      if (!touched.openspec) setOpenspecState(def.openspec === true)
    }
    const cached = definitions.current.get(key)
    if (cached !== undefined) { apply(cached); return }
    let cancelled = false
    setLoaded({ status: 'loading' })
    fetchWorkflow(source, root)
      .then((def) => {
        definitions.current.set(key, def)
        if (!cancelled) apply(def)
      })
      .catch((error: unknown) => { if (!cancelled) setLoaded({ status: 'error', text: formatApiError(error, localeRef.current.t) }) })
    return () => { cancelled = true }
  }, [open, source, root, blankStage, touched.openspec])

  const nameError = workflowNameError(name, names ?? [])
  const trimmed = name.trim()
  const startReady = importing ? imported.status === 'ready' : preview.status === 'ready'
  const canSubmit = hasToken && trimmed !== '' && nameError === null && !busy && startReady

  /** 换起点后的默认名称：复制是 <源>-copy，导入随 YAML 里的名字，空白留空。 */
  function nameFor(from: CreateSource, text: string): string {
    if (from !== IMPORT_SOURCE) return suggestedName(from, taken)
    const parsed = readWorkflowImport(text)
    return parsed.status === 'ready' ? parsed.name : ''
  }

  function openCreate(from: CreateSource = current ?? 'default'): void {
    if (blocked || !hasToken) return
    // 每次打开都重新读起点：上次打开之后可能刚保存过，复制的必须是磁盘上的最新定义。
    definitions.current.clear()
    setSourceState(from)
    setYamlState('')
    setNameState(nameFor(from, ''))
    setOpenspecState(false)
    setTouched({ name: false, openspec: false, any: false })
    setErrors([])
    setOpen(true)
  }
  function close(): void {
    if (busy) return
    setOpen(false)
    setErrors([])
  }
  function setSource(next: CreateSource): void {
    setSourceState(next)
    setErrors([])
    setTouched((value) => ({ ...value, any: true }))
    if (!touched.name) setNameState(nameFor(next, yaml))
  }
  function setYaml(next: string): void {
    setYamlState(next)
    setErrors([])
    setTouched((value) => ({ ...value, any: true }))
    const parsed = readWorkflowImport(next)
    if (parsed.status === 'ready' && (!touched.name || name.trim() === '')) setNameState(parsed.name)
  }
  function setName(next: string): void {
    setNameState(next)
    setTouched((value) => ({ ...value, name: true, any: true }))
  }
  function setOpenspec(on: boolean): void {
    setOpenspecState(on)
    setTouched((value) => ({ ...value, openspec: true, any: true }))
  }

  /** 空白 / 复制：POST 整份定义。返回服务端拒绝的错误列表；null = 写入成功。 */
  async function postDraft(targetRoot: string, base: WbWorkflowDef | null): Promise<string[] | null> {
    const locale = localeRef.current
    const draft = base === null ? blankWorkflow(trimmed, locale.t('workflow.blank_stage')) : copyWorkflowDef(base, trimmed)
    const response = await postWorkflowDef(trimmed, { ...definitionForWrite(setOpenspecInDef(draft, openspec)), root: targetRoot })
    if (!response.ok) {
      return readSaveErrors(response, locale.t('workbench.save_unauthorized'), locale.t('common.request_http_error', { status: response.status }), locale.lang === 'zh')
    }
    return await readWorkflowWriteSuccess(response) ? null : [locale.t('common.invalid_response')]
  }

  /** 导入：名称以对话框里的为准，PUT YAML 原文，服务端解析 + 校验后才落盘。 */
  async function putImported(targetRoot: string): Promise<string[] | null> {
    const locale = localeRef.current
    const result = await putWorkflowYaml(trimmed, targetRoot, renameWorkflowYaml(yaml, trimmed))
    if (result.ok) return null
    if (result.errors.length > 0) return result.errors
    return [result.status === 401 ? locale.t('workbench.save_unauthorized') : locale.t('common.request_http_error', { status: result.status })]
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return
    const targetRoot = root
    const base = importing || source === null ? null : definitions.current.get(`${targetRoot}\n${source}`)
    if (base === undefined) return
    const current = ++generation.current
    const stillCurrent = (): boolean => current === generation.current && rootRef.current === targetRoot
    setBusy(true)
    setErrors([])
    try {
      const failed = importing ? await putImported(targetRoot) : await postDraft(targetRoot, base)
      if (!stillCurrent()) return
      if (failed !== null) { setErrors(failed); return }
      setOpen(false)
      onCreatedRef.current(targetRoot, trimmed)
    } catch (error) {
      if (stillCurrent()) setErrors([formatApiError(error, localeRef.current.t)])
    } finally {
      if (stillCurrent()) setBusy(false)
    }
  }

  return {
    open, sources, source, setSource, name, setName, yaml, setYaml, yamlError: imported.status === 'error' ? imported.text : null,
    openspec, setOpenspec, nameError, preview, errors, busy, canSubmit,
    dirty: open && touched.any, nameRef, openCreate, close, submit,
  }
}
