/**
 * 一次改动的风险指标（纯函数）：standard 通道在实现后据此判定「这个任务是否已经长出了轻量通道」。
 *
 * 输入是宿主读到的、自任务起点以来的路径改动（含删除）和受保护测试配置改动的个数；这里只做计数，
 * 不碰 git 与文件系统。阈值不在这里：它们是工作流里风险探针测试的 `pass.metrics`，改工作流 YAML 即可。
 *
 * 口径与 `tenon test code-size` 一致：只数代码类路径（排除 openspec/、状态目录、docs/、依赖与测试缓存、
 * Markdown），Tenon 自己写下的状态与文档不会被算成代码改动。
 */
import { looksLikeTestFile } from '../test-system/vocabulary.js'
import type { PathChange } from './changed-files.js'
import { isWorkspaceCandidatePath } from './fingerprint.js'
import { classifyPath, type PathClass } from './path-classes.js'

const DOCUMENT_EXTENSION = /\.(?:md|mdx|markdown)$/iu
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__)\//u

/** 仓库相对路径是否计入代码规模与风险统计。 */
export function isCodePath(path: string): boolean {
  return isWorkspaceCandidatePath(path) && !DOCUMENT_EXTENSION.test(path)
}

/** 看起来是测试文件：命名约定，或位于 test/ tests/ __tests__/ 目录。 */
export function isTestPath(path: string): boolean {
  return looksLikeTestFile(path) || TEST_DIRECTORY.test(path)
}

export interface DiffRiskMetrics {
  readonly files_changed: number
  readonly contract_files: number
  readonly auth_files: number
  readonly dependency_files: number
  readonly migration_files: number
  readonly deleted_tests: number
  readonly protected_test_files: number
}

const CLASS_METRIC: Readonly<Record<PathClass, keyof DiffRiskMetrics>> = {
  auth: 'auth_files',
  dependency: 'dependency_files',
  contract: 'contract_files',
  migration: 'migration_files',
}

function codeChanges(changes: readonly PathChange[]): readonly PathChange[] {
  return changes.filter((change) => isCodePath(change.path))
}

export function assessDiffRisk(changes: readonly PathChange[], protectedTestFiles: number): DiffRiskMetrics {
  const code = codeChanges(changes)
  const counts: Record<keyof DiffRiskMetrics, number> = {
    files_changed: code.length,
    contract_files: 0,
    auth_files: 0,
    dependency_files: 0,
    migration_files: 0,
    deleted_tests: code.filter((change) => change.status === 'deleted' && isTestPath(change.path)).length,
    protected_test_files: protectedTestFiles,
  }
  for (const change of code) {
    for (const pathClass of classifyPath(change.path)) counts[CLASS_METRIC[pathClass]] += 1
  }
  return counts
}

/** 本次改动命中的路径类集合（评审者 `attach_on` 用）。 */
export function touchedPathClasses(changes: readonly PathChange[]): ReadonlySet<PathClass> {
  const touched = new Set<PathClass>()
  for (const change of codeChanges(changes)) {
    for (const pathClass of classifyPath(change.path)) touched.add(pathClass)
  }
  return touched
}
