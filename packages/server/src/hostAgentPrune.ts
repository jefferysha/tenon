/**
 * Dashboard 触发的转换把任务完结（archived=true）之后，回收宿主 agent 文件（`tenon-<name>`）。
 * 判定与 CLI 共用 kernel 的 pruneUnusedHostAgentFiles；转换已经提交，这里尽力而为，失败只 WARN。
 */
import { pruneUnusedHostAgentFiles } from '@tenon/kernel'
import type { StateStore } from '@tenon/kernel'
import { errText } from './transitionResult.js'

async function isArchived(store: StateStore, changeDir: string): Promise<boolean> {
  try {
    const value = (await store.read(changeDir)).fields.archived
    return (Array.isArray(value) ? value.join(',') : value ?? '') === 'true'
  } catch {
    return false
  }
}

export async function pruneHostAgentsAfterArchive(
  store: StateStore, root: string, changeDir: string, name: string,
): Promise<void> {
  if (!await isArchived(store, changeDir)) return
  try {
    const pruned = await pruneUnusedHostAgentFiles({
      repoRoot: root, except: name, isFinished: (dir) => isArchived(store, dir),
    })
    for (const path of pruned.preserved) process.stderr.write(`WARN: 宿主 agent ${path} 被改过，保留\n`)
    if (pruned.removed.length > 0) process.stderr.write(`[AGENT] 已回收宿主 agent 文件：${pruned.removed.join(', ')}\n`)
  } catch (error) {
    process.stderr.write(`WARN: 宿主 agent 文件回收失败（transition 已成功）: ${errText(error)}\n`)
  }
}
