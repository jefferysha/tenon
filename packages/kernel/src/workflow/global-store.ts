import { resolveProductPaths, type ProductPathInput } from '../product-paths.js'

/** 全局 workflow 目录枚举所需的最小端口；Node/测试适配器在基础设施层实现。 */
export interface WorkflowDirectoryReader {
  exists(path: string): boolean
  entries(path: string): readonly string[]
}

/**
 * 全局工作流存储的路径契约。
 *
 * 该模块只负责把产品路径映射为 workflow 存储位置；文件系统访问由
 * `infrastructure/workflow-global-store.ts` 提供，避免 workflow 领域层直接依赖 Node API。
 * `TENON_RUNTIME_HOME` / `TENON_RUNTIME_ROOTS` 仍由 resolveProductPaths 统一解释。
 */
export function globalWorkflowRoot(input: ProductPathInput = {}): string {
  return joinPath(resolveProductPaths(input).configRoot, 'workflows')
}

export function workflowsDirUnder(root: string): string {
  return joinPath(root, '.pipeline', 'workflows')
}

/** 解析顺序里的候选文件：项目文件（遗留兜底）在前，全局文件在后。 */
export function workflowFileCandidates(repoRoot: string, name: string, input: ProductPathInput = {}): string[] {
  return [
    joinPath(workflowsDirUnder(repoRoot), `${name}.yaml`),
    joinPath(workflowsDirUnder(globalWorkflowRoot(input)), `${name}.yaml`),
  ]
}

/**
 * 在不引入 node:path 的情况下保持本机路径分隔符。
 * 产品路径已经由 resolveProductPaths 规范化；对外传入的 root 则按其已有分隔符拼接。
 */
function joinPath(first: string, ...rest: string[]): string {
  const separator = first.includes('\\') && !first.includes('/') ? '\\' : '/'
  const trim = (part: string, side: 'start' | 'end'): string => {
    if (side === 'start') return part.replace(/^[\\/]+/u, '')
    return part.replace(/[\\/]+$/u, '')
  }
  if (first === '') return rest.map((part) => trim(part, 'start')).join(separator)
  const head = trim(first, 'end')
  return [head, ...rest.map((part) => trim(part, 'start'))].join(separator)
}
