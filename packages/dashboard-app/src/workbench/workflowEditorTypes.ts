import type { RefObject } from 'react'
import type { DocumentKind } from '@tenon/kernel/workflow/document-contract-model'
import type { AgentSummary } from '../api/agentClient'
import type { WbEffectiveIo, WbExecutorRef, WbReviewerRef, WbSkillRef, WbStepDef, WbStepTest, WbWorkflowDef, WbWorkflowSource } from '../api/governanceTypes'
import type { LintIssue } from '../workflow/lint'
import type { MandatoryState } from './mandatoryState'
import type { useStageDraftEditor } from './useStageDraftEditor'
import type { WorkbenchDirtySource } from './useWorkbenchDirtyState'
import type { WorkflowReferenceEntry } from './workbenchApiDecoders'

export type SaveStatus = { kind: 'idle' | 'ok' } | { kind: 'error'; errors: string[]; conflict?: boolean }

export interface WorkflowDeleteError {
  summary: string
  /** 引用它的任务（change 名）：有就拒绝删除，并逐个列出。 */
  tasks: string[]
  /** 其它引用（轨道 / 循环 / 模板），按「类别 名称」列出。 */
  references: WorkflowReferenceEntry[]
  blockers: Array<{ source?: string; detail?: string }>
}

/** 编辑器里所有异步写动作共用的代次：root / 工作流换了之后，迟到的响应一律丢弃。 */
export interface EditorGenerations {
  save: number
  delete: number
  names: number
}

/** 起点：null = 空白；否则复制这个工作流（内建 default / simple，或项目里已有的）。 */
export type CreateSource = string | null

/** 右侧预览：起点的阶段名（有轨道时取第一条轨道，与编辑器打开时一致）。 */
export type CreatePreview =
  | { status: 'loading' }
  | { status: 'ready'; stages: readonly string[] }
  | { status: 'error'; text: string }

export type CreateNameError = 'invalid' | 'duplicate' | null

export interface CreateState {
  open: boolean
  /** 可复制的起点：default、simple 在前，其后是项目里已有的工作流。 */
  sources: readonly string[]
  source: CreateSource
  setSource: (source: CreateSource) => void
  name: string
  setName: (name: string) => void
  /** 新工作流是否接入 OpenSpec：缺省随起点（空白为关），用户拨过之后保持用户的选择。 */
  openspec: boolean
  setOpenspec: (on: boolean) => void
  nameError: CreateNameError
  preview: CreatePreview
  /** 服务端拒绝时的错误原文。 */
  errors: string[]
  busy: boolean
  canSubmit: boolean
  /** 用户改过任一字段：关闭前要二次确认。 */
  dirty: boolean
  nameRef: RefObject<HTMLInputElement>
  openCreate: (source?: CreateSource) => void
  close: () => void
  submit: () => Promise<void>
}

export interface WorkflowEditorInput {
  root: string
  onDirtyChange?: (dirty: boolean) => void
  /** 深链带来的初始选择（?wf=&track=&step=）；只在第一次拉到列表时用一次，不存在的名字按缺省落。 */
  initial?: { wf?: string; track?: string; step?: string }
  /** 删除成功（restored = 模板工作流恢复内建）。 */
  onDeleted?: (name: string, restored: boolean) => void
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
  /** 草稿的物化 IO（字段槽位与文档槽位都按草稿重算）。 */
  effectiveIo: WbEffectiveIo | undefined
  lint: LintIssue[]
  /** 任一分支有 error 级 lint 问题 → 不能保存；warning 不挡。 */
  lintBlocked: boolean
  /** OpenSpec 开关（工作流级，关闭时清掉每条分支的文档契约；default 不能关）。 */
  setOpenspec: (on: boolean) => void
  addDocumentOutput: (stepId: string, kind: DocumentKind) => void
  removeDocumentSlot: (stepId: string, kind: string, direction: 'inputs' | 'outputs') => void
  setDocumentInputs: (stepId: string, kinds: readonly string[]) => void
  /** 能否编辑当前工作流：有写凭证且不是插件内建（simple 等只读）；否则所有写入口置灰。 */
  canWrite: boolean
  /** 当前工作流是插件内建、只读（与缺凭证区分：不报凭证错误）。 */
  readOnly: boolean
  /** 页面持有写凭证（新建工作流只看这个：只读的内建也能复制）。 */
  hasToken: boolean
  dirty: boolean
  /** 保存条「未保存 N 处」：按阶段 / 轨道 / 工作流级字段计数；干净时为 0。 */
  changeCount: number
  saving: boolean
  saveStatus: SaveStatus
  menuNames: string[]
  stageId: string | null
  setStageId: (id: string | null) => void
  selectedStep: WbStepDef | null
  labelOf: (stepId: string) => string
  mandatory: MandatoryState
  /** agent 库（GET /api/agents）；null = 还没拉到 → 不做 agent lint，编辑入口置灰。 */
  agents: AgentSummary[] | null
  renameStep: (stepId: string, label: string) => void
  setGate: (stepId: string, gate: WbStepDef['gate']) => void
  setStageBack: (stepId: string, to: string | null) => void
  removeStage: (stepId: string) => void
  reorderStages: (fromId: string, toId: string, after: boolean) => void
  setSkills: (stepId: string, skills: readonly WbSkillRef[]) => void
  setAgents: (stepId: string, patch: { executors?: readonly WbExecutorRef[]; reviewers?: readonly WbReviewerRef[] }) => void
  setTests: (stepId: string, tests: readonly WbStepTest[]) => void
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
