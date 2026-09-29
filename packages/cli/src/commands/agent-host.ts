/**
 * 宿主原生 agent 文件的 CLI 编排：任务冻结 agent 时为当前宿主生成 `tenon-<name>` 子代理文件，
 * 任务完结时回收不再被任何在途任务引用的文件。文件落盘与所有权清单由 kernel 负责。
 *
 * 生成失败从不让命令失败：宿主退回通用子代理，结果写进运行记录（`subagent.native: false`）。
 */
import {
  HOST_AGENT_FALLBACK, HOST_AGENT_HOSTS, ensureHostAgentFiles, pruneUnusedHostAgentFiles,
  type FrozenAgent, type HostAgentFileOutcome, type HostAgentHost, type HostAgentPruneResult,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'

/** `--host` 优先；没给时按进程环境判定的当前宿主（终端 = 无宿主，不生成）。 */
export function hostAgentHostOf(deps: CliDeps, host?: string): HostAgentHost | undefined {
  if (host !== undefined) return (HOST_AGENT_HOSTS as readonly string[]).includes(host) ? host as HostAgentHost : undefined
  const kind = deps.hostKind?.()
  if (kind === 'claude-code') return 'claude'
  if (kind === 'codex') return 'codex'
  return undefined
}

/** 为一个任务冻结的全部 agent 生成宿主文件（一次全部生成，之后的运行不再改动工作区）。 */
export async function ensureChangeHostAgents(
  deps: CliDeps,
  host: HostAgentHost,
  frozen: ReadonlyMap<string, FrozenAgent>,
): Promise<ReadonlyMap<string, HostAgentFileOutcome>> {
  const agents = [...frozen.values()]
    .filter((agent) => agent.definition.hosts === undefined || agent.definition.hosts.includes(host))
    .map((agent) => ({ name: agent.name, definition: agent.definition }))
  if (agents.length === 0) return new Map()
  try {
    const outcomes = await ensureHostAgentFiles({ repoRoot: deps.cwd, host, agents })
    for (const outcome of outcomes) {
      if (!outcome.native) deps.io.err(`WARN: 宿主 agent ${outcome.path} 未生成（${outcome.detail ?? outcome.state}），改用通用子代理`)
    }
    return new Map(outcomes.map((outcome) => [outcome.agent, outcome]))
  } catch (e) {
    deps.io.err(`WARN: 宿主 agent 文件生成失败（${errMsg(e)}），改用通用子代理`)
    return new Map()
  }
}

/** 宿主文件缺席时的退回结果。 */
export function fallbackOutcome(host: HostAgentHost): Pick<HostAgentFileOutcome, 'subagentType' | 'native'> {
  return { subagentType: HOST_AGENT_FALLBACK[host], native: false }
}

/** 一个任务是否已完结（状态读不到按在途处理：宁可多留文件，不误删别人还在用的）。 */
async function finished(deps: CliDeps, dir: string): Promise<boolean> {
  try {
    return str((await deps.store.read(dir)).fields.archived) === 'true'
  } catch {
    return false
  }
}

/**
 * 回收宿主 agent 文件：保留每个在途任务（`openspec/changes/*`，不含 archive/、已完结的与 except）
 * 冻结的 agent 名，其余 Tenon 生成且未被改过的文件删除。判定在 kernel（Dashboard 完结任务时共用）；
 * 任何一个在途任务的冻结锁读不懂就整次放弃。尽力而为：失败只 WARN。
 */
export async function pruneHostAgents(deps: CliDeps, except?: string): Promise<HostAgentPruneResult | undefined> {
  try {
    const result = await pruneUnusedHostAgentFiles({
      repoRoot: deps.cwd,
      ...(except === undefined ? {} : { except }),
      isFinished: (dir) => finished(deps, dir),
    })
    for (const path of result.preserved) deps.io.err(`WARN: 宿主 agent ${path} 被改过，保留`)
    return result
  } catch (e) {
    deps.io.err(`WARN: 宿主 agent 文件回收失败：${errMsg(e)}`)
    return undefined
  }
}
