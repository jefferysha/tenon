/**
 * 派发判定（只读）：任务冻结的 agent 在当前宿主能不能用专属子代理 `tenon-<name>`。
 *
 * 专属子代理只来自 `tenon agent install` 写的用户级文件（`<Claude 配置目录>/agents`、`<Codex 配置目录>/agents`，默认
 * `~/.claude/agents`、`~/.codex/agents`，设了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 时是它们下面的 `agents`）；会话里的命令不写
 * 宿主文件（会话中途新增的子代理什么时候被宿主加载不可预期）。子代理目录由调用方按会话的环境用 `hostAgentsDir` 解出并传入，
 * 与安装用同一解析，宿主读哪个目录就查哪个。所以这里只比对、不生成：
 *   · 用户级文件存在且与冻结定义的渲染结果逐字一致，并且项目里没有内容不同的同名文件 → 专属子代理；
 *   · 否则退回宿主的通用子代理，`reason` 写明原因：`project-agent`（agent 来自项目层，不安装宿主文件）、`not-installed`
 *     （用户级文件不存在）、`definition-mismatch`（内容不一致，例如冻结的是旧版本）、`shadowed`（项目级同名文件优先级高于
 *     用户级，内容不同就遮住了它）。
 * 项目级同名文件要看当前根与主检出两处：在 linked worktree 里，用户改过而被保留的旧文件在主检出，从主检出启动的会话会加载它们。
 * 主检出的定位见 workspace/main-checkout（与旧项目级文件清理共用）。
 *
 * 判定不写任何东西、不创建目录；用户目录不存在是常态（首次安装前）而不是错误；读不了的路径按「无法确认一致」处理，不抛错。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOST_AGENT_FALLBACK, hostAgentName, hostAgentPath, parseHostAgentPath, renderHostAgent,
  type HostAgentHost, type HostSubagentReason,
} from '../agents/host-native.js'
import type { FrozenAgent } from '../state/agent-freeze.js'
import { mainCheckoutOf } from '../workspace/main-checkout.js'
import { userHostAgentPath } from './host-agent-install.js'

export interface HostSubagentChoice {
  /** 宿主派发时用的 `subagent_type`。 */
  readonly type: string
  readonly native: boolean
  /** 没用专属子代理的原因；专属子代理没有这一项。 */
  readonly reason?: HostSubagentReason
}

/** 文件相对期望内容的状态：不存在 / 逐字一致 / 存在但不一致（含不是普通文件、读不了）。 */
type Match = 'absent' | 'same' | 'different'

const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

const fallback = (host: HostAgentHost, reason: HostSubagentReason): HostSubagentChoice =>
  ({ type: HOST_AGENT_FALLBACK[host], native: false, reason })

/** 把 `path` 的内容与 `expected` 逐字节比较：只读；符号链接会被跟随读取，但绝不写；大小不同不读内容。 */
async function compareFile(path: string, expected: Buffer): Promise<Match> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== expected.length) return 'different'
    return (await readFile(path)).equals(expected) ? 'same' : 'different'
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    return ABSENT_CODES.has(code) ? 'absent' : 'different'
  }
}

export async function resolveHostSubagent(input: {
  /** 用户级子代理目录（`hostAgentsDir` 解析出的）。 */
  readonly agentsDir: string
  readonly projectRoot: string
  readonly host: HostAgentHost
  readonly agent: FrozenAgent
}): Promise<HostSubagentChoice> {
  const { agentsDir, projectRoot, host, agent } = input
  if (agent.source === 'project') return fallback(host, 'project-agent')
  const relative = hostAgentPath(host, agent.name)
  // 名字要能被 parseHostAgentPath 原样反解：冻结锁是磁盘上的文件，挡住含 `/`、`..` 的名字，读取不会逃出宿主 agents 目录。
  if (parseHostAgentPath(relative) === null) return fallback(host, 'not-installed')
  const expected = Buffer.from(renderHostAgent(host, agent.definition), 'utf8')
  const installed = await compareFile(userHostAgentPath(agentsDir, host, agent.name), expected)
  if (installed === 'absent') return fallback(host, 'not-installed')
  if (installed === 'different') return fallback(host, 'definition-mismatch')
  const roots = [projectRoot]
  const main = await mainCheckoutOf(projectRoot)
  if (main !== undefined) roots.push(main)
  for (const root of roots) {
    if (await compareFile(join(root, ...relative.split('/')), expected) === 'different') return fallback(host, 'shadowed')
  }
  return { type: hostAgentName(agent.name), native: true }
}
