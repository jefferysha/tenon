import { join } from 'node:path'
import { ManagedRuntimeIndeterminateError } from '../runtime/installer.js'
import { PAYLOAD_ENTRIES } from '../runtime/release-store-codecs.js'
import { decodePluginManifestVersion } from '../runtime/plugin-manifest-version.js'
import {
  TENON_MARKETPLACE_SOURCE,
  TENON_RELEASE_VERSION,
  type NativePipelineHost,
} from './plugin-host.js'
import type { SetupEnv } from './setupEnvironment.js'
import { equivalentNativeHostDesired } from './managed-host-desired-identity.js'
import { resolveStableTagTarget, type StableReleaseTarget } from './stable-release.js'
import {
  decodeNativeHostObservation,
  observeNativeHost,
  parseManagedHostJson,
  type NativeHostObservation,
  type TenonMarketplaceState,
} from './managed-host-state.js'
export { observeNativeHost } from './managed-host-state.js'

type NativeHostDesired =
  | {
      readonly version: 1
      readonly kind: 'plugin-absent' | 'marketplace-absent'
      readonly targetVersion: string
      readonly targetCommit: string
    }
  | {
      readonly version: 1
      readonly kind: 'marketplace-present'
      readonly source: string
      readonly root: string | null
      readonly sourceType: string
      readonly head: string
      readonly ref: string
    }
  | {
      readonly version: 1
      readonly kind: 'marketplace-head'
      readonly marketplace: TenonMarketplaceState
      readonly head: string
    }
  | {
      readonly version: 1
      readonly kind: 'plugin-version'
      readonly marketplace: TenonMarketplaceState
      readonly pluginRoot: string | null
      readonly pluginVersion: string
    }

function pluginVersionAtMarketplace(env: SetupEnv, marketplace: TenonMarketplaceState): string {
  const decoded = decodePluginManifestVersion({
    codex: env.readText(join(marketplace.root, '.codex-plugin', 'plugin.json')),
    claude: env.readText(join(marketplace.root, '.claude-plugin', 'plugin.json')),
  })
  if (!decoded.ok) {
    throw new ManagedRuntimeIndeterminateError(`无法从 tenon marketplace 解析目标 plugin version：${decoded.detail}`)
  }
  return decoded.version
}

function remoteMainHead(env: SetupEnv): string {
  const result = env.runCommand('git', [
    'ls-remote',
    `https://github.com/${TENON_MARKETPLACE_SOURCE}.git`,
    'refs/heads/main',
  ])
  const head = result.code === 0 ? result.stdout.trim().split(/\s+/)[0] : undefined
  if (head === undefined || !/^[a-f0-9]{40}$/.test(head)) {
    throw new ManagedRuntimeIndeterminateError('无法解析 tenon marketplace 远端 main revision')
  }
  return head
}

function isCanonicalMarketplaceSource(source: string): boolean {
  return source === TENON_MARKETPLACE_SOURCE
    || source === `https://github.com/${TENON_MARKETPLACE_SOURCE}`
    || source === `https://github.com/${TENON_MARKETPLACE_SOURCE}.git`
}

function isCanonicalRemoteMarketplace(
  env: SetupEnv,
  host: NativePipelineHost,
  marketplace: TenonMarketplaceState,
): boolean {
  const expectedSourceType = host === 'codex' ? 'git' : 'github'
  if (marketplace.sourceType !== expectedSourceType || marketplace.head === null) return false
  const result = env.runCommand('git', ['-C', marketplace.root, 'remote', 'get-url', 'origin'])
  return result.code === 0 && isCanonicalMarketplaceSource(result.stdout.trim())
}

/**
 * Tracked `skills/*` children of the tag replace the whole `skills` entry. Upstream skills fetched into
 * the plugin root are not in the tag; verify-skills proves them against `skills/skills.lock.json`.
 */
function payloadComparisonEntries(env: Pick<SetupEnv, 'runCommand'>, marketplaceRoot: string): readonly string[] | null {
  const listed = env.runCommand('git', ['-C', marketplaceRoot, 'ls-tree', '--name-only', 'HEAD', 'skills/'])
  if (listed.code !== 0) return null
  const tracked = listed.stdout.split(/\r?\n/u).filter((line) => line !== '')
  return [...PAYLOAD_ENTRIES.filter((entry) => entry !== 'skills'), ...tracked]
}

export function pluginPayloadMatchesMarketplace(
  env: Pick<SetupEnv, 'runCommand'>,
  marketplaceRoot: string,
  pluginRoot: string,
): boolean {
  if (marketplaceRoot === pluginRoot) return true
  const entries = payloadComparisonEntries(env, marketplaceRoot)
  if (entries === null) return false
  return entries.every((entry) => {
    const result = env.runCommand('git', [
      'diff',
      '--no-index',
      '--quiet',
      '--',
      join(marketplaceRoot, entry),
      join(pluginRoot, entry),
    ])
    return result.code === 0
  })
}

/** Read-only proof used by update idempotence before deciding whether any host mutation is needed. */
export function nativeHostMatchesStableTarget(
  env: SetupEnv,
  host: NativePipelineHost,
  target: StableReleaseTarget,
): boolean {
  const current = decodeNativeHostObservation(observeNativeHost(env, host))
  return current.marketplace !== null
    && current.plugin !== null
    && current.marketplace.head === target.commit
    && current.marketplace.ref === target.tag
    && current.marketplace.clean
    && current.plugin.enabled
    && current.plugin.version === target.version
    && pluginVersionAtMarketplace(env, {
      ...current.marketplace,
      root: current.plugin.root,
    }) === target.version
    && pluginPayloadMatchesMarketplace(env, current.marketplace.root, current.plugin.root)
    && isCanonicalRemoteMarketplace(env, host, current.marketplace)
}

function hasMarketplaceIdentity(
  current: TenonMarketplaceState | null,
  expected: TenonMarketplaceState,
): current is TenonMarketplaceState {
  return current !== null
    && current.root === expected.root
    && current.source === expected.source
    && current.sourceType === expected.sourceType
}

export function desiredNativeHostPostcondition(
  env: SetupEnv,
  host: NativePipelineHost,
  stepId: string,
  target?: StableReleaseTarget,
): {
  readonly serialized: string
  isEquivalentDesired(persistedDesired: string): boolean
  isDesired(observation: string): boolean
  isCompletedCompatible?(observation: string): boolean
} {
  const before = decodeNativeHostObservation(observeNativeHost(env, host))
  let desired: NativeHostDesired
  if (stepId === 'plugin-remove') {
    if (target === undefined) {
      throw new ManagedRuntimeIndeterminateError('plugin remove 缺少冻结稳定版本目标')
    }
    desired = {
      version: 1,
      kind: 'plugin-absent',
      targetVersion: target.version,
      targetCommit: target.commit,
    }
  } else if (stepId === 'marketplace-remove') {
    if (target === undefined) {
      throw new ManagedRuntimeIndeterminateError('marketplace remove 缺少冻结稳定版本目标')
    }
    // On a fresh transaction the preceding plugin-remove checkpoint already proves absence.
    // During recovery, however, a later completed plugin-install may legitimately make the plugin
    // present again. Keep the desired identity derivable so the runner can validate the persisted
    // completed checkpoint with isCompletedCompatible instead of failing before reconciliation.
    desired = {
      version: 1,
      kind: 'marketplace-absent',
      targetVersion: target.version,
      targetCommit: target.commit,
    }
  } else if (stepId === 'marketplace-register') {
    const stableTarget = target ?? resolveStableTagTarget(env, TENON_RELEASE_VERSION)
    desired = {
      version: 1,
      kind: 'marketplace-present',
      source: TENON_MARKETPLACE_SOURCE,
      root: before.marketplace?.root ?? null,
      sourceType: host === 'codex' ? 'git' : 'github',
      head: stableTarget.commit,
      ref: stableTarget.tag,
    }
  } else if (stepId === 'marketplace-refresh') {
    if (before.marketplace === null) {
      throw new ManagedRuntimeIndeterminateError('marketplace refresh 前缺少 tenon marketplace')
    }
    if (before.marketplace.sourceType === 'local') {
      desired = {
        version: 1,
        kind: 'marketplace-head',
        marketplace: before.marketplace,
        head: before.marketplace.head ?? 'local-marketplace',
      }
    } else {
      desired = {
        version: 1,
        kind: 'marketplace-head',
        marketplace: before.marketplace,
        head: remoteMainHead(env),
      }
    }
  } else {
    if (before.marketplace === null) {
      throw new ManagedRuntimeIndeterminateError('plugin mutation 前缺少 tenon marketplace')
    }
    desired = {
      version: 1,
      kind: 'plugin-version',
      marketplace: before.marketplace,
      pluginRoot: before.plugin?.root ?? (host === 'codex' ? before.marketplace.root : null),
      pluginVersion: target?.version ?? pluginVersionAtMarketplace(env, before.marketplace),
    }
  }
  const serialized = JSON.stringify(desired)
  const matchesFrozenMarketplace = (
    current: NativeHostObservation,
    frozen: { readonly targetCommit: string; readonly targetVersion: string },
  ): boolean => current.marketplace !== null
    && current.marketplace.head === frozen.targetCommit
    && current.marketplace.ref === `v${frozen.targetVersion}`
    && current.marketplace.clean
    && isCanonicalMarketplaceSource(current.marketplace.source)
    && isCanonicalRemoteMarketplace(env, host, current.marketplace)
  return {
    serialized,
    isEquivalentDesired(persistedDesired) {
      return equivalentNativeHostDesired(persistedDesired, serialized)
    },
    isDesired(observation) {
    const current = decodeNativeHostObservation(observation)
      if (desired.kind === 'plugin-absent') return current.plugin === null
      if (desired.kind === 'marketplace-absent') {
        return current.marketplace === null && current.plugin === null
      }
      if (desired.kind === 'marketplace-present') {
        return current.marketplace !== null
          && isCanonicalMarketplaceSource(current.marketplace.source)
          && isCanonicalRemoteMarketplace(env, host, current.marketplace)
          && current.marketplace.head === desired.head
          && current.marketplace.ref === desired.ref
          && current.marketplace.clean
          && (desired.root === null || current.marketplace.root === desired.root)
          && current.marketplace.sourceType === desired.sourceType
      }
      if (desired.kind === 'marketplace-head') {
        if (!hasMarketplaceIdentity(current.marketplace, desired.marketplace)) return false
        return desired.head === 'local-marketplace'
          ? current.marketplace.head === desired.marketplace.head
          : current.marketplace.head === desired.head
      }
      if (desired.kind !== 'plugin-version') return false
      return hasMarketplaceIdentity(current.marketplace, desired.marketplace)
        && current.marketplace.head === desired.marketplace.head
        && current.marketplace.ref === desired.marketplace.ref
        && current.marketplace.clean === desired.marketplace.clean
        && (desired.pluginRoot === null || current.plugin?.root === desired.pluginRoot)
        && current.plugin?.enabled === true
        && current.plugin?.version === desired.pluginVersion
    },
    ...(desired.kind !== 'plugin-absent' && desired.kind !== 'marketplace-absent'
      ? {}
      : {
          isCompletedCompatible(observation: string) {
            const current = decodeNativeHostObservation(observation)
            if (desired.kind === 'plugin-absent') {
              return current.plugin === null
                || (matchesFrozenMarketplace(current, desired)
                  && current.plugin.enabled
                  && current.plugin.version === desired.targetVersion)
            }
            return (current.marketplace === null && current.plugin === null)
              || (matchesFrozenMarketplace(current, desired)
                && (current.plugin === null
                  || (current.plugin.enabled
                    && current.plugin.version === desired.targetVersion)))
          },
        }),
  }
}
