import { existsSync, readdirSync } from 'node:fs'
import { workflowsDirUnder, type WorkflowDirectoryReader } from '../workflow/global-store.js'

/** Node 文件系统实现；领域调用方仅依赖 WorkflowDirectoryReader 端口。 */
const nodeWorkflowDirectoryReader: WorkflowDirectoryReader = {
  exists: (path) => existsSync(path),
  entries: (path) => readdirSync(path),
}

/** 某个 `.pipeline/workflows` 目录下的工作流名；目录不存在 → 空。 */
export function workflowNamesUnder(
  root: string,
  reader: WorkflowDirectoryReader = nodeWorkflowDirectoryReader,
): string[] {
  const dir = workflowsDirUnder(root)
  if (!reader.exists(dir)) return []
  return reader.entries(dir)
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length))
}
