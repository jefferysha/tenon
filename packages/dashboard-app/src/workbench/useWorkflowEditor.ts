import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { BUILTIN_WORKFLOW_IDS, isBuiltinWorkflowName, isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
import { fetchWorkflow, fetchWorkflowIndex, postWorkflowDef, type WorkflowIndex } from '../api/client'
import type { WbWorkflowDef, WbWorkflowSource } from '../api/governanceTypes'
import { formatApiError, getToken } from '../api/transport'
import { fetchWorkflowYaml } from '../api/workflowYamlClient'
import { useT } from '../i18n'
import { useBuiltinLabels } from '../i18n/builtinLabels'
import { invalidateWorkflowRules } from '../model/workflowModel'
import { draftEffectiveIo, lintWorkflow } from '../workflow/lint'
import { fetchAgents, type AgentSummary } from '../api/agentClient'
import { useMandatorySkills } from './mandatoryState'
import { readSaveErrors } from './workbenchApiDecoders'
import { readWorkflowWriteSuccess } from './workbenchWriteResponse'
import { useStageDraftEditor } from './useStageDraftEditor'
import { countDraftChanges, stableJson } from './draftChanges'
import { useWorkbenchDirtyState } from './useWorkbenchDirtyState'
import { useStageMutations } from './useStageMutations'
import { useWorkflowCreate } from './useWorkflowCreate'
import { useWorkflowDelete } from './useWorkflowDelete'
import {
  BASE_BRANCH,
  addTrackBranch,
  branchesOf,
  definitionForWrite,
  resolveBranch,
  removeTrackBranch,
  selectBranchDef,
  writeBranchDef,
} from './workbenchDefinition'
import type { SaveStatus, WorkflowEditor, WorkflowEditorInput } from './workflowEditorTypes'

export type { CreateState, SaveStatus, WorkflowDeleteError, WorkflowEditor, WorkflowEditorInput } from './workflowEditorTypes'

/**
 * 工作流定义编辑的状态机：列表 / 定义加载（default 亦从服务端读，项目覆盖优先）、草稿与保存、切换守卫、
 * 阶段草稿、轨道。新建（选起点 → 预览 → 命名）、删除（default = 恢复内建）与阶段编辑各在自己的 hook 里。
 */
export function useWorkflowEditor({ root, onDirtyChange, initial, onDeleted }: WorkflowEditorInput): WorkflowEditor {
  const { t, lang } = useT()
  const builtin = useBuiltinLabels()
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
  const initialRef = useRef(initial)
  const rootIdentity = useRef(root)
  const workflowIdentity = useRef<string | null>(null)
  const generation = useRef({ save: 0, delete: 0, names: 0 })
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
  const hasToken = getToken() !== ''
  const readOnly = wfName !== null && isBuiltinWorkflowName(wfName)
  const canWrite = hasToken && !readOnly
  const onDeletedRef = useRef(onDeleted)
  onDeletedRef.current = onDeleted

  function afterWrite(targetRoot: string, name: string): void {
    invalidateWorkflowRules(targetRoot, name)
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
  // 新建对话框的状态（起点 / 预览 / 名称 / OpenSpec / 写入）都在 useWorkflowCreate 里，root 与语言切换时自己归零。
  const create = useWorkflowCreate({
    root,
    names,
    hasToken,
    current: wfName,
    blocked: saving,
    onCreated: (targetRoot, name) => {
      afterWrite(targetRoot, name)
      setNames((previous) => [...new Set([...(previous ?? []), name])].sort())
      switchTo(name)
    },
  })
  const deleteFlow = useWorkflowDelete({
    root, wfName, saving, canWrite, defaultSource, generation, rootIdentity, localeRef, onDeleted: onDeletedRef, afterWrite, switchTo,
    setDefaultSource,
    removeName: (name) => setNames((previous) => (previous ?? []).filter((candidate) => candidate !== name)),
    reload: () => setReloadNonce((value) => value + 1),
  })
  // root / 语言切换要清掉删除对话框的状态；它的 reset 每次渲染都是新函数，经 ref 取最新的。
  const deleteRef = useRef(deleteFlow)
  deleteRef.current = deleteFlow

  useEffect(() => {
    setSaveStatus((current) => current.kind === 'error' ? { kind: 'idle' } : current)
    deleteRef.current.clearError()
  }, [lang])

  // root 切换：全部状态归零，重拉列表。
  useEffect(() => {
    const targetRoot = root
    const current = ++generation.current.names
    generation.current.save += 1
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
    deleteRef.current.reset()
    baselineRef.current = null
    baselineJson.current = null
    let cancelled = false
    fetchWorkflowIndex(targetRoot)
      .then((index: WorkflowIndex) => {
        if (cancelled || current !== generation.current.names || rootIdentity.current !== targetRoot) return
        setNames(index.names)
        setDefaultSource(index.defaultSource)
        setNamesError(null)
        // 深链点名的工作流存在就用它（连同轨道与阶段）；否则打开 default。
        const linked = initialRef.current
        initialRef.current = undefined
        if (linked?.wf !== undefined && (isDefaultWorkflowName(linked.wf) || isBuiltinWorkflowName(linked.wf) || index.names.includes(linked.wf))) {
          setWfName(linked.wf)
          if (linked.track !== undefined) setBranchState(linked.track)
          if (linked.step !== undefined) setStageId(linked.step)
          return
        }
        setWfName('default')
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
        baselineJson.current = stableJson(definitionForWrite(body))
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
  const dirty = fullDef !== null && baselineJson.current !== null && stableJson(definitionForWrite(fullDef)) !== baselineJson.current
  const changeCount = dirty ? Math.max(1, countDraftChanges(baselineRef.current, fullDef)) : 0
  const { setSourceDirty } = useWorkbenchDirtyState({ localDirty: dirty || create.dirty || stageDraft.draftDirty, onDirtyChange })
  const reportTrackDirty = useCallback((value: boolean) => { setSourceDirty('track', value) }, [setSourceDirty])

  // agent 库挂载即拉（同 registry 纪律）：画布与 lint 都要知道库里有谁。失败即保持 null——
  // 不可判就不判，既不谎报「不存在」也不打开写入口。
  const [agents, setAgentLibrary] = useState<AgentSummary[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchAgents().then((loaded) => { if (!cancelled) setAgentLibrary([...loaded]) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const effectiveIo = useMemo(() => def === null ? undefined : draftEffectiveIo(def), [def])
  const agentNames = useMemo(() => agents === null ? null : agents.map((agent) => agent.name), [agents])
  const lint = useMemo(
    () => def === null ? [] : lintWorkflow(def, effectiveIo, agentNames),
    [def, effectiveIo, agentNames],
  )
  // 保存门禁看全部分支：任一分支有 error 都不能保存；warning（缺输出、成对文档缺一）不挡。
  const lintBlocked = useMemo(() => {
    if (fullDef === null) return false
    return branchesOf(fullDef).some((candidate) => {
      const view = selectBranchDef(fullDef, candidate.id)
      return lintWorkflow(view, draftEffectiveIo(view), agentNames).some((issue) => issue.severity === 'error')
    })
  }, [fullDef, agentNames])
  // 名称只显示一个：YAML 有 label 用 label，没有就用 id。内置工作流里没被改过的出厂名按界面语言显示（i18n builtin.*），其余原样。
  const labelOf = useCallback((stepId: string): string => {
    const step = def?.steps.find((candidate) => candidate.id === stepId)
    return builtin.step(wfName, stepId, step?.label || stepId)
  }, [def, wfName, builtin])

  const mutate = useCallback((update: (previous: WbWorkflowDef) => WbWorkflowDef): void => {
    setBranchDef((previous) => previous === null ? previous : update(previous))
  }, [setBranchDef])
  const mutations = useStageMutations({ mutate, setFullDef: setDefState, def, stageId, setStageId, branch: effectiveBranch })
  const branches = useMemo(
    () => branchesOf(fullDef).map((candidate) => (candidate.label === null ? candidate : { ...candidate, label: builtin.track(wfName, candidate.id, candidate.label) })),
    [fullDef, wfName, builtin],
  )
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
      baselineJson.current = stableJson(definitionForWrite(fullDef))
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
  function requestSwitch(name: string): void {
    if (name === wfName) return
    if (dirty) setPendingSwitch(name)
    else switchTo(name)
  }
  function confirmSwitch(): void {
    if (pendingSwitch !== null) switchTo(pendingSwitch)
    setPendingSwitch(null)
  }
  async function exportYaml(): Promise<string> {
    if (!wfName) return ''
    return fetchWorkflowYaml(wfName, root)
  }

  const selectedStep = def?.steps.find((step) => step.id === stageId) ?? null
  // 切换器列出全部：default、自定义与模板、插件内建（simple 等，只读）。
  const menuNames = useMemo(() => [...new Set(['default', ...(names ?? []), ...BUILTIN_WORKFLOW_IDS])], [names])

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
    ...mutations,
    canWrite,
    readOnly,
    hasToken,
    dirty,
    changeCount,
    saving,
    saveStatus,
    menuNames,
    stageId,
    setStageId,
    selectedStep,
    labelOf,
    mandatory,
    agents,
    save,
    discardDraft,
    reloadDefinition: () => { setSaveStatus({ kind: 'idle' }); setReloadNonce((value) => value + 1) },
    requestSwitch,
    confirmSwitch,
    pendingSwitch,
    setPendingSwitch,
    create,
    exportYaml,
    workflowDeleteTarget: deleteFlow.target,
    workflowDeleteBusy: deleteFlow.busy,
    workflowDeleteError: deleteFlow.error,
    openWorkflowDelete: deleteFlow.open,
    closeWorkflowDelete: deleteFlow.close,
    confirmWorkflowDelete: deleteFlow.confirm,
    stageDraft,
    setSourceDirty,
    reportTrackDirty,
  }
}
