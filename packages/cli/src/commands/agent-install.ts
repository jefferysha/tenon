/**
 * `tenon agent install | uninstall [--host claude|codex]` —— 宿主子代理文件只在终端里由这两条命令写（删）：
 * Claude `<Claude 配置目录>/agents/tenon-<name>.md`、Codex `<Codex 配置目录>/agents/tenon-<name>.toml`。配置目录取执行本命令的
 * 进程环境里的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`（绝对路径才采用），否则 `~/.claude`、`~/.codex`——宿主只读它自己的配置目录，
 * 所以要在带同样变量的环境里执行；输出首行 `目标目录：<dir>` 让用户一眼看出装到了哪里。
 *
 * 会话内的 Tenon 命令不写这些文件（会话中途新增的子代理什么时候被宿主加载不可预期）；`tenon setup|update` 成功后经
 * 稳定启动器调用同一条命令（host-agent-install-step.ts）。落盘、所有权清单与符号链接规则在 kernel `host-agent-install`。
 *
 * 库只读官方层与自定义层（不传项目根）：在哪个项目目录执行结果都一样，项目层同名覆盖既不会让官方 agent 被跳过，
 * 也不会触发「库里已没有就删除」；项目层 agent 一律不装，派发时走通用子代理。
 * 「库里已没有就删除」只对确实不在库里的名字：条目还在、只是解析失败 / 读失败 / 重名冲突的不回收；库里一个可用条目都没有
 * （库读不出来）时整个跳过回收并 WARN。
 *
 * exit 0 = 完成（含 foreign / modified / preserved 的 WARN），1 = 用法 / 库未装配 / 有文件写（删）失败。
 */
import {
  HOST_AGENT_HOSTS, installHostAgents, loadAgentLibrary, uninstallHostAgents,
  type HostAgentHost, type HostInstallOutcome, type HostInstallState,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { agentsDirOf, hostAgentHostOf } from './agent-host.js'

/**
 * 安装提示原文；调用方知道宿主时传入，不知道时保留占位符。`dir` 是调用方检查（或将要写入）的用户级子代理目录：
 * 给了就带上它，并说明设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行；没给（库命令的提示）保持原文。
 */
export const agentInstallHint = (host = '<host>', dir?: string): string => {
  const base = `执行 tenon agent install --host ${host} 后开新会话生效`
  return dir === undefined
    ? base
    : `${base}（目标目录 ${dir}；设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行，例如会话里用 ! 前缀）`
}

/**
 * 库命令（add / new / copy / rm）成功后的提示：库的改动不在会话里写宿主文件，要经终端的安装命令才到宿主。
 * 项目层 agent 不装宿主文件（派发走通用子代理），提示里说明，免得误以为执行安装就会生效。
 */
export function hintAgentInstall(deps: CliDeps, scope: 'user' | 'project'): void {
  deps.io.err(`提示：${agentInstallHint()}`)
  if (scope === 'project') deps.io.err('提示：项目层 agent 不安装宿主文件，派发时走通用子代理')
}

interface InstallTarget {
  readonly host: HostAgentHost
  readonly payloadRoot: string
  readonly configRoot: string
  /** 宿主读用户级子代理的目录（跟随 CLAUDE_CONFIG_DIR / CODEX_HOME）。 */
  readonly agentsDir: string
}

/** `--host` 缺省：按进程环境判出的宿主；终端里（无宿主）= claude。 */
function targetOf(deps: CliDeps, rawHost: string | undefined): InstallTarget | undefined {
  const host = rawHost === undefined ? (hostAgentHostOf(deps) ?? 'claude') : hostAgentHostOf(deps, rawHost)
  if (host === undefined) {
    deps.io.err(`ERROR: --host 只能是 ${HOST_AGENT_HOSTS.join(' | ')}（收到 '${rawHost ?? ''}'）`)
    return undefined
  }
  const paths = deps.agentPaths?.()
  if (paths === undefined) {
    deps.io.err('ERROR: agent 库未装配')
    return undefined
  }
  return { host, payloadRoot: paths.payloadRoot, configRoot: paths.configRoot, agentsDir: agentsDirOf(paths, host) }
}

const DONE_WORD: Readonly<Partial<Record<HostInstallState, string>>> = {
  written: '已写入', unchanged: '未变化', removed: '已删除',
}
const MANIFEST_CORRUPT = '清单损坏'

/**
 * 逐文件一行：完成的走 stdout，其余（foreign / modified / preserved / failed）走 stderr 的 WARN。
 * 返回是否有失败、是否有实际落盘、有几个文件因为不归 Tenon 而没动（foreign / modified / preserved）。
 */
function printOutcomes(
  deps: CliDeps,
  outcomes: readonly HostInstallOutcome[],
): { failed: boolean; touched: boolean; kept: number } {
  let failed = false
  let touched = false
  let kept = 0
  let corrupt: string | undefined
  for (const outcome of outcomes) {
    // 清单损坏的说明每条结果都带一份：逐行只写文件级结论，说明本身只打一次。failed 的那条（卸载时的清单本身）自带说明。
    const corruptNote = outcome.state !== 'failed' && outcome.detail?.startsWith(MANIFEST_CORRUPT) === true
    if (corruptNote) corrupt = outcome.detail
    const word = DONE_WORD[outcome.state]
    if (word !== undefined) {
      touched = true
      deps.io.out(`[AGENT] ${word} ${outcome.path}`)
    } else {
      if (outcome.state === 'failed') failed = true
      else kept += 1
      deps.io.err(`WARN: ${outcome.path}：${corruptNote ? '已有文件，未改动' : (outcome.detail ?? outcome.state)}`)
    }
  }
  if (corrupt !== undefined) deps.io.err(`WARN: ${corrupt}`)
  return { failed, touched, kept }
}

export async function cmdAgentInstall(deps: CliDeps, opts: { readonly host?: string }): Promise<number> {
  const target = targetOf(deps, opts.host)
  if (target === undefined) return 1
  const { host, payloadRoot, configRoot, agentsDir } = target
  deps.io.out(`目标目录：${agentsDir}`)
  let outcomes: readonly HostInstallOutcome[]
  try {
    const library = await loadAgentLibrary({ payloadRoot, configRoot })
    if (library.sync.state === 'failed') deps.io.err(`WARN: 官方 agent 同步失败：${library.sync.detail}`)
    const agents = library.entries.flatMap((entry) =>
      entry.definition !== undefined
        && entry.source !== 'project'
        && (entry.definition.hosts === undefined || entry.definition.hosts.includes(host))
        ? [{ name: entry.name, definition: entry.definition }]
        : [])
    // 库里还在、只是这次解析失败 / 读失败 / 重名冲突（没有 definition）的条目：不装，但也不能当成「库里已删除」而回收已装的文件。
    const unusable = library.entries.filter((entry) => entry.source !== 'project' && entry.definition === undefined).map((entry) => entry.name)
    // 一个可用条目都没有 = 库整体读不出来或空了（官方层总是有的）：「不在列表里」不代表「库里已删除」，整个跳过回收。
    const libraryUsable = library.entries.some((entry) => entry.source !== 'project' && entry.definition !== undefined)
    if (!libraryUsable) {
      deps.io.err('WARN: agent 库里没有一个可用的 agent（库读取失败或为空）：已跳过对已安装文件的回收，没有删除任何文件')
    }
    outcomes = await installHostAgents({ agentsDir, configRoot, host, agents, keep: unusable, reclaim: libraryUsable })
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (outcomes.length === 0) deps.io.out(`[AGENT] 没有适用于 ${host} 的 agent`)
  const { failed, touched, kept } = printOutcomes(deps, outcomes)
  // setup / update 经子进程调用本命令，成功时拿不到子进程的 stderr：stdout 上的汇总让用户知道有文件没装。
  if (kept > 0) {
    deps.io.out(`[AGENT] ${kept} 个文件未改动（用户自有同名文件或被改过）；原因见 WARN，单独执行 tenon agent install --host ${host} 可重看`)
  }
  if (touched) deps.io.out('[AGENT] 子代理文件在开新会话后生效（宿主在会话启动时加载）')
  return failed ? 1 : 0
}

export async function cmdAgentUninstall(deps: CliDeps, opts: { readonly host?: string }): Promise<number> {
  const target = targetOf(deps, opts.host)
  if (target === undefined) return 1
  const { host, configRoot, agentsDir } = target
  deps.io.out(`目标目录：${agentsDir}`)
  let outcomes: readonly HostInstallOutcome[]
  try {
    outcomes = await uninstallHostAgents({ agentsDir, configRoot, host })
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (outcomes.length === 0) deps.io.out(`[AGENT] 没有可卸载的 Tenon 子代理文件（${host}）`)
  return printOutcomes(deps, outcomes).failed ? 1 : 0
}
