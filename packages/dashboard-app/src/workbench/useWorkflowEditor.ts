import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type SetStateAction } from 'react'
import { isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
import { deleteWorkflowDef, fetchWorkflow, fetchWorkflowIndex, postWorkflowDef, type WorkflowIndex } from '../api/client'
import type { WbEffectiveIo, WbSkillRef, WbStepDef, WbTransition, WbWorkflowDef, WbWorkflowSource } from '../api/governanceTypes'
import { formatApiError, getToken } from '../api/transport'
import { fetchWorkflowYaml, putWorkflowYaml } from '../api/workflowYamlClient'
import { useT } from '../i18n'
import { invalidateWorkflowRules } from '../model/workflowModel'
import { invalidateWorkflowDefinition } from '../workspace/useWorkflowDefinition'
import { draftEffectiveIo, lintWorkflow, type LintIssue } from '../workflow/lint'
import { useMandatorySkills, type MandatoryState } from './mandatoryState'
import { readSaveErrors, readWorkflowDeleteResponse } from './workbenchApiDecoders'
import { readWorkflowWriteSuccess } from './workbenchWriteResponse'
import { useStageDraftEditor } from './useStageDraftEditor'
import { useWorkbenchDirtyState, type WorkbenchDirtySource } from './useWorkbenchDirtyState'
import {
  BASE_BRANCH,
  addSkillToDef,
  addTrackBranch,
  blankWorkflow,
  branchesOf,
  copyWorkflowDef,
  definitionForWrite,
  resolveBranch,
  removeSkillFromDef,
  removeStageFromDef,
  removeTrackBranch,
  renameStepInDef,
  reorderStagesInDef,
  selectBranchDef,
  setGateInDef,
  setStageBackInDef,
  backTransitionOf,
  setStepSkillsInDef,
  workflowNameFromYaml,
  writeBranchDef,
} from './workbenchDefinition'

export type SaveStatus = { kind: 'idle' | 'ok' } | { kind: 'error'; errors: string[]; conflict?: boolean }

export interface WorkflowDeleteError {
  summary: string
  references: Array<{ kind?: string; source?: string }>
  blockers: Array<{ source?: string; detail?: string }>
}

export type CreateMode = 'copy' | 'blank' | 'import'

export interface CreateState {
  open: boolean
  mode: CreateMode
  setMode: (mode: CreateMode) => void
  name: string
  setName: (name: string) => void
  yaml: string
  setYaml: (text: string) => void
  nameInvalid: boolean
  nameDuplicate: boolean
  errors: string[]
  busy: boolean
  canSubmit: boolean
  nameRef: RefObject<HTMLInputElement>
  openCreate: (mode?: CreateMode) => void
  close: () => void
  submit: () => Promise<void>
}

export interface WorkflowEditorInput {
  root: string
  onDirtyChange?: (dirty: boolean) => void
}

export interface WorkflowEditor {
  names: string[] | null
  namesErrorText: string | null
  defaultSource: WbWorkflowSource
  wfName: string | null
  /** 完整定义（含全部分支）；编辑器读路径用 branchDef。 */
  fullDef: WbWorkflowDef | null
  /** 所选分支的单条 pipeline 视图（steps / effectiveIo 已按分支提升）。 */
  def: WbWorkflowDef | null
  defErrorText: string | null
  /** 当前分支：'' = 通用分支，其余 = tracks.<id>。 */
  branch: string
  setBranch: (branch: string) => void
  branches: Array<{ id: string; label: string | null }>
  addTrack: (id: string, label: string) => void
  removeTrack: (id: string) => void
  /** 草稿的物化 IO（字段槽位按草稿重算，文档槽位沿用已保存版本或草稿契约）。 */
  effectiveIo: WbEffectiveIo | undefined
  lint: LintIssue[]
  /** 任一分支有 lint 问题 → 不能保存。 */
  lintBlocked: boolean
  /** 页面是否持有写凭证；无则所有写入口置灰。 */
  canWrite: boolean
  dirty: boolean
  saving: boolean
  saveStatus: SaveStatus
  menuNames: string[]
  stageId: string | null
  setStageId: (id: string | null) => void
  selectedStep: WbStepDef | null
  labelOf: (stepId: string) => string
  mandatory: MandatoryState
  renameStep: (stepId: string, label: string) => void
  setGate: (stepId: string, gate: WbStepDef['gate']) => void
  setStageBack: (stepId: string, to: string | null) => void
  removeStage: (stepId: string) => void
  reorderStages: (fromId: string, toId: string, after: boolean) => void
  setSkills: (stepId: string, skills: readonly WbSkillRef[]) => void
  addSkill: (stepId: string, skillId: string) => void
  removeSkill: (stepId: string, skillId: string) => void
  save: () => Promise<void>
  discardDraft: () => void
  reloadDefinition: () => void
  requestSwitch: (name: string) => void
  confirmSwitch: () => void
  pendingSwitch: string | null
  setPendingSwitch: (name: string | null) => void
  create: CreateState
  exportYaml: () => Promise<string>
  workflowDeleteTarget: { root: string; name: string } | null
  workflowDeleteBusy: boolean
  workflowDeleteError: WorkflowDeleteError | null
  openWorkflowDelete: () => void
  closeWorkflowDelete: () => void
  confirmWorkflowDelete: () => Promise<void>
  stageDraft: ReturnType<typeof useStageDraftEditor>
  setSourceDirty: (source: WorkbenchDirtySource, dirty: boolean) => void
  reportTrackDirty: (dirty: boolean) => void
}

const NAME_RE = /^[\p{L}\p{N}\p{M}_-]+$/u

/**
 * 工作流定义编辑的状态机：列表 / 定义加载（default 亦从服务端读，项目覆盖优先）、草稿与保存、
 * 新建（复制 / 空白 / 导入 YAML）、删除（default = 恢复内建）、切换守卫、阶段草稿、轨道技能矩阵。
 */
export function useWorkflowEditor({ root, onDirtyChange }: WorkflowEditorInput): WorkflowEditor {
  const { t, lang } = useT()
  const [names, setNames] = useState<string[] | null>(null)
  const [defaultSource, setDefaultSource] = useState<WbWorkflowSource>('builtin')
  const [namesError, setNamesError] = useState<unknown | null>(null)
  const [wfName, setWfName] = useState<string | null>(null)
  const [fullDef, setDefState] = useState<WbWorkflowDef | null>(null)
  const [branch, setBranchState] = useState<string>(BASE_BRANCH)
  const [defError, setDefError] = useState<unknown | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [stageId, setStageId] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createMode, setCreateMode] = useState<CreateMode>('copy')
  const [createName, setCreateName] = useState('')
  const [createYaml, setCreateYaml] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createErrors, setCreateErrors] = useState<string[]>([])
  const [workflowDeleteTarget, setWorkflowDeleteTarget] = useState<{ root: string; name: string } | null>(null)
  const [workflowDeleteBusy, setWorkflowDeleteBusy] = useState(false)
  const [workflowDeleteError, setWorkflowDeleteError] = useState<WorkflowDeleteError | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const rootIdentity = useRef(root)
  const workflowIdentity = useRef<string | null>(null)
  const generation = useRef({ save: 0, create: 0, delete: 0, names: 0 })
  const localeRef = useRef({ t, lang })
  rootIdentity.current = root
  workflowIdentity.current = wfName
  localeRef.current = { t, lang }
  const baselineRef = useRef<WbWorkflowDef | null>(null)
  const baselineJson = useRef<string | null>(null)
  // 分支视图：所有读路径看 branchDef；写路径经 setBranchDef 回写到完整定义的对应分支。
  const effectiveBranch = resolveBranch(fullDef, branch)
  const def = useMemo(() => fullDef === null ? null : selectBranchDef(fullDef, effectiveBranch), [fullDef, effectiveBranch])
  const setBranchDef = useCallback((update: SetStateAction<WbWorkflowDef | null>): void => {
    setDefState((previous) => {
      if (previous === null) return previous
      const current = selectBranchDef(previous, effectiveBranch)
      const next = typeof update === 'function' ? update(current) : update
      return next === null ? previous : writeBranchDef(previous, effectiveBranch, next)
    })
  }, [effectiveBranch])
  const stageDraft = useStageDraftEditor({ def, stageId, setDef: setBranchDef, setStageId })
  const { setAddStageOpen } = stageDraft
  const mandatory = useMandatorySkills(root)
  const canWrite = getToken() !== ''

  useEffect(() => {
    setSaveStatus((current) => current.kind === 'error' ? { kind: 'idle' } : current)
    setCreateErrors([])
    setWorkflowDeleteError(null)
  }, [lang])

  // root 切换：全部状态归零，重拉列表。
  useEffect(() => {
    const targetRoot = root
    const current = ++generation.current.names
    generation.current.save += 1
    generation.current.create += 1
    generation.current.delete += 1
    setNames(null)
    setDefaultSource('builtin')
    setNamesError(null)
    setWfName(null)
    setDefState(null)
    setBranchState(BASE_BRANCH)
    setDefError(null)
    setReloadNonce(0)
    setSaving(false)
    setPendingSwitch(null)
    setAddStageOpen(false)
    setCreateOpen(false)
    setCreateErrors([])
    setWorkflowDeleteTarget(null)
    setWorkflowDeleteBusy(false)
    setWorkflowDeleteError(null)
    baselineRef.current = null
    baselineJson.current = null
    let cancelled = false
    fetchWorkflowIndex(targetRoot)
      .then((index: WorkflowIndex) => {
        if (cancelled || current !== generation.current.names || rootIdentity.current !== targetRoot) return
        setNames(index.names)
        setDefaultSource(index.defaultSource)
        setNamesError(null)
        // 有自定义工作流时先落到第一个（多半是正在编辑的那份），否则 default。
        setWfName(index.names[0] ?? 'default')
      })
      .catch((error: unknown) => {
        if (cancelled || current !== generation.current.names || rootIdentity.current !== targetRoot) return
        setNames([])
        setNamesError(error)
        setWfName('default')
      })
    return () => {
      cancelled = true
      generation.current.names += 1
      generation.current.save += 1
      generation.current.create += 1
      generation.current.delete += 1
    }
  }, [root, setAddStageOpen])

  // 定义加载：default 与自定义同一条路（服务端物化 IO 一并带回）。
  useEffect(() => {
    if (!wfName) return
    let cancelled = false
    // 保存成功后的重载不清「已保存」提示；切换工作流时由 switchTo 归零。
    setDefState(null)
    setDefError(null)
    baselineRef.current = null
    baselineJson.current = null
    fetchWorkflow(wfName, root)
      .then((body) => {
        if (cancelled) return
        setDefState(body)
        setDefError(null)
        baselineRef.current = body
        baselineJson.current = JSON.stringify(definitionForWrite(body))
        if (isDefaultWorkflowName(wfName) && body.source !== undefined) setDefaultSource(body.source)
      })
      .catch((error: unknown) => { if (!cancelled) setDefError(error) })
    return () => { cancelled = true }
  }, [root, wfName, reloadNonce])

  useEffect(() => {
    if (!def) return
    setStageId((current) => (current && def.steps.some((step) => step.id === current) ? current : def.steps[0]?.id ?? null))
  }, [def])

  const namesErrorText = namesError === null ? null : t('workbench.names_error', { msg: formatApiError(namesError, t) })
  const defErrorText = defError === null ? null : t('workbench.def_error', { msg: formatApiError(defError, t) })
  const dirty = fullDef !== null && baselineJson.current !== null && JSON.stringify(definitionForWrite(fullDef)) !== baselineJson.current
  const createDirty = createOpen && (createName !== '' || createYaml !== '')
  const { setSourceDirty } = useWorkbenchDirtyState({ localDirty: dirty || createDirty || stageDraft.draftDirty, onDirtyChange })
  const reportTrackDirty = useCallback((value: boolean) => { setSourceDirty('track', value) }, [setSourceDirty])

  const effectiveIo = useMemo(() => {
    if (def === null) return undefined
    const baseline = baselineRef.current === null ? undefined : selectBranchDef(baselineRef.current, effectiveBranch).effectiveIo
    return draftEffectiveIo(def, baseline)
  }, [def, effectiveBranch])
  const lint = useMemo(() => def === null ? [] : lintWorkflow(def, effectiveIo), [def, effectiveIo])
  // 保存门禁看全部分支：任一分支缺输出都不能保存。
  const lintBlocked = useMemo(() => {
    if (fullDef === null) return false
    return branchesOf(fullDef).some((candidate) => {
      const view = selectBranchDef(fullDef, candidate.id)
      const baseline = baselineRef.current === null ? undefined : selectBranchDef(baselineRef.current, candidate.id).effectiveIo
      return lintWorkflow(view, draftEffectiveIo(view, baseline)).length > 0
    })
  }, [fullDef])
  // 名称只显示一个：YAML 有 label 用 label，没有就用 id；前端不做翻译。
  const labelOf = useCallback((stepId: string): string => {
    const step = def?.steps.find((candidate) => candidate.id === stepId)
    return step?.label || stepId
  }, [def])

  const mutate = useCallback((update: (previous: WbWorkflowDef) => WbWorkflowDef): void => {
    setBranchDef((previous) => previous === null ? previous : update(previous))
  }, [setBranchDef])
  const branches = useMemo(() => branchesOf(fullDef), [fullDef])
  const setBranch = useCallback((next: string): void => {
    setBranchState(next)
    setStageId(null)
  }, [])
  const addTrack = useCallback((id: string, label: string): void => {
    setDefState((previous) => previous === null || previous.tracks?.[id] !== undefined ? previous : addTrackBranch(previous, id, label, effectiveBranch))
    setBranchState(id)
    setStageId(null)
  }, [effectiveBranch])
  const removeTrack = useCallback((id: string): void => {
    setDefState((previous) => previous === null ? previous : removeTrackBranch(previous, id))
    setBranchState((current) => current === id ? BASE_BRANCH : current)  // resolveBranch 会落到剩余的第一条
  }, [])
  const renameStep = useCallback((stepId: string, label: string) => mutate((previous) => renameStepInDef(previous, stepId, label)), [mutate])
  const setGate = useCallback((stepId: string, gate: WbStepDef['gate']) => mutate((previous) => setGateInDef(previous, stepId, gate)), [mutate])
  /**
   * 「不退回」摘掉的那条边先记住，重新选目标时整条装回来（只换 to）。否则来回切一次就把
   * `verify-fail` 降级成 `verify-back` 并丢掉它的 actions——事件名和 actions 都是有运行时语义的。
   * 键带上工作流与轨道，切换后不会串味；重新载入定义时清空。
   */
  const removedBack = useRef<Map<string, WbTransition>>(new Map())
  const branchIdentity = useRef(effectiveBranch)
  branchIdentity.current = effectiveBranch
  const setStageBack = useCallback((stepId: string, to: string | null) => mutate((previous) => {
    const key = `${previous.name}:${branchIdentity.current}:${stepId}`
    if (to === null) {
      const current = backTransitionOf(previous, stepId)
      if (current !== null) removedBack.current.set(key, current)
      return setStageBackInDef(previous, stepId, null)
    }
    const remembered = removedBack.current.get(key)
    removedBack.current.delete(key)
    return setStageBackInDef(previous, stepId, to, remembered)
  }), [mutate])
  const removeStage = useCallback((stepId: string): void => {
    mutate((previous) => removeStageFromDef(previous, stepId))
    setStageId((current) => current === stageId ? (def?.steps.filter((step) => step.id !== stepId)[0]?.id ?? null) : current)
  }, [mutate, def, stageId])
  const reorderStages = useCallback((fromId: string, toId: string, after: boolean) => mutate((previous) => reorderStagesInDef(previous, fromId, toId, after)), [mutate])
  const setSkills = useCallback((stepId: string, skills: readonly WbSkillRef[]) => mutate((previous) => setStepSkillsInDef(previous, stepId, skills)), [mutate])
  const addSkill = useCallback((stepId: string, skillId: string) => mutate((previous) => addSkillToDef(previous, stepId, skillId)), [mutate])
  const removeSkill = useCallback((stepId: string, skillId: string) => mutate((previous) => removeSkillFromDef(previous, stepId, skillId)), [mutate])

  function afterWrite(targetRoot: string, name: string): void {
    invalidateWorkflowRules(targetRoot, name)
    invalidateWorkflowDefinition(targetRoot, name)
  }

  async function save(): Promise<void> {
    if (!fullDef || !wfName || !dirty || saving || !canWrite || lintBlocked) return
    const targetRoot = root
    const targetWorkflow = wfName
    const current = ++generation.current.save
    const stillCurrent = (): boolean => current === generation.current.save && rootIdentity.current === targetRoot && workflowIdentity.current === targetWorkflow
    setSaving(true)
    setSaveStatus({ kind: 'idle' })
    try {
      const response = await postWorkflowDef(targetWorkflow, { ...definitionForWrite(fullDef), root: targetRoot })
      if (!response.ok) {
        const locale = localeRef.current
        if (response.status === 409) {
          if (stillCurrent()) setSaveStatus({ kind: 'error', errors: [locale.t('workbench.save_conflict')], conflict: true })
          return
        }
        const errors = await readSaveErrors(response, locale.t('workbench.save_unauthorized'), locale.t('common.request_http_error', { status: response.status }), locale.lang === 'zh')
        if (stillCurrent()) setSaveStatus({ kind: 'error', errors })
        return
      }
      const valid = await readWorkflowWriteSuccess(response)
      if (!stillCurrent()) return
      if (!valid) { setSaveStatus({ kind: 'error', errors: [localeRef.current.t('common.invalid_response')] }); return }
      afterWrite(targetRoot, targetWorkflow)
      baselineRef.current = { ...fullDef, source: 'project' }
      baselineJson.current = JSON.stringify(definitionForWrite(fullDef))
      if (isDefaultWorkflowName(targetWorkflow)) setDefaultSource('project')
      setSaveStatus({ kind: 'ok' })
      // 重新拉一次拿服务端物化后的 IO（文档槽位 / 消费者）。
      setReloadNonce((value) => value + 1)
    } catch (error) {
      if (stillCurrent()) setSaveStatus({ kind: 'error', errors: [formatApiError(error, localeRef.current.t)] })
    } finally {
      if (stillCurrent()) setSaving(false)
    }
  }

  function discardDraft(): void {
    if (saving || baselineRef.current === null) return
    setDefState(baselineRef.current)
    setSaveStatus({ kind: 'idle' })
  }

  function switchTo(name: string): void {
    generation.current.save += 1
    workflowIdentity.current = name
    setSaving(false)
    setSaveStatus({ kind: 'idle' })
    setWfName(name)
    setDefState(null)
    setBranchState(BASE_BRANCH)
    setDefError(null)
    baselineRef.current = null
    baselineJson.current = null
  }
  function requestSwitch(name: string): void {
    if (name === wfName) return
    if (dirty) setPendingSwitch(name)
    else switchTo(name)
  }
  function confirmSwitch(): void {
    if (pendingSwitch !== null) switchTo(pendingSwitch)
    setPendingSwitch(null)
  }

  // ── 新建：复制当前 / 空白 / 导入 YAML ──
  const trimmedName = createName.trim()
  const nameInvalid = trimmedName.length > 0 && !NAME_RE.test(trimmedName)
  const nameDuplicate = trimmedName.length > 0 && (isDefaultWorkflowName(trimmedName) || trimmedName === 'simple' || (names ?? []).includes(trimmedName))
  const canSubmitCreate = canWrite && trimmedName.length > 0 && !nameInvalid && !nameDuplicate && !createBusy
    && (createMode !== 'import' || createYaml.trim() !== '') && (createMode !== 'copy' || fullDef !== null)
  function openCreate(mode: CreateMode = 'copy'): void {
    if (saving || !canWrite) return
    setCreateMode(mode)
    setCreateName(mode === 'copy' ? `${wfName ?? 'workflow'}-copy` : '')
    setCreateYaml('')
    setCreateErrors([])
    setCreateOpen(true)
  }
  function closeCreate(): void {
    if (createBusy) return
    setCreateOpen(false)
    setCreateName('')
    setCreateYaml('')
    setCreateErrors([])
  }
  function setYaml(text: string): void {
    setCreateYaml(text)
    const fromYaml = workflowNameFromYaml(text)
    if (fromYaml !== '' && createName.trim() === '') setCreateName(fromYaml)
  }
  async function submitCreate(): Promise<void> {
    if (!canSubmitCreate) return
    const targetRoot = root
    const name = trimmedName
    const current = ++generation.current.create
    const stillCurrent = (): boolean => current === generation.current.create && rootIdentity.current === targetRoot
    setCreateBusy(true)
    setCreateErrors([])
    try {
      if (createMode === 'import') {
        const text = createYaml.replace(/^name:\s*\S+\s*$/m, `name: ${name}`)
        const result = await putWorkflowYaml(name, targetRoot, text)
        if (!stillCurrent()) return
        if (!result.ok) {
          setCreateErrors(result.errors.length > 0 ? result.errors : [result.status === 401 ? localeRef.current.t('workbench.save_unauthorized') : localeRef.current.t('common.request_http_error', { status: result.status })])
          return
        }
      } else {
        const next = createMode === 'copy' && fullDef !== null ? copyWorkflowDef(fullDef, name) : blankWorkflow(name, localeRef.current.t('workflow.blank_stage'))
        const response = await postWorkflowDef(name, { ...definitionForWrite(next), root: targetRoot })
        if (!response.ok) {
          const locale = localeRef.current
          const errors = await readSaveErrors(response, locale.t('workbench.save_unauthorized'), locale.t('common.request_http_error', { status: response.status }), locale.lang === 'zh')
          if (stillCurrent()) setCreateErrors(errors)
          return
        }
        const valid = await readWorkflowWriteSuccess(response)
        if (!stillCurrent()) return
        if (!valid) { setCreateErrors([localeRef.current.t('common.invalid_response')]); return }
      }
      afterWrite(targetRoot, name)
      setNames((previous) => [...new Set([...(previous ?? []), name])].sort())
      setCreateOpen(false)
      setCreateName('')
      setCreateYaml('')
      switchTo(name)
    } catch (error) {
      if (stillCurrent()) setCreateErrors([formatApiError(error, localeRef.current.t)])
    } finally {
      if (stillCurrent()) setCreateBusy(false)
    }
  }

  async function exportYaml(): Promise<string> {
    if (!wfName) return ''
    return fetchWorkflowYaml(wfName, root)
  }

  // ── 删除（default = 恢复内建，项目或全局覆盖存在时可用）──
  function openWorkflowDelete(): void {
    if (saving || !wfName || !canWrite) return
    if (isDefaultWorkflowName(wfName) && defaultSource === 'builtin') return
    setWorkflowDeleteError(null)
    setWorkflowDeleteTarget({ root, name: wfName })
  }
  function closeWorkflowDelete(): void {
    if (workflowDeleteBusy) return
    setWorkflowDeleteTarget(null)
    setWorkflowDeleteError(null)
  }
  async function confirmWorkflowDelete(): Promise<void> {
    const target = workflowDeleteTarget
    if (!target || target.root !== root || target.name !== wfName || workflowDeleteBusy) { setWorkflowDeleteTarget(null); return }
    const deleting = target.name
    const targetRoot = target.root
    const current = ++generation.current.delete
    const stillCurrent = (): boolean => current === generation.current.delete && rootIdentity.current === targetRoot
    setWorkflowDeleteBusy(true)
    setWorkflowDeleteError(null)
    try {
      const response = await deleteWorkflowDef(deleting, targetRoot)
      const outcome = await readWorkflowDeleteResponse(response)
      if (!stillCurrent()) return
      if (outcome.kind !== 'success') {
        const locale = localeRef.current
        const body = outcome.kind === 'error' ? outcome.body : null
        setWorkflowDeleteError({
          summary: outcome.kind === 'invalid'
            ? locale.t('common.invalid_response')
            : (locale.lang === 'zh' ? body?.error : undefined) ?? (body?.code === 'WORKFLOW_REFERENCED'
              ? locale.t('workbench.workflow_delete_referenced')
              : locale.t('workbench.workflow_delete_failed', { status: response.status })),
          references: locale.lang === 'zh' ? body?.references ?? [] : [],
          blockers: locale.lang === 'zh' ? body?.blockers ?? [] : [],
        })
        return
      }
      afterWrite(targetRoot, deleting)
      setWorkflowDeleteTarget(null)
      setWorkflowDeleteError(null)
      if (isDefaultWorkflowName(deleting)) {
        setDefaultSource('builtin')
        switchTo('default')
        // wfName 没变，定义 effect 不会自己重跑；推 nonce 把内建模板重新拉回来。
        setReloadNonce((value) => value + 1)
        return
      }
      setNames((previous) => (previous ?? []).filter((name) => name !== deleting))
      switchTo('default')
      setReloadNonce((value) => value + 1)
    } catch (error) {
      if (stillCurrent()) setWorkflowDeleteError({ summary: formatApiError(error, localeRef.current.t), references: [], blockers: [] })
    } finally {
      if (stillCurrent()) setWorkflowDeleteBusy(false)
    }
  }

  const selectedStep = def?.steps.find((step) => step.id === stageId) ?? null
  const menuNames = useMemo(() => ['default', ...(names ?? [])], [names])

  return {
    names,
    namesErrorText,
    defaultSource,
    wfName,
    fullDef,
    def,
    defErrorText,
    branch: effectiveBranch,
    setBranch,
    branches,
    addTrack,
    removeTrack,
    effectiveIo,
    lint,
    lintBlocked,
    canWrite,
    dirty,
    saving,
    saveStatus,
    menuNames,
    stageId,
    setStageId,
    selectedStep,
    labelOf,
    mandatory,
    renameStep,
    setGate,
    setStageBack,
    removeStage,
    reorderStages,
    setSkills,
    addSkill,
    removeSkill,
    save,
    discardDraft,
    reloadDefinition: () => { setSaveStatus({ kind: 'idle' }); setReloadNonce((value) => value + 1) },
    requestSwitch,
    confirmSwitch,
    pendingSwitch,
    setPendingSwitch,
    create: {
      open: createOpen,
      mode: createMode,
      setMode: (mode) => { setCreateMode(mode); setCreateErrors([]); if (mode === 'copy' && createName.trim() === '') setCreateName(`${wfName ?? 'workflow'}-copy`) },
      name: createName,
      setName: setCreateName,
      yaml: createYaml,
      setYaml,
      nameInvalid,
      nameDuplicate,
      errors: createErrors,
      busy: createBusy,
      canSubmit: canSubmitCreate,
      nameRef,
      openCreate,
      close: closeCreate,
      submit: submitCreate,
    },
    exportYaml,
    workflowDeleteTarget,
    workflowDeleteBusy,
    workflowDeleteError,
    openWorkflowDelete,
    closeWorkflowDelete,
    confirmWorkflowDelete,
    stageDraft,
    setSourceDirty,
    reportTrackDirty,
  }
}
