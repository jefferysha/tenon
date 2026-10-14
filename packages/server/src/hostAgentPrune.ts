/**
 * Dashboard 触发的任务完结、归档、删除之后，清理升级前的版本留在项目里的宿主 agent 文件（`tenon-<name>`）。
 * 清理与 CLI 共用 kernel 的 cleanupLegacyHostAgents，两条删除依据也与 CLI 同口径：所有权清单记着且没改过，
 * 或内容与当前库对应 agent 的渲染结果一致（renderCurrentFromLibrary）。服务端装配了库读取才有第二条；
 * 没装配，或读库失败（WARN 一行）时退回只按所有权清单删——读库失败不该让旧文件清不掉，也不该让任务操作失败。
 * 操作本身已经提交，这里尽力而为，失败只 WARN。
 */
import { cleanupLegacyHostAgents, loadAgentLibrary, renderCurrentFromLibrary } from '@tenon/kernel'
import type { AgentLibrary, HostAgentHost, StateStore } from '@tenon/kernel'
import { repoRootForSkills } from './serverSupport.js'
import { errText } from './transitionResult.js'

/** 读 `root` 项目可见的 agent 库（官方 + 自定义 + 该项目层）；清理据此判断「内容是否仍是旧版本写的」。 */
export type HostAgentLibraryReader = (root: string) => Promise<AgentLibrary>

/**
 * 服务端的库读取：与 agent 库路由同一份产品配置根和插件根。只需要配置根，所以入参取最小形状
 * （不 import ServerPaths：那会把整个 server 契约类型拉进 dashboard 的类型检查）。
 */
export function hostAgentLibraryReaderOf(paths: { readonly configRoot: string }): HostAgentLibraryReader {
  return (root) => loadAgentLibrary({ payloadRoot: repoRootForSkills(), configRoot: paths.configRoot, projectRoot: root })
}

type RenderCurrent = (host: HostAgentHost, name: string) => string | undefined

async function currentRenderer(root: string, readLibrary: HostAgentLibraryReader | undefined): Promise<RenderCurrent | undefined> {
  if (readLibrary === undefined) return undefined
  try {
    return renderCurrentFromLibrary(await readLibrary(root))
  } catch (error) {
    process.stderr.write(`WARN: 读不到 agent 库（${errText(error)}），旧版本写进项目的宿主 agent 文件只按所有权清单清理\n`)
    return undefined
  }
}

async function isArchived(store: StateStore, changeDir: string): Promise<boolean> {
  try {
    const value = (await store.read(changeDir)).fields.archived
    return (Array.isArray(value) ? value.join(',') : value ?? '') === 'true'
  } catch {
    return false
  }
}

/** 清理并把结果写到 stderr：保留下来的逐个 WARN，删掉的汇总一行；整体失败只 WARN。 */
export async function cleanupLegacyHostAgentsBestEffort(root: string, readLibrary?: HostAgentLibraryReader): Promise<void> {
  try {
    const renderCurrent = await currentRenderer(root, readLibrary)
    const result = await cleanupLegacyHostAgents({ repoRoot: root, ...(renderCurrent === undefined ? {} : { renderCurrent }) })
    for (const path of result.preserved) {
      process.stderr.write(`WARN: 旧版本写进项目的宿主 agent 文件 ${path} 未清理（被改过或无法确认），保留；确认不需要后可手动删除\n`)
    }
    if (result.removed.length > 0) {
      process.stderr.write(`[AGENT] 已清理旧版本写进项目的宿主 agent 文件：${result.removed.join(', ')}\n`)
    }
  } catch (error) {
    process.stderr.write(`WARN: 旧版本写进项目的宿主 agent 文件清理失败（任务已处理）: ${errText(error)}\n`)
  }
}

/** 转换把任务完结（archived=true）之后清理；还没完结的转换什么都不做。 */
export async function cleanupLegacyHostAgentsAfterArchive(
  store: StateStore,
  root: string,
  changeDir: string,
  readLibrary?: HostAgentLibraryReader,
): Promise<void> {
  if (await isArchived(store, changeDir)) await cleanupLegacyHostAgentsBestEffort(root, readLibrary)
}
