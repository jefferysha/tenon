import { useRef, useState, type MutableRefObject } from 'react'
import { isBuiltinWorkflowName, isTemplateWorkflowName } from '@tenon/kernel/workflow/identifier'
import { postWorkflowDef } from '../api/client'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { formatApiError } from '../api/transport'
import { putWorkflowYaml } from '../api/workflowYamlClient'
import { setOpenspecInDef } from './documentContractEdits'
import { readSaveErrors } from './workbenchApiDecoders'
import { blankWorkflow, copyWorkflowDef, definitionForWrite, workflowNameFromYaml } from './workbenchDefinition'
import { readWorkflowWriteSuccess } from './workbenchWriteResponse'
import type { CreateMode, CreateState } from './workflowEditorTypes'

const NAME_RE = /^[\p{L}\p{N}\p{M}_-]+$/u

type Locale = { t: (key: string, vars?: Record<string, string | number>) => string; lang: string }

/** 编辑器里所有异步写动作共用的代次与身份：root / 工作流换了之后，迟到的响应一律丢弃。 */
export interface EditorGenerations {
  save: number
  create: number
  delete: number
  names: number
}

export interface WorkflowCreateContext {
  root: string
  wfName: string | null
  names: string[] | null
  fullDef: WbWorkflowDef | null
  hasToken: boolean
  saving: boolean
  generation: MutableRefObject<EditorGenerations>
  rootIdentity: MutableRefObject<string>
  localeRef: MutableRefObject<Locale>
  afterWrite: (root: string, name: string) => void
  addName: (name: string) => void
  switchTo: (name: string) => void
}

export interface WorkflowCreate {
  create: CreateState
  /** 对话框开着且填了东西：离开前要确认。 */
  dirty: boolean
  /** root 切换：关掉对话框、清掉错误。 */
  reset: () => void
  clearErrors: () => void
}

/** 新建工作流：复制当前 / 空白 / 导入 YAML。成功后切到新工作流。 */
export function useWorkflowCreate(ctx: WorkflowCreateContext): WorkflowCreate {
  const { root, wfName, names, fullDef, hasToken, saving, generation, rootIdentity, localeRef } = ctx
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<CreateMode>('copy')
  const [name, setName] = useState('')
  const [yaml, setYamlText] = useState('')
  const [openspec, setOpenspec] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const nameRef = useRef<HTMLInputElement>(null)

  const trimmedName = name.trim()
  const nameInvalid = trimmedName.length > 0 && !NAME_RE.test(trimmedName)
  const nameDuplicate = trimmedName.length > 0 && (isTemplateWorkflowName(trimmedName) || isBuiltinWorkflowName(trimmedName) || (names ?? []).includes(trimmedName))
  const canSubmit = hasToken && trimmedName.length > 0 && !nameInvalid && !nameDuplicate && !busy
    && (mode !== 'import' || yaml.trim() !== '') && (mode !== 'copy' || fullDef !== null)

  function openCreate(next: CreateMode = 'copy'): void {
    if (saving || !hasToken) return
    setMode(next)
    setName(next === 'copy' ? `${wfName ?? 'workflow'}-copy` : '')
    setOpenspec(next === 'copy' && fullDef?.openspec === true)
    setYamlText('')
    setErrors([])
    setOpen(true)
  }
  function close(): void {
    if (busy) return
    setOpen(false)
    setName('')
    setYamlText('')
    setErrors([])
  }
  function setYaml(text: string): void {
    setYamlText(text)
    const fromYaml = workflowNameFromYaml(text)
    if (fromYaml !== '' && name.trim() === '') setName(fromYaml)
  }
  async function submit(): Promise<void> {
    if (!canSubmit) return
    const targetRoot = root
    const target = trimmedName
    const current = ++generation.current.create
    const stillCurrent = (): boolean => current === generation.current.create && rootIdentity.current === targetRoot
    setBusy(true)
    setErrors([])
    try {
      if (mode === 'import') {
        const text = yaml.replace(/^name:\s*\S+\s*$/m, `name: ${target}`)
        const result = await putWorkflowYaml(target, targetRoot, text)
        if (!stillCurrent()) return
        if (!result.ok) {
          setErrors(result.errors.length > 0 ? result.errors : [result.status === 401 ? localeRef.current.t('workbench.save_unauthorized') : localeRef.current.t('common.request_http_error', { status: result.status })])
          return
        }
      } else {
        const base = mode === 'copy' && fullDef !== null ? copyWorkflowDef(fullDef, target) : blankWorkflow(target, localeRef.current.t('workflow.blank_stage'))
        const next = setOpenspecInDef(base, openspec)
        const response = await postWorkflowDef(target, { ...definitionForWrite(next), root: targetRoot })
        if (!response.ok) {
          const locale = localeRef.current
          const failure = await readSaveErrors(response, locale.t('workbench.save_unauthorized'), locale.t('common.request_http_error', { status: response.status }), locale.lang === 'zh')
          if (stillCurrent()) setErrors(failure)
          return
        }
        const valid = await readWorkflowWriteSuccess(response)
        if (!stillCurrent()) return
        if (!valid) { setErrors([localeRef.current.t('common.invalid_response')]); return }
      }
      ctx.afterWrite(targetRoot, target)
      ctx.addName(target)
      setOpen(false)
      setName('')
      setYamlText('')
      ctx.switchTo(target)
    } catch (error) {
      if (stillCurrent()) setErrors([formatApiError(error, localeRef.current.t)])
    } finally {
      if (stillCurrent()) setBusy(false)
    }
  }

  return {
    create: {
      open,
      mode,
      setMode: (next) => {
        setMode(next)
        setErrors([])
        setOpenspec(next === 'copy' && fullDef?.openspec === true)
        if (next === 'copy' && name.trim() === '') setName(`${wfName ?? 'workflow'}-copy`)
      },
      name,
      setName,
      yaml,
      setYaml,
      openspec,
      setOpenspec,
      nameInvalid,
      nameDuplicate,
      errors,
      busy,
      canSubmit,
      nameRef,
      openCreate,
      close,
      submit,
    },
    dirty: open && (name !== '' || yaml !== ''),
    reset: () => { setOpen(false); setErrors([]) },
    clearErrors: () => setErrors([]),
  }
}
