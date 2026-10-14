/**
 * 宿主原生 agent 文件的 CLI 编排。会话内的命令不写宿主子代理文件（专属子代理只来自 `tenon agent install` 写的用户级文件），
 * 这里只剩三件事：
 *   · `hostAgentHostOf`：`--host` / 进程环境 → 宿主；
 *   · `agentsDirOf`：宿主读用户级子代理的目录（跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`），安装、卸载与派发判定共用；
 *   · `cleanupLegacyHostAgentFiles`：清理升级前的版本留在项目里的旧文件（`tenon init`、任务归档与删除时）。
 * 落盘、所有权清单与主检出定位由 kernel 负责。
 */
import {
  HOST_AGENT_HOSTS, cleanupLegacyHostAgents, hostAgentsDir, renderCurrentFromLibrary,
  type HostAgentHost,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

/**
 * 宿主读用户级子代理的目录：安装、卸载与派发判定统一经这里取，保证三者落在同一个目录。
 * 环境只取自 `agentPaths().hostEnv`（生产是进程环境；测试桩不传就是空环境），不直接读 `process.env`。
 */
export function agentsDirOf(
  paths: { readonly homeDir: string; readonly hostEnv?: Readonly<Record<string, string | undefined>> },
  host: HostAgentHost,
): string {
  return hostAgentsDir(host, { homeDir: paths.homeDir, env: paths.hostEnv ?? {}, platform: process.platform })
}

/** `--host` 优先；没给时按进程环境判定的当前宿主（终端 = 无宿主，不生成）。 */
export function hostAgentHostOf(deps: CliDeps, host?: string): HostAgentHost | undefined {
  if (host !== undefined) return (HOST_AGENT_HOSTS as readonly string[]).includes(host) ? host as HostAgentHost : undefined
  const kind = deps.hostKind?.()
  if (kind === 'claude-code') return 'claude'
  if (kind === 'codex') return 'codex'
  return undefined
}

type RenderCurrent = (host: HostAgentHost, name: string) => string | undefined

/**
 * 当前库里 `(host, name)` 的渲染结果，作为「内容一致就是旧版本写的」的依据。
 * 库没装配或读不出来时返回 undefined，清理退回只按所有权清单删——读库失败不该让旧文件清不掉，也不该阻止命令。
 */
async function currentRenderer(deps: CliDeps): Promise<RenderCurrent | undefined> {
  if (deps.agentLibrary === undefined) return undefined
  try {
    return renderCurrentFromLibrary(await deps.agentLibrary())
  } catch (e) {
    deps.io.err(`WARN: 读不到 agent 库（${errMsg(e)}），旧版本写进项目的宿主 agent 文件只按所有权清单清理`)
    return undefined
  }
}

/**
 * 清理旧版本写进项目的宿主 agent 文件（在 linked worktree 里执行时清理主检出的）。尽力而为：失败只 WARN，
 * 所在命令的结果与退出码不受影响；保留下来的文件逐个 WARN。
 */
export async function cleanupLegacyHostAgentFiles(deps: CliDeps): Promise<void> {
  try {
    const renderCurrent = await currentRenderer(deps)
    const result = await cleanupLegacyHostAgents({ repoRoot: deps.cwd, ...(renderCurrent === undefined ? {} : { renderCurrent }) })
    for (const path of result.preserved) {
      deps.io.err(`WARN: 旧版本写进项目的宿主 agent 文件 ${path} 未清理（被改过或与当前定义不一致），保留；确认不需要后可手动删除`)
    }
    if (result.removed.length > 0) {
      deps.io.err(`[AGENT] 已清理旧版本写进项目的宿主 agent 文件：${result.removed.join(', ')}`)
    }
  } catch (e) {
    deps.io.err(`WARN: 旧版本写进项目的宿主 agent 文件清理失败：${errMsg(e)}`)
  }
}
