import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { deleteWorkflowDef, fetchWorkflow, fetchWorkflowNames, postWorkflowDef } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { DEFAULT_RULES, invalidateWorkflowRules, rulesKey, useWorkflowRulesMulti } from '../model/workflowModel'
import { PHASES, type Snapshot } from '../types'
import type { BoardLane, LanePatch } from './boardLane'
import { useHooksConfig, type HooksConfigState } from './hooksConfig'
import { useLoops, type LoopsState } from './LoopCard'
import { useMandatorySkills, type MandatoryState } from './mandatoryState'
import { readSaveErrors, readWorkflowDeleteResponse } from './workbenchApiDecoders'
import { useRecentWorkflowHistory } from './useRecentWorkflowHistory'
import { readWorkflowWriteSuccess } from './workbenchWriteResponse'
import { useWorkbenchBoard } from './useWorkbenchBoard'
import { useStageDraftEditor } from './useStageDraftEditor'
import { useWorkbenchDirtyState, type WorkbenchDirtySource } from './useWorkbenchDirtyState'
import {
  addSkillToDef,
  buildDefaultDef,
  editLaneInDef,
  moveSkillInDef,
  removeSkillFromDef,
  removeStageFromDef,
  reorderStagesInDef,
  setLaneGuardInDef,
  setSkillDepInDef,
  workflowForCreate,
  type SkillMove,
  type WbStepDef,
  type WbWorkflowDef,
} from './workbenchDefinition'
import type { ChangeHistoryEntry } from '../api/client'

export type SaveStatus = { kind: 'idle' | 'ok' } | { kind: 'error'; errors: string[]; conflict?: boolean }

export interface WorkflowDeleteError {
  summary: string
  references: Array<{ kind?: string; source?: string }>
  blockers: Array<{ source?: string; detail?: string }>
}

export interface WorkflowEditorInput {
  root: string
  snapshot: Snapshot | null
  onToggleError?: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
}

export interface WorkflowEditor {
  names: string[] | null
  namesErrorText: string | null
  wfName: string | null
  def: WbWorkflowDef | null
  defErrorText: string | null
  readonlyWf: boolean
  dirty: boolean
  policyDirty: boolean
  saving: boolean
  saveStatus: SaveStatus
  menuNames: string[]
  stagesCountOf: (name: string) => number | null
  stageId: string | null
  setStageId: (id: string | null) => void
  selectedStep: WbStepDef | null
  selectedLane: BoardLane | undefined
  boardLanes: BoardLane[]
  summary: { stages: number; gates: number; skills: number; hooks: number | null } | null
  hooksConfig: HooksConfigState
  mandatory: MandatoryState
  loops: LoopsState
  recent: Array<ChangeHistoryEntry & { change: string }> | null
  recentSilent: number
  setDef: (updater: (previous: WbWorkflowDef | null) => WbWorkflowDef | null) => void
  editLane: (laneId: string, patch: LanePatch) => void
  replaceStep: (updated: WbStepDef) => void
  removeStage: (laneId: string) => void
  reorderStages: (fromId: string, toId: string, after: boolean) => void
  addSkill: (stageId: string, skillId: string) => void
  removeSkill: (stageId: string, skillId: string) => void
  moveSkill: (move: SkillMove) => void
  setSkillDependency: (stageId: string, skillId: string, dep: string | null, prevDep: string | null) => void
  setLaneGuard: (laneId: string, enabled: boolean) => void
  save: () => Promise<void>
  discardDraft: () => void
  reloadDefinition: () => void
  cancelPolicyDraft: () => void
  requestSwitch: (name: string) => void
  confirmSwitch: () => void
  pendingSwitch: string | null
  setPendingSwitch: (name: string | null) => void
  workflowCreateMode: 'new' | 'copy' | null
  workflowDraftName: string
  setWorkflowDraftName: (name: string) => void
  workflowNameInvalid: boolean
  workflowNameDuplicate: boolean
  workflowOpErrors: string[]
  workflowOpBusy: boolean
  canSubmitWorkflow: boolean
  workflowNameRef: RefObject<HTMLInputElement>
  openWorkflowCreate: (mode: 'new' | 'copy') => void
  closeWorkflowCreate: () => void
  confirmWorkflowCreate: () => Promise<void>
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

/**
 * 工作流定义编辑的状态机（原 WorkbenchView 的非渲染部分原样搬运）：加载 names/def、脏态与保存、
 * 新建 / 复制 / 删除、切换守卫、阶段草稿、hooks / 强制技能 / loops 三份 per-root 配置。
 * 视图层（workflow/WorkflowView）只做三列装配，不再持有任何写路径。
 */
export function useWorkflowEditor({ root, snapshot, onToggleError, onDirtyChange }: WorkflowEditorInput): WorkflowEditor {
  const { t, lang } = useT()
  const defaultLabels = useMemo(() => Object.fromEntries(PHASES.map((phase) => [phase, t(`phases.${phase}`)])), [t])
  const localizedDefaultDef = useMemo(() => buildDefaultDef(defaultLabels), [defaultLabels])
  const [names, setNames] = useState<string[] | null>(null)
  const [namesError, setNamesError] = useState<unknown | null>(null)
  const [wfName, setWfName] = useState<string | null>(null)
  const [def, setDefState] = useState<WbWorkflowDef | null>(null)
  const [defError, setDefError] = useState<unknown | null>(null)
  const [definitionReloadNonce, setDefinitionReloadNonce] = useState(0)
  const [stageId, setStageId] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [workflowCreateMode, setWorkflowCreateMode] = useState<'new' | 'copy' | null>(null)
  const [workflowDraftName, setWorkflowDraftName] = useState('')
  const workflowDraftBaseline = useRef('')
  const [workflowOpBusy, setWorkflowOpBusy] = useState(false)
  const [workflowOpErrors, setWorkflowOpErrors] = useState<string[]>([])
  const [workflowDeleteTarget, setWorkflowDeleteTarget] = useState<{ root: string; name: string } | null>(null)
  const [workflowDeleteBusy, setWorkflowDeleteBusy] = useState(false)
  const [workflowDeleteError, setWorkflowDeleteError] = useState<WorkflowDeleteError | null>(null)
  const workflowNameRef = useRef<HTMLInputElement>(null)
  const rootIdentity = useRef(root)
  const workflowIdentity = useRef<string | null>(null)
  const saveGeneration = useRef(0)
  const createGeneration = useRef(0)
  const deleteGeneration = useRef(0)
  const namesGeneration = useRef(0)
  const localeIdentity = useRef({ t, lang })
  rootIdentity.current = root
  workflowIdentity.current = wfName
  localeIdentity.current = { t, lang }
  const [promptSkipDirty, setPromptSkipDirty] = useState(false)
  const defSnapshotRef = useRef<string | null>(null)
  const defBaselineRef = useRef<WbWorkflowDef | null>(null)
  const setDef = useCallback((updater: (previous: WbWorkflowDef | null) => WbWorkflowDef | null): void => {
    setDefState(updater)
  }, [])
  const stageDraft = useStageDraftEditor({ def, stageId, setDef: setDefState, setStageId })
  const { setAddStageOpen } = stageDraft
  const hooksConfig = useHooksConfig(root, onToggleError, setPromptSkipDirty)
  const mandatory = useMandatorySkills(root)
  const { recent, recentSilent } = useRecentWorkflowHistory(snapshot, root, wfName)
  const loops = useLoops(root)

  useEffect(() => {
    setSaveStatus((current) => current.kind === 'error' ? { kind: 'idle' } : current)
    setWorkflowOpErrors([])
    setWorkflowDeleteError(null)
  }, [lang])

  useEffect(() => {
    const targetRoot = root
    const generation = ++namesGeneration.current
    ++saveGeneration.current
    ++createGeneration.current
    ++deleteGeneration.current
    setNames(null)
    setNamesError(null)
    setWfName(null)
    setDefState(null)
    setDefError(null)
    setDefinitionReloadNonce(0)
    setSaving(false)
    setPendingSwitch(null)
    setAddStageOpen(false)
    setWorkflowCreateMode(null)
    setWorkflowDraftName('')
    workflowDraftBaseline.current = ''
    setWorkflowOpBusy(false)
    setWorkflowOpErrors([])
    setWorkflowDeleteTarget(null)
    setWorkflowDeleteBusy(false)
    setWorkflowDeleteError(null)
    setPromptSkipDirty(false)
    defSnapshotRef.current = null
    defBaselineRef.current = null
    let cancelled = false
    fetchWorkflowNames(targetRoot)
      .then((loaded) => {
        if (cancelled || generation !== namesGeneration.current || rootIdentity.current !== targetRoot) return
        setNames(loaded)
        setNamesError(null)
        setWfName(loaded[0] ?? 'default')
      })
      .catch((err: unknown) => {
        if (cancelled || generation !== namesGeneration.current || rootIdentity.current !== targetRoot) return
        setNames([])
        setNamesError(err)
        setWfName('default')
      })
    return () => {
      cancelled = true
      ++namesGeneration.current
      ++saveGeneration.current
      ++createGeneration.current
      ++deleteGeneration.current
    }
    // setAddStageOpen 是 useState 的 setter，身份稳定；实际只在 root 变化时重跑。
  }, [root, setAddStageOpen])

  useEffect(() => {
    if (!wfName) return
    setSaveStatus({ kind: 'idle' })
    if (wfName === 'default') {
      setDefState(localizedDefaultDef)
      setDefError(null)
      defSnapshotRef.current = null
      defBaselineRef.current = localizedDefaultDef
      return
    }
    let cancelled = false
    setDefState(null)
    setDefError(null)
    defSnapshotRef.current = null
    defBaselineRef.current = null
    fetchWorkflow(wfName, root)
      .then((body) => {
        if (cancelled) return
        setDefState(body)
        setDefError(null)
        defSnapshotRef.current = JSON.stringify(body)
        defBaselineRef.current = body
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDefError(err)
      })
    return () => {
      cancelled = true
    }
  }, [root, wfName, definitionReloadNonce, localizedDefaultDef])

  useEffect(() => {
    if (wfName === 'default') setDefState(localizedDefaultDef)
  }, [localizedDefaultDef, wfName])

  useEffect(() => {
    if (!def) return
    setStageId((cur) => (cur && def.steps.some((s) => s.id === cur) ? cur : def.steps[0]?.id ?? null))
  }, [def])

  const readonlyWf = wfName === 'default'
  const namesErrorText = namesError === null ? null : t('workbench.names_error', { msg: formatApiError(namesError, t) })
  const defErrorText = defError === null ? null : t('workbench.def_error', { msg: formatApiError(defError, t) })
  const dirty = !readonlyWf && def !== null && defSnapshotRef.current !== null && JSON.stringify(def) !== defSnapshotRef.current
  const policyDirty = !readonlyWf && def !== null
    && defBaselineRef.current !== null
    && (JSON.stringify(def.decomposition) !== JSON.stringify(defBaselineRef.current.decomposition)
      || JSON.stringify(def.interaction) !== JSON.stringify(defBaselineRef.current.interaction)
      || JSON.stringify(def.reviewBudget) !== JSON.stringify(defBaselineRef.current.reviewBudget))
  const workflowCreateDirty = workflowCreateMode !== null && workflowDraftName !== workflowDraftBaseline.current
  const { setSourceDirty } = useWorkbenchDirtyState({
    localDirty: dirty || workflowCreateDirty || stageDraft.draftDirty || promptSkipDirty,
    onDirtyChange,
  })
  const reportTrackDirty = useCallback((value: boolean) => {
    setSourceDirty('track', value)
  }, [setSourceDirty])

  const editLane = useCallback((laneId: string, patch: LanePatch): void => {
    setDefState((prev) => (prev ? editLaneInDef(prev, laneId, patch) : prev))
  }, [])
  const replaceStep = useCallback((updated: WbStepDef): void => {
    setDefState((prev) => prev === null
      ? prev
      : { ...prev, steps: prev.steps.map((step) => step.id === updated.id ? updated : step) })
  }, [])
  const removeStage = useCallback((laneId: string): void => {
    setDefState((prev) => (prev ? removeStageFromDef(prev, laneId) : prev))
    setStageId((cur) => {
      if (cur !== laneId) return cur
      const rest = def?.steps.filter((s) => s.id !== laneId) ?? []
      return rest[0]?.id ?? null
    })
  }, [def])
  const reorderStages = useCallback((fromId: string, toId: string, after: boolean): void => {
    setDefState((prev) => (prev ? reorderStagesInDef(prev, fromId, toId, after) : prev))
  }, [])
  const addSkill = useCallback((laneId: string, skillId: string): void => {
    setDefState((prev) => (prev ? addSkillToDef(prev, laneId, skillId) : prev))
  }, [])
  const removeSkill = useCallback((laneId: string, skillId: string): void => {
    setDefState((prev) => (prev ? removeSkillFromDef(prev, laneId, skillId) : prev))
  }, [])
  const moveSkill = useCallback((move: SkillMove): void => {
    setDefState((prev) => (prev ? moveSkillInDef(prev, move) : prev))
  }, [])
  const setSkillDependency = useCallback((laneId: string, skillId: string, dep: string | null, prevDep: string | null): void => {
    setDefState((prev) => (prev ? setSkillDepInDef(prev, laneId, skillId, dep, prevDep) : prev))
  }, [])
  const setLaneGuard = useCallback((laneId: string, enabled: boolean): void => {
    setDefState((prev) => (prev ? setLaneGuardInDef(prev, laneId, enabled) : prev))
  }, [])

  async function save(): Promise<void> {
    if (!def || !wfName || readonlyWf || !dirty || saving) return
    const targetRoot = root
    const targetWorkflow = wfName
    const generation = ++saveGeneration.current
    setSaving(true)
    setSaveStatus({ kind: 'idle' })
    try {
      const res = await postWorkflowDef(targetWorkflow, { ...def, root: targetRoot })
      if (!res.ok) {
        const locale = localeIdentity.current
        if (res.status === 409) {
          // 并发写冲突：草稿未落地。普通失败提示「重试」会拿旧内容再覆盖一次，
          // 必须给「重新载入最新内容」这条独立恢复路径（reloadDefinition）。
          if (generation !== saveGeneration.current || rootIdentity.current !== targetRoot || workflowIdentity.current !== targetWorkflow) return
          setSaveStatus({ kind: 'error', errors: [locale.t('workbench.save_conflict')], conflict: true })
          return
        }
        const errors = await readSaveErrors(
          res,
          locale.t('workbench.save_unauthorized'),
          locale.t('common.request_http_error', { status: res.status }),
          locale.lang === 'zh',
        )
        if (generation !== saveGeneration.current || rootIdentity.current !== targetRoot || workflowIdentity.current !== targetWorkflow) return
        setSaveStatus({ kind: 'error', errors })
        return
      }
      const validSuccess = await readWorkflowWriteSuccess(res)
      if (generation !== saveGeneration.current || rootIdentity.current !== targetRoot || workflowIdentity.current !== targetWorkflow) return
      if (!validSuccess) { setSaveStatus({ kind: 'error', errors: [localeIdentity.current.t('common.invalid_response')] }); return }
      invalidateWorkflowRules(targetRoot, targetWorkflow)
      defSnapshotRef.current = JSON.stringify(def)
      defBaselineRef.current = def
      setSaveStatus({ kind: 'ok' })
    } catch (err) {
      if (generation === saveGeneration.current && rootIdentity.current === targetRoot && workflowIdentity.current === targetWorkflow) {
        setSaveStatus({ kind: 'error', errors: [formatApiError(err, localeIdentity.current.t)] })
      }
    } finally {
      if (generation === saveGeneration.current && rootIdentity.current === targetRoot && workflowIdentity.current === targetWorkflow) {
        setSaving(false)
      }
    }
  }

  /** 放弃未保存草稿：回到上次载入 / 保存的定义。 */
  function discardDraft(): void {
    if (readonlyWf || saving || defBaselineRef.current === null) return
    setDefState(defBaselineRef.current)
    setSaveStatus({ kind: 'idle' })
  }

  function switchTo(name: string): void {
    ++saveGeneration.current
    workflowIdentity.current = name
    setSaving(false)
    setSaveStatus({ kind: 'idle' })
    setWfName(name)
    setDefState(name === 'default' ? localizedDefaultDef : null)
    setDefError(null)
    defBaselineRef.current = name === 'default' ? localizedDefaultDef : null
  }

  function cancelPolicyDraft(): void {
    if (readonlyWf || saving || !policyDirty || defBaselineRef.current === null) return
    const baseline = defBaselineRef.current
    setDefState((current) => {
      if (current === null) return current
      const next = { ...current }
      if (baseline.decomposition === undefined) delete next.decomposition
      else next.decomposition = baseline.decomposition
      if (baseline.interaction === undefined) delete next.interaction
      else next.interaction = baseline.interaction
      return next
    })
    setSaveStatus({ kind: 'idle' })
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
  const workflowName = workflowDraftName.trim()
  const workflowNameInvalid = workflowName.length > 0 && !/^[\p{L}\p{N}\p{M}_-]+$/u.test(workflowName)
  const workflowNameDuplicate = workflowName.length > 0 && (workflowName === 'default' || (names ?? []).includes(workflowName))
  const canSubmitWorkflow = workflowName.length > 0 && !workflowNameInvalid && !workflowNameDuplicate && !workflowOpBusy
  function openWorkflowCreate(mode: 'new' | 'copy'): void {
    if (saving) return
    const initialName = mode === 'copy' ? `${wfName ?? 'workflow'}-copy` : ''
    workflowDraftBaseline.current = initialName
    setWorkflowCreateMode(mode)
    setWorkflowDraftName(initialName)
    setWorkflowOpErrors([])
  }
  function closeWorkflowCreate(): void {
    if (workflowOpBusy) return
    setWorkflowCreateMode(null)
    setWorkflowDraftName('')
    workflowDraftBaseline.current = ''
    setWorkflowOpErrors([])
  }
  async function confirmWorkflowCreate(): Promise<void> {
    if (!canSubmitWorkflow || !workflowCreateMode) return
    if (workflowCreateMode === 'copy' && !def) return
    const targetRoot = root
    const generation = ++createGeneration.current
    const nextDef = workflowForCreate(workflowCreateMode, readonlyWf, def, workflowName, defaultLabels)
    if (nextDef === null) return
    setWorkflowOpBusy(true)
    setWorkflowOpErrors([])
    try {
      const res = await postWorkflowDef(workflowName, { root: targetRoot, ...nextDef })
      if (!res.ok) {
        const locale = localeIdentity.current
        const errors = await readSaveErrors(
          res,
          locale.t('workbench.save_unauthorized'),
          locale.t('common.request_http_error', { status: res.status }),
          locale.lang === 'zh',
        )
        if (generation !== createGeneration.current || rootIdentity.current !== targetRoot) return
        setWorkflowOpErrors(errors)
        return
      }
      const validSuccess = await readWorkflowWriteSuccess(res)
      if (generation !== createGeneration.current || rootIdentity.current !== targetRoot) return
      if (!validSuccess) { setWorkflowOpErrors([localeIdentity.current.t('common.invalid_response')]); return }
      invalidateWorkflowRules(targetRoot, workflowName)
      setNames((prev) => [...new Set([...(prev ?? []), workflowName])].sort())
      setWorkflowCreateMode(null)
      setWorkflowDraftName('')
      workflowDraftBaseline.current = ''
      switchTo(workflowName)
    } catch (err) {
      if (generation === createGeneration.current && rootIdentity.current === targetRoot) {
        setWorkflowOpErrors([formatApiError(err, localeIdentity.current.t)])
      }
    } finally {
      if (generation === createGeneration.current && rootIdentity.current === targetRoot) {
        setWorkflowOpBusy(false)
      }
    }
  }
  function openWorkflowDelete(): void {
    if (saving || !wfName || wfName === 'default') return
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
    if (!target || target.root !== root || target.name !== wfName || workflowDeleteBusy) {
      setWorkflowDeleteTarget(null)
      return
    }
    const deleting = target.name
    const targetRoot = target.root
    const generation = ++deleteGeneration.current
    setWorkflowDeleteBusy(true)
    setWorkflowDeleteError(null)
    try {
      const res = await deleteWorkflowDef(deleting, targetRoot)
      const outcome = await readWorkflowDeleteResponse(res)
      if (generation !== deleteGeneration.current || rootIdentity.current !== targetRoot) return
      if (outcome.kind !== 'success') {
        const locale = localeIdentity.current
        const body = outcome.kind === 'error' ? outcome.body : null
        setWorkflowDeleteError({
          summary: outcome.kind === 'invalid'
            ? locale.t('common.invalid_response')
            : (locale.lang === 'zh' ? body?.error : undefined) ?? (body?.code === 'WORKFLOW_REFERENCED'
              ? locale.t('workbench.workflow_delete_referenced')
              : locale.t('workbench.workflow_delete_failed', { status: res.status })),
          references: locale.lang === 'zh' ? body?.references ?? [] : [],
          blockers: locale.lang === 'zh' ? body?.blockers ?? [] : [],
        })
        return
      }
      invalidateWorkflowRules(targetRoot, deleting)
      const remaining = (names ?? []).filter((name) => name !== deleting)
      setNames(remaining)
      setWorkflowDeleteTarget(null)
      setWorkflowDeleteError(null)
      switchTo(remaining[0] ?? 'default')
    } catch (err) {
      if (generation === deleteGeneration.current && rootIdentity.current === targetRoot) {
        setWorkflowDeleteError({
          summary: formatApiError(err, localeIdentity.current.t),
          references: [],
          blockers: [],
        })
      }
    } finally {
      if (generation === deleteGeneration.current && rootIdentity.current === targetRoot) {
        setWorkflowDeleteBusy(false)
      }
    }
  }

  const { hooks: hookMetas, matrix: hookMatrix } = hooksConfig
  const { boardLanes, summary } = useWorkbenchBoard({
    def,
    defaultWorkflow: readonlyWf,
    root,
    snapshot,
    readonlyWorkflow: readonlyWf,
    hookMetas,
    hookMatrix,
    t,
  })
  const selectedStep = def?.steps.find((step) => step.id === stageId) ?? null
  const { rules: rulesByKey } = useWorkflowRulesMulti(names && names.length > 0 ? [{ root, names }] : [])
  const menuNames = useMemo(() => [...(names ?? []), 'default'], [names])
  const stagesCountOf = (name: string): number | null =>
    name === 'default' ? DEFAULT_RULES.steps.length : rulesByKey.get(rulesKey(root, name))?.steps.length ?? null
  const selectedLane = boardLanes.find((lane) => lane.id === stageId)

  return {
    names,
    namesErrorText,
    wfName,
    def,
    defErrorText,
    readonlyWf,
    dirty,
    policyDirty,
    saving,
    saveStatus,
    menuNames,
    stagesCountOf,
    stageId,
    setStageId,
    selectedStep,
    selectedLane,
    boardLanes,
    summary,
    hooksConfig,
    mandatory,
    loops,
    recent,
    recentSilent,
    setDef,
    editLane,
    replaceStep,
    removeStage,
    reorderStages,
    addSkill,
    removeSkill,
    moveSkill,
    setSkillDependency,
    setLaneGuard,
    save,
    discardDraft,
    reloadDefinition: () => {
      setSaveStatus({ kind: 'idle' })
      setDefinitionReloadNonce((value) => value + 1)
    },
    cancelPolicyDraft,
    requestSwitch,
    confirmSwitch,
    pendingSwitch,
    setPendingSwitch,
    workflowCreateMode,
    workflowDraftName,
    setWorkflowDraftName,
    workflowNameInvalid,
    workflowNameDuplicate,
    workflowOpErrors,
    workflowOpBusy,
    canSubmitWorkflow,
    workflowNameRef,
    openWorkflowCreate,
    closeWorkflowCreate,
    confirmWorkflowCreate,
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
