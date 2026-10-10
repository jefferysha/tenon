import { isAbsolute, join, normalize } from 'node:path'
import { ManagedRuntimeIndeterminateError } from '../runtime/installer.js'
import {
  TENON_MARKETPLACE_NAME,
  TENON_PLUGIN_NAME,
  type NativePipelineHost,
} from './plugin-host.js'
import type { SetupEnv } from './setupEnvironment.js'

export interface TenonMarketplaceState {
  readonly root: string
  readonly source: string
  readonly sourceType: string
  readonly head: string | null
  readonly ref: string | null
  readonly clean: boolean
}

export interface TenonPluginState {
  readonly id: string
  readonly version: string
  readonly root: string
  readonly enabled: boolean
}

export interface NativeHostObservation {
  readonly version: 1
  readonly host: NativePipelineHost
  readonly marketplace: TenonMarketplaceState | null
  readonly plugin: TenonPluginState | null
}

const SAFE_MARKETPLACE_REF = /^[^\u0000-\u001f\u007f"'\\]+$/u

function explicitCodexMarketplaceRef(
  item: Record<string, unknown>,
  sourceRecord: Record<string, unknown> | null,
): string | null | undefined {
  const candidates: unknown[] = []
  for (const [record, key] of [
    [item, 'ref'],
    [sourceRecord, 'ref'],
  ] as const) {
    if (record !== null && Object.prototype.hasOwnProperty.call(record, key)) {
      candidates.push(record[key])
    }
  }
  if (candidates.length === 0) return undefined
  if (candidates.length !== 1) {
    throw new ManagedRuntimeIndeterminateError('codex marketplace inventory ref 重复')
  }
  const value = candidates[0]
  if (value === null) return null
  if (typeof value !== 'string' || value === '' || !SAFE_MARKETPLACE_REF.test(value)) {
    throw new ManagedRuntimeIndeterminateError('codex marketplace inventory ref 非法')
  }
  return value
}

function parseCodexMarketplaceConfigRef(text: string): string | null {
  let inTenonSection = false
  let sectionCount = 0
  let ref: string | null = null
  let refSeen = false
  for (const line of text.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)
    if (section !== null) {
      inTenonSection = section[1]?.trim() === 'marketplaces.tenon'
      if (inTenonSection) {
        sectionCount += 1
        if (sectionCount > 1) {
          throw new ManagedRuntimeIndeterminateError('Codex config 中 marketplaces.tenon 重复')
        }
      }
      continue
    }
    if (!inTenonSection || /^\s*(?:#.*)?$/u.test(line)) continue
    if (!/^\s*ref\s*=/u.test(line)) continue
    if (refSeen) {
      throw new ManagedRuntimeIndeterminateError('Codex config 中 Tenon marketplace ref 重复')
    }
    refSeen = true
    const assignment = /^\s*ref\s*=\s*(?:"([^"\\\r\n]+)"|'([^'\r\n]+)')\s*(?:#.*)?$/u.exec(line)
    const value = assignment?.[1] ?? assignment?.[2]
    if (value === undefined || !SAFE_MARKETPLACE_REF.test(value)) {
      throw new ManagedRuntimeIndeterminateError('Codex config 中 Tenon marketplace ref 非法')
    }
    ref = value
  }
  return ref
}

function codexConfiguredMarketplaceRef(
  env: SetupEnv,
  item: Record<string, unknown>,
  sourceRecord: Record<string, unknown> | null,
  root: string,
): string | null {
  const explicit = explicitCodexMarketplaceRef(item, sourceRecord)
  if (explicit !== undefined) return explicit

  const runtimeEnv = env.runtimeEnv()
  const configuredHome = runtimeEnv.CODEX_HOME?.trim()
  const codexHome = configuredHome === undefined || configuredHome === ''
    ? join(env.homeDir(), '.codex')
    : configuredHome
  const config = env.readText(join(codexHome, 'config.toml'))
  if (config !== undefined) {
    const ref = parseCodexMarketplaceConfigRef(config)
    if (ref !== null) return ref
  }

  // Compatibility only: older test hosts and early Codex previews wrote this checkout-local file.
  const installMetadata = env.readText(join(root, '.codex-marketplace-install.json'))
  if (installMetadata === undefined) return null
  const metadata = parseManagedHostJson(installMetadata, 'codex marketplace install metadata')
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
    || ((metadata as Record<string, unknown>).ref_name !== null
      && (typeof (metadata as Record<string, unknown>).ref_name !== 'string'
        || (metadata as Record<string, unknown>).ref_name === ''
        || !SAFE_MARKETPLACE_REF.test((metadata as Record<string, unknown>).ref_name as string)))) {
    throw new ManagedRuntimeIndeterminateError('codex marketplace ref metadata 非法')
  }
  return (metadata as { ref_name: string | null }).ref_name
}

export function parseManagedHostJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ManagedRuntimeIndeterminateError(`${label} 不是合法 JSON`)
  }
}

function commandJson(env: SetupEnv, cmd: string, args: string[], label: string): unknown {
  const result = env.runCommand(cmd, args)
  if (result.code !== 0) {
    throw new ManagedRuntimeIndeterminateError(
      `${label} 读取失败：${result.stderr.trim() || `退出码 ${result.code}`}`,
    )
  }
  return parseManagedHostJson(result.stdout, label)
}

function marketplaceState(
  env: SetupEnv,
  host: NativePipelineHost,
  value: unknown,
): TenonMarketplaceState | null {
  const entries = host === 'codex'
    ? (typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Array.isArray((value as { marketplaces?: unknown }).marketplaces)
      ? (value as { marketplaces: unknown[] }).marketplaces
      : null)
    : (Array.isArray(value) ? value : null)
  if (entries === null) {
    throw new ManagedRuntimeIndeterminateError(`${host} marketplace inventory schema 非法`)
  }
  const matches: TenonMarketplaceState[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManagedRuntimeIndeterminateError(`${host} marketplace inventory entry 非法`)
    }
    const item = entry as Record<string, unknown>
    if (item.name !== TENON_MARKETPLACE_NAME) continue
    const root = host === 'codex' ? item.root : item.installLocation
    const sourceRecord = host === 'codex' && typeof item.marketplaceSource === 'object'
      && item.marketplaceSource !== null
      ? item.marketplaceSource as Record<string, unknown>
      : null
    const source = host === 'codex'
      ? sourceRecord?.source
      // 目录 marketplace（tenon setup --from-source）没有 repo 字段，身份就是它登记的 path。
      : item.repo ?? (item.source === 'directory' ? item.path : undefined)
    const sourceType = host === 'codex' ? sourceRecord?.sourceType : item.source
    if (typeof root !== 'string'
      || !isAbsolute(root)
      || normalize(root) !== root
      || typeof source !== 'string'
      || source === ''
      || typeof sourceType !== 'string'
      || sourceType === '') {
      throw new ManagedRuntimeIndeterminateError(`${host} tenon marketplace identity 不完整`)
    }
    const headResult = env.runCommand('git', ['-C', root, 'rev-parse', 'HEAD'])
    const head = headResult.code === 0 && /^[a-f0-9]{40}$/.test(headResult.stdout.trim())
      ? headResult.stdout.trim()
      : null
    let ref: string | null = null
    if (host === 'codex') {
      ref = codexConfiguredMarketplaceRef(env, item, sourceRecord, root)
    } else {
      const symbolic = env.runCommand('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (symbolic.code === 0 && symbolic.stdout.trim() !== '') {
        ref = symbolic.stdout.trim()
      } else {
        const exactTag = env.runCommand('git', ['-C', root, 'describe', '--tags', '--exact-match', 'HEAD'])
        if (exactTag.code === 0 && exactTag.stdout.trim() !== '') ref = exactTag.stdout.trim()
      }
    }
    const tracked = env.runCommand('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'])
    const untracked = env.runCommand('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'])
    const unexpectedUntracked = untracked.code === 0
      ? untracked.stdout.split(/\r?\n/).filter((path) =>
          path !== '' && path !== '.codex-marketplace-install.json')
      : ['unreadable']
    const clean = tracked.code === 0 && unexpectedUntracked.length === 0
    matches.push({ root, source, sourceType, head, ref, clean })
  }
  if (matches.length > 1) {
    throw new ManagedRuntimeIndeterminateError(`${host} tenon marketplace identity 重复`)
  }
  return matches[0] ?? null
}

function pluginState(host: NativePipelineHost, value: unknown): TenonPluginState | null {
  const entries = host === 'codex'
    ? (typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Array.isArray((value as { installed?: unknown }).installed)
      ? (value as { installed: unknown[] }).installed
      : null)
    : (Array.isArray(value) ? value : null)
  if (entries === null) throw new ManagedRuntimeIndeterminateError(`${host} plugin inventory schema 非法`)
  const expectedId = `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`
  const matches: TenonPluginState[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManagedRuntimeIndeterminateError(`${host} plugin inventory entry 非法`)
    }
    const item = entry as Record<string, unknown>
    const id = host === 'codex' ? item.pluginId : item.id
    if (id !== expectedId) continue
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new ManagedRuntimeIndeterminateError(`${host} tenon plugin enabled 状态非法`)
    }
    const root = host === 'codex'
      && typeof item.source === 'object'
      && item.source !== null
      ? (item.source as Record<string, unknown>).path
      : item.installPath
    if (typeof item.version !== 'string'
      || typeof root !== 'string'
      || !isAbsolute(root)
      || normalize(root) !== root) {
      throw new ManagedRuntimeIndeterminateError(`${host} tenon plugin identity 不完整`)
    }
    matches.push({ id, version: item.version, root, enabled: item.enabled !== false })
  }
  if (matches.length > 1) {
    throw new ManagedRuntimeIndeterminateError(`${host} tenon plugin identity 重复`)
  }
  return matches[0] ?? null
}

export function observeNativeHost(env: SetupEnv, host: NativePipelineHost): string {
  const marketplace = marketplaceState(
    env,
    host,
    commandJson(env, host, ['plugin', 'marketplace', 'list', '--json'], `${host} marketplace inventory`),
  )
  const plugin = pluginState(
    host,
    commandJson(env, host, ['plugin', 'list', '--json'], `${host} plugin inventory`),
  )
  return JSON.stringify({ version: 1, host, marketplace, plugin } satisfies NativeHostObservation)
}

export function decodeNativeHostObservation(value: string): NativeHostObservation {
  const parsed = parseManagedHostJson(value, 'managed host observation')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManagedRuntimeIndeterminateError('managed host observation schema 非法')
  }
  return parsed as NativeHostObservation
}
