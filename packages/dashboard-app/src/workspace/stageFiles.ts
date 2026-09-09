import type { ChangeSnapshot } from '../types'
import type { WbStepDef } from '../workbench/workbenchDefinition'

/** 阶段输入 / 输出里的一项：文件（可读 / 缺失）或非文件的值字段（如 build_sha）。 */
export interface StageFile {
  /** 字段名或文档 kind（展示为 mono 标签）。 */
  field: string
  kind: 'file' | 'value'
  /** 项目根相对路径；文件缺失或值字段时为 null。 */
  path: string | null
  value: string
  present: boolean
}

export interface StageIo {
  inputs: StageFile[]
  outputs: StageFile[]
}

function fieldValue(change: ChangeSnapshot, field: string): string {
  const value = change.fields[field]
  return typeof value === 'string' ? value : ''
}

function fileOf(change: ChangeSnapshot, ref: WbStepDef['inputs'][number]): StageFile {
  const value = fieldValue(change, ref.field)
  const present = value !== '' && value !== 'null'
  if (ref.type === 'file_path') return { field: ref.field, kind: 'file', path: present ? value : null, value, present }
  return { field: ref.field, kind: 'value', path: null, value, present }
}

/**
 * 某阶段的输入 / 输出：字段来自工作流定义（`WbStepDef.inputs/outputs`），值来自 change 当前字段——
 * 定义说「这一阶段读 design_doc、产出 plan」，change 字段说「plan 现在在哪个文件」。
 */
export function stageIo(step: WbStepDef | undefined, change: ChangeSnapshot): StageIo {
  if (!step) return { inputs: [], outputs: [] }
  return {
    inputs: step.inputs.map((ref) => fileOf(change, ref)),
    outputs: step.outputs.map((ref) => fileOf(change, ref)),
  }
}

export interface ChangeDocument {
  kind: string
  path: string | null
  status: 'recorded' | 'missing' | 'stale' | 'unread'
}

/** OpenSpec 治理文档（proposal / design / tasks …）：server 已评估的登记状态 + 路径。 */
export function changeDocuments(change: ChangeSnapshot): ChangeDocument[] {
  if (!change.documents?.governed) return []
  return change.documents.items.map((item) => ({ kind: item.kind, path: item.paths[0] ?? null, status: item.status }))
}

export function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}
