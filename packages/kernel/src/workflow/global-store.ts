import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProductPaths, type ProductPathInput } from '../product-paths.js'

/**
 * 全局工作流存储：工作流是用户级模板，不属于某个项目；项目里的每个 change 通过 `--workflow / --track`
 * 选择走哪条流水线。存放在产品 configRoot 下的 `workflows/` 目录，内部沿用项目同样的形状
 * `.pipeline/workflows/<name>.yaml`，因此 server 的受信读写层（以目录为锚）可以原样复用。
 * `TENON_RUNTIME_HOME` / `TENON_RUNTIME_ROOTS` 会一并重定向它（测试与隔离安装场景）。
 */
export function globalWorkflowRoot(input: ProductPathInput = {}): string {
  return join(resolveProductPaths(input).configRoot, 'workflows')
}

export function workflowsDirUnder(root: string): string {
  return join(root, '.pipeline', 'workflows')
}

/** 解析顺序里的候选文件：项目文件（遗留兜底）在前，全局文件在后。 */
export function workflowFileCandidates(repoRoot: string, name: string, input: ProductPathInput = {}): string[] {
  return [join(workflowsDirUnder(repoRoot), `${name}.yaml`), join(workflowsDirUnder(globalWorkflowRoot(input)), `${name}.yaml`)]
}

/** 某个 `.pipeline/workflows` 目录下的工作流名；目录不存在 → 空。 */
export function workflowNamesUnder(root: string): string[] {
  const dir = workflowsDirUnder(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((entry) => entry.endsWith('.yaml')).map((entry) => entry.slice(0, -'.yaml'.length))
}
