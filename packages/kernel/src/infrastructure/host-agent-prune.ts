/**
 * 任务完结后回收宿主 agent 文件（CLI 与 Dashboard 共用同一份判定）：
 * 保留每个在途任务（`openspec/changes/*`，不含 `archive/`、已完结的与 except）冻结的 agent 名，
 * 其余 Tenon 生成且没被改过的 `tenon-<name>` 文件删除，落盘细节由 host-agent-files 负责。
 *
 * 任何一个在途任务的冻结锁读不懂就整次放弃（抛出）：不知道它用了谁，就不能删。
 * 是否「已完结」由调用方按自己持有的状态存储判定；判不了必须答 false（宁可多留文件）。
 */
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAgentFreezeLock } from '../state/agent-freeze.js'
import { ownedHostAgentNames, pruneHostAgentFiles, type HostAgentPruneResult } from './host-agent-files.js'

export async function pruneUnusedHostAgentFiles(input: {
  readonly repoRoot: string
  /** 刚完结的任务名：它自己不算在途。 */
  readonly except?: string
  readonly isFinished: (changeDir: string) => Promise<boolean>
}): Promise<HostAgentPruneResult> {
  if ((await ownedHostAgentNames(input.repoRoot)).length === 0) return { removed: [], preserved: [] }
  const changesRoot = join(input.repoRoot, 'openspec', 'changes')
  let entries: Dirent[]
  try {
    entries = await readdir(changesRoot, { withFileTypes: true })
  } catch {
    entries = []
  }
  const keep = new Set<string>()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive' || entry.name === input.except) continue
    const dir = join(changesRoot, entry.name)
    const lock = await readAgentFreezeLock(dir)
    if (lock === undefined || await input.isFinished(dir)) continue
    for (const agent of lock.agents) keep.add(agent.name)
  }
  return pruneHostAgentFiles({ repoRoot: input.repoRoot, keep })
}
