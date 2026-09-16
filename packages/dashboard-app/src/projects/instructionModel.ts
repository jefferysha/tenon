import type { InstructionHostRow, InstructionTarget } from '../api/instructionsDecoders'

/** 所选宿主对应的目标文件 id（项目级是文件名，用户级是宿主 id），按宿主顺序去重。 */
export function targetsForHosts(hosts: readonly InstructionHostRow[], selected: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const host of hosts) {
    if (!selected.has(host.id) || host.target === null) continue
    if (!out.includes(host.target)) out.push(host.target)
  }
  return out
}

export type FileStatus = 'missing' | 'same' | 'different' | 'error'

/** 单个目标文件相对编辑器正文的状态。 */
export function fileStatus(target: InstructionTarget, editorText: string): FileStatus {
  if (target.error !== null) return 'error'
  if (!target.exists) return 'missing'
  return target.text === editorText ? 'same' : 'different'
}

/** 初始载入哪个文件的正文：所选目标里第一个已存在且可读的。 */
export function firstLoadable(targets: readonly InstructionTarget[], ids: readonly string[]): InstructionTarget | null {
  for (const id of ids) {
    const target = targets.find((candidate) => candidate.id === id)
    if (target && target.exists && target.error === null) return target
  }
  return null
}

/** 所选目标里受管块总数（删除对话框显示「受管块保留 n」）。 */
export function managedCount(targets: readonly InstructionTarget[], ids: readonly string[]): number {
  return targets.filter((target) => ids.includes(target.id)).reduce((total, target) => total + target.managed.length, 0)
}

/** Codex 的 project_doc_max_bytes 是 32 KiB：超过就提示，但不阻止写入。 */
export const CODEX_MAX_BYTES = 32 * 1024
