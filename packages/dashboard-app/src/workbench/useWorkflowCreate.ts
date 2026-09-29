import { useEffect, useMemo, useRef, useState } from 'react'
import { BUILTIN_WORKFLOW_IDS, isBuiltinWorkflowName, isTemplateWorkflowName, isValidWorkflowName } from '@tenon/kernel/workflow/identifier'
import { fetchWorkflow, postWorkflowDef } from '../api/client'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { setOpenspecInDef } from './documentContractEdits'
import { readSaveErrors } from './workbenchApiDecoders'
import { readWorkflowWriteSuccess } from './workbenchWriteResponse'
import { BASE_BRANCH, blankWorkflow, copyWorkflowDef, definitionForWrite, selectBranchDef } from './workbenchDefinition'
import type { CreateNameError, CreatePreview, CreatePreviewTrack, CreateSource, CreateState } from './workflowEditorTypes'

export type { CreateNameError, CreatePreview, CreatePreviewTrack, CreateSource, CreateState } from './workflowEditorTypes'

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

/** `<源>-copy`，占用则 `-copy-2`、`-3`…；空白起点不预填。 */
export function suggestedName(source: CreateSource, taken: ReadonlySet<string>): string {
  if (source === null) return ''
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

const stepName = (step: WbStepDef): string => step.label || step.id

export function stageNames(def: WbWorkflowDef): string[] {
  return selectBranchDef(def, BASE_BRANCH).steps.map(stepName)
}

/** 起点的每条轨道（按声明序）及其阶段名；没有 tracks 的工作流为空。 */
export function trackPreviews(def: WbWorkflowDef): CreatePreviewTrack[] {
  return Object.entries(def.tracks ?? {}).map(([id, branch]) => ({ id, label: branch.label ?? id, stages: branch.steps.map(stepName) }))
}

/** 新建工作流：选起点（空白 / 复制某个工作流）→ 右侧预览阶段 → 命名 → 写入并切过去。 */
export function useWorkflowCreate({ root, names, hasToken, current, blocked, onCreated }: WorkflowCreateInput): CreateState {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const [source, setSourceState] = useState<CreateSource>(null)
  const [name, setNameState] = useState('')
  const [openspec, setOpenspecState] = useState(false)
  const [touched, setTouched] = useState({ name: false, openspec: false, any: false })
  const [preview, setPreview] = useState<CreatePreview>({ status: 'ready', stages: [], tracks: [] })
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
    if (!open) return
    if (source === null) {
      setPreview({ status: 'ready', stages: [blankStage], tracks: [] })
      if (!touched.openspec) setOpenspecState(false)
      return
    }
    const key = `${root}\n${source}`
    const apply = (def: WbWorkflowDef): void => {
      setPreview({ status: 'ready', stages: stageNames(def), tracks: trackPreviews(def) })
      if (!touched.openspec) setOpenspecState(def.openspec === true)
    }
    const cached = definitions.current.get(key)
    if (cached !== undefined) { apply(cached); return }
    let cancelled = false
    setPreview({ status: 'loading' })
    fetchWorkflow(source, root)
      .then((def) => {
        definitions.current.set(key, def)
        if (!cancelled) apply(def)
      })
      .catch((error: unknown) => { if (!cancelled) setPreview({ status: 'error', text: formatApiError(error, localeRef.current.t) }) })
    return () => { cancelled = true }
  }, [open, source, root, blankStage, touched.openspec])

  const nameError = workflowNameError(name, names ?? [])
  const trimmed = name.trim()
  const canSubmit = hasToken && trimmed !== '' && nameError === null && !busy && preview.status === 'ready'

  function openCreate(from: CreateSource = current ?? 'default'): void {
    if (blocked || !hasToken) return
    // 每次打开都重新读起点：上次打开之后可能刚保存过，复制的必须是磁盘上的最新定义。
    definitions.current.clear()
    setSourceState(from)
    setNameState(suggestedName(from, taken))
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
    if (!touched.name) setNameState(suggestedName(next, taken))
  }
  function setName(next: string): void {
    setNameState(next)
    setTouched((value) => ({ ...value, name: true, any: true }))
  }
  function setOpenspec(on: boolean): void {
    setOpenspecState(on)
    setTouched((value) => ({ ...value, openspec: true, any: true }))
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return
    const targetRoot = root
    const base = source === null ? null : definitions.current.get(`${targetRoot}\n${source}`)
    if (base === undefined) return
    const current = ++generation.current
    const stillCurrent = (): boolean => current === generation.current && rootRef.current === targetRoot
    const draft = base === null ? blankWorkflow(trimmed, t('workflow.blank_stage')) : copyWorkflowDef(base, trimmed)
    setBusy(true)
    setErrors([])
    try {
      const response = await postWorkflowDef(trimmed, { ...definitionForWrite(setOpenspecInDef(draft, openspec)), root: targetRoot })
      const locale = localeRef.current
      if (!response.ok) {
        const failed = await readSaveErrors(response, locale.t('workbench.save_unauthorized'), locale.t('common.request_http_error', { status: response.status }), locale.lang === 'zh')
        if (stillCurrent()) setErrors(failed)
        return
      }
      const valid = await readWorkflowWriteSuccess(response)
      if (!stillCurrent()) return
      if (!valid) { setErrors([locale.t('common.invalid_response')]); return }
      setOpen(false)
      onCreatedRef.current(targetRoot, trimmed)
    } catch (error) {
      if (stillCurrent()) setErrors([formatApiError(error, localeRef.current.t)])
    } finally {
      if (stillCurrent()) setBusy(false)
    }
  }

  return {
    open, sources, source, setSource, name, setName, openspec, setOpenspec, nameError, preview, errors, busy, canSubmit,
    dirty: open && touched.any, nameRef, openCreate, close, submit,
  }
}
