import { isAbsolute, normalize } from 'node:path'
import { stableTagForVersion, type StableReleaseTarget } from './stable-release.js'

/**
 * Host selection shared by setup and update.
 *
 * A pipeline release is one package, but installation is deliberately host-scoped: selecting
 * Codex must never also mutate Claude (and vice versa).  Keep the list aligned with
 * adapters/registry.yaml; native plugin hosts are the two runtimes that own a marketplace.
 */
export const TENON_HOSTS = [
  'codex',
  'claude',
  'cursor',
  'gemini',
  'copilot',
  'pi',
  'devin',
  'zed',
  'aider',
  'continue',
  'cline',
  'amp',
] as const

export type PipelineHost = (typeof TENON_HOSTS)[number]
export type NativePipelineHost = Extract<PipelineHost, 'codex' | 'claude'>
export type HostPluginScope = 'user' | 'project' | 'local' | 'managed'
export type RemovableHostPluginScope = Exclude<HostPluginScope, 'managed'>

/** The release marketplace is the distribution channel for the one packaged plugin. */
export const TENON_MARKETPLACE_SOURCE = 'jefferysha/tenon'
export const TENON_MARKETPLACE_NAME = 'tenon'
export const TENON_PLUGIN_NAME = 'tenon'
/** Compiled release projection; identity gates keep it equal to every package/plugin manifest. */
export const TENON_RELEASE_VERSION = '0.1.3'

export interface HostCommandPlanItem {
  readonly cmd: string
  readonly args: readonly string[]
}

export interface ParsedHostPluginInventory {
  readonly enabledIds: ReadonlySet<string>
  readonly enabledScopes: ReadonlyMap<string, ReadonlySet<HostPluginScope>>
  readonly tenonRoot: string | null
  readonly tenonVersion: string | null
  /**
   * The host owns a tenon registration in this snapshot, enabled or not.  `tenonRoot` only tracks
   * an enabled installation, so removal planning must not read absence of a root as absence of a
   * registration: a disabled entry still has to be removed before its marketplace can be.
   */
  readonly tenonRegistered: boolean
  /** Load errors the host reports for the tenon registration (for example a rejected hooks manifest). */
  readonly tenonLoadErrors: readonly string[]
}

/**
 * Parse one host-owned inventory snapshot once. A valid empty inventory is distinct from malformed
 * JSON or an unknown schema; `null` tells every caller to fail closed.
 */
export function parseHostPluginInventory(
  host: NativePipelineHost,
  stdout: string,
): ParsedHostPluginInventory | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const entries = host === 'codex'
    ? (typeof parsed === 'object'
        && parsed !== null
        && !Array.isArray(parsed)
        && Array.isArray((parsed as { installed?: unknown }).installed)
      ? (parsed as { installed: unknown[] }).installed
      : null)
    : (Array.isArray(parsed) ? parsed : null)
  if (entries === null) return null

  const ids = new Set<string>()
  const scopes = new Map<string, Set<HostPluginScope>>()
  const seenRegistrations = new Set<string>()
  let tenonRoot: string | null = null
  let tenonVersion: string | null = null
  let tenonRegistered = false
  const tenonLoadErrors: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const item = entry as {
      pluginId?: unknown
      id?: unknown
      name?: unknown
      marketplaceName?: unknown
      enabled?: unknown
      scope?: unknown
      source?: { path?: unknown }
      installPath?: unknown
      errors?: unknown
    }
    const id = host === 'codex'
      ? (typeof item.pluginId === 'string'
          ? item.pluginId
          : typeof item.name === 'string' && typeof item.marketplaceName === 'string'
            ? `${item.name}@${item.marketplaceName}`
            : null)
      : (typeof item.id === 'string' ? item.id : null)
    if (id === null) return null
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return null
    const enabled = item.enabled !== false
    const scope = item.scope === undefined
      ? 'user'
      : item.scope === 'user' || item.scope === 'project' || item.scope === 'local' || item.scope === 'managed'
        ? item.scope
        : null
    if (scope === null) return null
    const registrationKey = host === 'codex' ? id : `${id}\u0000${scope}`
    if (seenRegistrations.has(registrationKey)) return null
    seenRegistrations.add(registrationKey)
    if (enabled) {
      ids.add(id)
      const registeredScopes = scopes.get(id) ?? new Set<HostPluginScope>()
      registeredScopes.add(scope)
      scopes.set(id, registeredScopes)
    }
    if (
      id === `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`
      || (host === 'codex'
        && item.name === TENON_PLUGIN_NAME
        && item.marketplaceName === TENON_MARKETPLACE_NAME)
    ) tenonRegistered = true
    // A plugin that fails to load (rejected manifest, duplicate hooks) stays enabled in the inventory;
    // only `errors` tells it apart from a healthy install.
    if (id === `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}` && Array.isArray(item.errors)) {
      tenonLoadErrors.push(...item.errors.filter((error): error is string => typeof error === 'string'))
    }
    const candidateRoot = host === 'codex' ? item.source?.path : item.installPath
    if (
      candidateRoot !== undefined
      && (typeof candidateRoot !== 'string'
        || !isAbsolute(candidateRoot)
        || normalize(candidateRoot) !== candidateRoot)
    ) return null
    if (
      enabled
      && host === 'codex'
      && item.name === TENON_PLUGIN_NAME
      && item.marketplaceName === TENON_MARKETPLACE_NAME
      && typeof item.source?.path === 'string'
    ) {
      if (tenonRoot !== null) return null
      tenonRoot = item.source.path
      tenonVersion = typeof (entry as { version?: unknown }).version === 'string'
        ? (entry as { version: string }).version
        : null
    }
    if (
      enabled
      && host === 'claude'
      && id === `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`
      && typeof item.installPath === 'string'
    ) {
      if (tenonRoot !== null) return null
      tenonRoot = item.installPath
      tenonVersion = typeof (entry as { version?: unknown }).version === 'string'
        ? (entry as { version: string }).version
        : null
    }
  }
  return { enabledIds: ids, enabledScopes: scopes, tenonRoot, tenonVersion, tenonRegistered, tenonLoadErrors }
}

/** Enabled plugin ids as reported by the host-owned inventory. Invalid inventory is not trusted. */
export function enabledHostPluginIds(
  host: NativePipelineHost,
  stdout: string,
): ReadonlySet<string> | null {
  return parseHostPluginInventory(host, stdout)?.enabledIds ?? null
}

export function nativePluginRemovalPlan(
  host: NativePipelineHost,
  pluginId: string,
  scope: RemovableHostPluginScope = 'user',
): readonly HostCommandPlanItem[] {
  return host === 'codex'
    ? [{ cmd: 'codex', args: ['plugin', 'remove', pluginId, '--json'] }]
    : [{ cmd: 'claude', args: ['plugin', 'uninstall', pluginId, '--scope', scope] }]
}

export type PipelineHostFlags = Partial<Record<PipelineHost, boolean | undefined>>

export interface HostSelection {
  readonly host: PipelineHost | null
  readonly error: string | null
}

/** Exactly one host is required for a mutating setup/update action. */
export function selectPipelineHost(flags: PipelineHostFlags): HostSelection {
  const selected = TENON_HOSTS.filter((host) => flags[host] === true)
  const host = selected[0]
  if (selected.length === 1 && host) return { host, error: null }
  if (selected.length === 0) {
    return {
      host: null,
      error: `必须指定一个宿主：${TENON_HOSTS.map((host) => `--${host}`).join(' | ')}`,
    }
  }
  return {
    host: null,
    error: `一次只能指定一个宿主，当前同时选择：${selected.map((host) => `--${host}`).join('、')}`,
  }
}

export function isNativePipelineHost(host: PipelineHost): host is NativePipelineHost {
  return host === 'codex' || host === 'claude'
}

export function hostFlag(host: PipelineHost): `--${PipelineHost}` {
  return `--${host}`
}

/**
 * Bring a native host to the released plugin.  The final inventory command is intentional: cache
 * layouts are private implementation details, so callers must take the resolved installation root
 * from the host rather than assemble a path under ~/.codex or ~/.claude themselves.
 */
export function nativeInstallPlan(
  host: NativePipelineHost,
  releaseVersion = TENON_RELEASE_VERSION,
): readonly HostCommandPlanItem[] {
  if (host === 'codex') {
    const releaseTag = stableTagForVersion(releaseVersion)
    return [
      {
        cmd: 'codex',
        args: [
          'plugin', 'marketplace', 'add', TENON_MARKETPLACE_SOURCE,
          '--ref', releaseTag, '--json',
        ],
      },
      { cmd: 'codex', args: ['plugin', 'add', `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`, '--json'] },
      { cmd: 'codex', args: ['plugin', 'list', '--json'] },
    ]
  }
  const releaseTag = stableTagForVersion(releaseVersion)
  return [
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', `${TENON_MARKETPLACE_SOURCE}@${releaseTag}`] },
    { cmd: 'claude', args: ['plugin', 'install', `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`] },
    { cmd: 'claude', args: ['plugin', 'list', '--json'] },
  ]
}

/** Refresh and reinstall the released plugin using only the selected native host's public CLI. */
export function nativeUpdatePlan(
  host: NativePipelineHost,
  target?: StableReleaseTarget,
): readonly HostCommandPlanItem[] {
  if (target === undefined) throw new Error(`${host} update plan requires a frozen stable Release target`)
  if (host === 'codex') {
    return [
      { cmd: 'codex', args: ['plugin', 'remove', `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`, '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', TENON_MARKETPLACE_NAME, '--json'] },
      {
        cmd: 'codex',
        args: [
          'plugin', 'marketplace', 'add', TENON_MARKETPLACE_SOURCE,
          '--ref', target.tag, '--json',
        ],
      },
      { cmd: 'codex', args: ['plugin', 'add', `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`, '--json'] },
      { cmd: 'codex', args: ['plugin', 'list', '--json'] },
    ]
  }
  return [
    {
      cmd: 'claude',
      args: ['plugin', 'uninstall', `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`, '--scope', 'user'],
    },
    { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', TENON_MARKETPLACE_NAME] },
    {
      cmd: 'claude',
      args: ['plugin', 'marketplace', 'add', `${TENON_MARKETPLACE_SOURCE}@${target.tag}`],
    },
    { cmd: 'claude', args: ['plugin', 'install', `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`] },
    { cmd: 'claude', args: ['plugin', 'list', '--json'] },
  ]
}

/** Parse the host-owned plugin inventory without assuming its cache directory layout. */
export function installedPipelineRoot(host: NativePipelineHost, stdout: string): string | null {
  return parseHostPluginInventory(host, stdout)?.tenonRoot ?? null
}
