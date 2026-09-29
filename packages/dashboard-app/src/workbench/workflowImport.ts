import { parseWorkflow } from '@tenon/kernel/workflow/parse'
import type { PreviewSource } from './workflowEditorTypes'

/** 新建工作流「导入 YAML」这一起点对应的 CreateSource：工作流名不允许含点，不会与任何真实起点重名。 */
export const IMPORT_SOURCE = '.import'

/** 导入框里那段 YAML 的即时解读：空、语法错（错误原文）或可预览（名称 + 供右栏用的轨道 / 阶段）。 */
export type WorkflowImport =
  | { status: 'empty' }
  | { status: 'error'; text: string }
  | { status: 'ready'; name: string; def: PreviewSource }

/**
 * 客户端只做语法层解析（内核同一个解析器）：给预览与即时错误；契约、agent 引用、轨道引用等完整校验
 * 由服务端在 PUT 时做，失败原文回到对话框底部。
 */
export function readWorkflowImport(text: string): WorkflowImport {
  if (text.trim() === '') return { status: 'empty' }
  try {
    const def = parseWorkflow(text)
    return { status: 'ready', name: def.name, def }
  } catch (error) {
    return { status: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** 把第一行 `name:` 改成对话框里的名称（解析器要求第一行就是 name），其余原样保留。 */
export function renameWorkflowYaml(text: string, name: string): string {
  return text.replace(/^name:[ \t]*\S+[ \t]*/, `name: ${name}`)
}

/** 读用户选的 YAML 文件为文本（FileReader：各浏览器与 jsdom 都有，不依赖 Blob.text）。 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(file)
  })
}
