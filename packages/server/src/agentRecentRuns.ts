/**
 * 一个 agent 在某个项目里最近的运行（Dashboard 详情页「最近运行」）：扫 `openspec/changes/*` 与
 * `openspec/changes/archive/*` 的运行台账，取该 agent 的最后几次。读不动或损坏的台账跳过——
 * 展示不该因为别的任务一个坏文件而失败（守卫对同一份台账仍然失败关闭）。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAgentRuns, type AgentRunRow } from '@tenon/kernel'

export interface AgentRecentRun {
  readonly change: string
  readonly step: string
  readonly role: AgentRunRow['role']
  readonly status: AgentRunRow['status']
  readonly result: AgentRunRow['result']
  readonly findings: number
  readonly started_at: string
  readonly finished_at: string | null
  readonly subagent: AgentRunRow['subagent'] | null
}

const MAX_CHANGES = 400
export const RECENT_RUNS_LIMIT = 5

async function directories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

export async function agentRecentRuns(root: string, agent: string, limit = RECENT_RUNS_LIMIT): Promise<readonly AgentRecentRun[]> {
  const changesRoot = join(root, 'openspec', 'changes')
  const active = (await directories(changesRoot)).filter((name) => name !== 'archive').map((name) => ({ name, dir: join(changesRoot, name) }))
  const archived = (await directories(join(changesRoot, 'archive'))).map((name) => ({ name, dir: join(changesRoot, 'archive', name) }))
  const found: AgentRecentRun[] = []
  for (const change of [...active, ...archived].slice(0, MAX_CHANGES)) {
    let rows: readonly AgentRunRow[]
    try {
      rows = await readAgentRuns(change.dir)
    } catch {
      continue
    }
    for (const row of rows) {
      if (row.agent !== agent) continue
      found.push({
        change: change.name,
        step: row.step,
        role: row.role,
        status: row.status,
        result: row.result,
        findings: row.findings.length,
        started_at: row.started_at,
        finished_at: row.finished_at,
        subagent: row.subagent ?? null,
      })
    }
  }
  return found.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0)).slice(0, limit)
}
