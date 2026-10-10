import { realpathSync } from 'node:fs'
import { ManagedRuntimeIndeterminateError } from '../runtime/installer.js'
import type { NativeHostCommandEnvironment } from './native-host-command-binding.js'
import {
  parseHostPluginInventory,
  TENON_MARKETPLACE_NAME,
  TENON_PLUGIN_NAME,
  type HostCommandPlanItem,
  type NativePipelineHost,
} from './plugin-host.js'

const PLUGIN_ID = `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`
/** Claude 回 `directory`，Codex 回 `local`。 */
const DIRECTORY_SOURCE_TYPES: ReadonlySet<string> = new Set(['directory', 'local'])

type CommandRunner = Pick<NativeHostCommandEnvironment, 'runCommand'>

/**
 * 与 nativeUpdatePlan 同位置同长度（plugin-remove / marketplace-remove / marketplace-register /
 * plugin-install / inventory-after），所以 nativeHostConvergenceSequence 与 WAL 的 step id 可以原样复用。
 * 区别只在于 register 的来源是仓库目录而不是 GitHub 标签。
 */
export function devHostPlan(host: NativePipelineHost, repoRealpath: string): readonly HostCommandPlanItem[] {
  if (host === 'codex') {
    return [
      { cmd: 'codex', args: ['plugin', 'remove', PLUGIN_ID, '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', TENON_MARKETPLACE_NAME, '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'add', repoRealpath, '--json'] },
      { cmd: 'codex', args: ['plugin', 'add', PLUGIN_ID, '--json'] },
      { cmd: 'codex', args: ['plugin', 'list', '--json'] },
    ]
  }
  return [
    { cmd: 'claude', args: ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'] },
    { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', TENON_MARKETPLACE_NAME] },
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', repoRealpath] },
    { cmd: 'claude', args: ['plugin', 'install', PLUGIN_ID] },
    { cmd: 'claude', args: ['plugin', 'list', '--json'] },
  ]
}

export interface DevHostObservation {
  readonly version: 1
  readonly host: NativePipelineHost
  readonly marketplace: { readonly sourceType: string; readonly path: string } | null
  readonly plugin: {
    readonly enabled: boolean
    readonly version: string | null
    readonly root: string | null
  } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readJson(env: CommandRunner, cmd: string, args: string[], label: string): unknown {
  const result = env.runCommand(cmd, args)
  if (result.code !== 0) {
    throw new ManagedRuntimeIndeterminateError(`${label} 读取失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new ManagedRuntimeIndeterminateError(`${label} 不是合法 JSON`)
  }
}

function marketplaceOf(host: NativePipelineHost, value: unknown): DevHostObservation['marketplace'] {
  const entries = host === 'codex'
    ? (isRecord(value) && Array.isArray(value.marketplaces) ? value.marketplaces : null)
    : (Array.isArray(value) ? value : null)
  if (entries === null) throw new ManagedRuntimeIndeterminateError(`${host} marketplace inventory schema 非法`)
  const matches = entries.filter((entry) => isRecord(entry) && entry.name === TENON_MARKETPLACE_NAME)
  if (matches.length > 1) throw new ManagedRuntimeIndeterminateError(`${host} tenon marketplace identity 重复`)
  const item = matches[0]
  if (item === undefined) return null
  if (!isRecord(item)) throw new ManagedRuntimeIndeterminateError(`${host} marketplace inventory entry 非法`)
  if (host === 'codex') {
    const source = isRecord(item.marketplaceSource) ? item.marketplaceSource : null
    const sourceType = typeof source?.sourceType === 'string' ? source.sourceType : ''
    const path = typeof source?.source === 'string' ? source.source : typeof item.root === 'string' ? item.root : ''
    return { sourceType, path: realOrSame(path) }
  }
  const sourceType = typeof item.source === 'string' ? item.source : ''
  const path = typeof item.path === 'string'
    ? item.path
    : typeof item.installLocation === 'string' ? item.installLocation : ''
  return { sourceType, path: realOrSame(path) }
}

/**
 * 开发安装专用的宿主观察：不依赖 observeNativeHost 对 canonical GitHub 源的假设，
 * 也不去 git 里读 marketplace 的 HEAD/ref/clean（目录 marketplace 就是工作区本身，脏是常态）。
 */
export function observeDevNativeHost(env: CommandRunner, host: NativePipelineHost): string {
  const marketplace = marketplaceOf(
    host,
    readJson(env, host, ['plugin', 'marketplace', 'list', '--json'], `${host} marketplace inventory`),
  )
  const listing = env.runCommand(host, ['plugin', 'list', '--json'])
  if (listing.code !== 0) {
    throw new ManagedRuntimeIndeterminateError(`${host} plugin inventory 读取失败：${listing.stderr.trim() || `退出码 ${listing.code}`}`)
  }
  const inventory = parseHostPluginInventory(host, listing.stdout)
  if (inventory === null) throw new ManagedRuntimeIndeterminateError(`${host} plugin inventory 响应畸形`)
  const plugin = inventory.tenonRegistered
    ? { enabled: inventory.tenonRoot !== null, version: inventory.tenonVersion, root: inventory.tenonRoot }
    : null
  return JSON.stringify({ version: 1, host, marketplace, plugin } satisfies DevHostObservation)
}

export function decodeDevObservation(text: string): DevHostObservation {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ManagedRuntimeIndeterminateError('开发安装的宿主 observation 不是合法 JSON')
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new ManagedRuntimeIndeterminateError('开发安装的宿主 observation schema 非法')
  }
  const { host, marketplace, plugin } = value
  const nullableString = (candidate: unknown): boolean => candidate === null || typeof candidate === 'string'
  const marketplaceOk = marketplace === null
    || (isRecord(marketplace) && typeof marketplace.sourceType === 'string' && typeof marketplace.path === 'string')
  const pluginOk = plugin === null
    || (isRecord(plugin) && typeof plugin.enabled === 'boolean' && nullableString(plugin.version) && nullableString(plugin.root))
  if ((host !== 'claude' && host !== 'codex') || !marketplaceOk || !pluginOk) {
    throw new ManagedRuntimeIndeterminateError('开发安装的宿主 observation schema 非法')
  }
  return { version: 1, host, marketplace, plugin } as DevHostObservation
}

export function devMarketplaceIsRepo(observation: DevHostObservation, repoRealpath: string): boolean {
  return observation.marketplace !== null
    && DIRECTORY_SOURCE_TYPES.has(observation.marketplace.sourceType)
    && observation.marketplace.path === realOrSame(repoRealpath)
}

export function devHostMatches(
  observation: DevHostObservation,
  repoRealpath: string,
  pluginVersion: string,
): boolean {
  return devMarketplaceIsRepo(observation, repoRealpath)
    && observation.plugin?.enabled === true
    && observation.plugin.version === pluginVersion
}

/**
 * managed-host-command.ts 会在 env.managedHostReconciliation 存在时用它代替稳定标签的
 * desiredNativeHostPostcondition。desired 里带着仓库与版本，换仓库重试 WAL 会被 desiredMatches 拒绝。
 */
export function devHostReconciliation(
  env: CommandRunner,
  repoRealpath: string,
  pluginVersion: string,
): NonNullable<NativeHostCommandEnvironment['managedHostReconciliation']> {
  const repo = realOrSame(repoRealpath)
  return (host, stepId) => {
    const observe = (): string => observeDevNativeHost(env, host)
    const at = (observation: string): DevHostObservation => decodeDevObservation(observation)
    switch (stepId) {
      case 'plugin-remove':
        return {
          desired: JSON.stringify({ version: 1, kind: 'plugin-absent', host }),
          observe,
          isDesired: (observation) => at(observation).plugin === null,
          // 后续 step 合法地把插件装回来；只认「回到本仓库」这一种后继状态。
          isCompletedCompatible: (observation) => {
            const current = at(observation)
            return current.plugin === null || devHostMatches(current, repo, pluginVersion)
          },
        }
      case 'marketplace-remove':
        return {
          desired: JSON.stringify({ version: 1, kind: 'marketplace-absent', host }),
          observe,
          isDesired: (observation) => {
            const current = at(observation)
            return current.marketplace === null && current.plugin === null
          },
          isCompletedCompatible: (observation) => {
            const current = at(observation)
            return (current.marketplace === null && current.plugin === null)
              || (devMarketplaceIsRepo(current, repo)
                && (current.plugin === null || devHostMatches(current, repo, pluginVersion)))
          },
        }
      case 'marketplace-register':
        return {
          desired: JSON.stringify({ version: 1, kind: 'marketplace-present', host, repo }),
          observe,
          isDesired: (observation) => devMarketplaceIsRepo(at(observation), repo),
        }
      case 'plugin-install':
        return {
          desired: JSON.stringify({ version: 1, kind: 'plugin-installed', host, repo, pluginVersion }),
          observe,
          isDesired: (observation) => devHostMatches(at(observation), repo, pluginVersion),
        }
      default:
        throw new ManagedRuntimeIndeterminateError(`开发安装的宿主 step '${stepId}' 没有对应的 desired-state`)
    }
  }
}
