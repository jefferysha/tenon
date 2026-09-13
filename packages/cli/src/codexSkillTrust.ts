import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseManifest } from './runtime/release-store-codecs.js'

/** The host cache path is `<codex home>/plugins/cache/<marketplace>/<plugin>/<version>`. */
const TENON_CACHE_MARKETPLACE = 'tenon'
const TENON_CACHE_PLUGIN = 'tenon'
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface CodexSkillTrustRoots {
  readonly selectedCacheRoot?: string
  readonly activeReleaseRoot?: string
  readonly directDevelopmentRoot?: string
  readonly executingPluginRoot?: string
  readonly runtimeDataRoot?: string
  readonly runtimeStateRoot?: string
}

interface TrustedSkillRoot {
  readonly logical: string
  readonly physical: string
}

function isInside(base: string, candidate: string): boolean {
  const fromBase = relative(base, candidate)
  return fromBase !== '' && fromBase !== '..' && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase)
}

function safeAbsolute(value: string | undefined): string | undefined {
  return value?.trim() && isAbsolute(value.trim()) ? resolve(value.trim()) : undefined
}

export function codexHomeRoot(homeDir = homedir(), configured?: string): string {
  return safeAbsolute(configured) ?? safeAbsolute(process.env.CODEX_HOME) ?? resolve(homeDir, '.codex')
}

export function executingPluginRoot(argvEntry = process.argv[1]): string | undefined {
  const entry = safeAbsolute(argvEntry)
  if (!entry || !entry.endsWith(join('packages', 'cli', 'dist', 'tenon.mjs'))) return undefined
  return resolve(dirname(entry), '..', '..', '..')
}

export function productionCodexSkillTrustRoots(): CodexSkillTrustRoots {
  const executing = executingPluginRoot()
  const active = safeAbsolute(process.env.TENON_ACTIVE_RELEASE_ROOT)
  return {
    selectedCacheRoot: safeAbsolute(process.env.TENON_CODEX_PLUGIN_ROOT)
      ?? safeAbsolute(process.env.TENON_HOST_PLUGIN_ROOT),
    activeReleaseRoot: active,
    directDevelopmentRoot: active === undefined ? safeAbsolute(process.env.PLUGIN_ROOT) : undefined,
    executingPluginRoot: executing,
    runtimeDataRoot: safeAbsolute(process.env.TENON_RUNTIME_DATA_ROOT),
    runtimeStateRoot: safeAbsolute(process.env.TENON_RUNTIME_STATE_ROOT),
  }
}

async function ordinaryDirectoryChain(base: string, candidate: string): Promise<boolean> {
  const parts = relative(base, candidate).split(sep).filter((part) => part !== '')
  if (parts.some((part) => part === '..')) return false
  let current = base
  for (const part of ['', ...parts]) {
    if (part !== '') current = join(current, part)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
    } catch {
      return false
    }
  }
  return true
}

async function samePhysicalDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (!left) return false
  try {
    return await realpath(left) === await realpath(right)
  } catch {
    return false
  }
}

async function readOrdinaryText(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function safeSegment(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_PATH_SEGMENT.test(value) ? value : undefined
}

async function readOrdinaryRecord(path: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readOrdinaryText(path)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The cache path already encodes an identity (`<marketplace>/<plugin>/<version>`).  Trusting that
 * path alone lets an inherited `TENON_CODEX_PLUGIN_ROOT` point at a sibling cache directory whose
 * payload declares something else entirely.  Reconcile both directions the way `activeReleaseRoot`
 * reconciles its release id, and use the same identity the stable bootstrap already requires: the
 * payload's own plugin and marketplace manifests must declare exactly the marketplace, plugin and
 * version that the selected cache path claims.
 */
async function cacheIdentityReconciles(logical: string, declaredVersion: string): Promise<boolean> {
  const plugin = await readOrdinaryRecord(join(logical, '.codex-plugin', 'plugin.json'))
  const marketplace = await readOrdinaryRecord(join(logical, '.agents', 'plugins', 'marketplace.json'))
  if (plugin === undefined || marketplace === undefined) return false
  if (safeSegment(plugin.name) !== TENON_CACHE_PLUGIN) return false
  if (safeSegment(plugin.version) !== safeSegment(declaredVersion)) return false
  if (safeSegment(marketplace.name) !== TENON_CACHE_MARKETPLACE) return false
  return Array.isArray(marketplace.plugins)
    && marketplace.plugins.some((entry) =>
      typeof entry === 'object'
      && entry !== null
      && !Array.isArray(entry)
      && (entry as Record<string, unknown>).name === TENON_CACHE_PLUGIN)
}

async function selectedCacheRoot(
  roots: CodexSkillTrustRoots,
  homeDir: string,
  configured?: string,
): Promise<TrustedSkillRoot | undefined> {
  const logical = safeAbsolute(roots.selectedCacheRoot)
  if (!logical) return undefined
  const cacheBase = join(
    codexHomeRoot(homeDir, configured),
    'plugins',
    'cache',
    TENON_CACHE_MARKETPLACE,
    TENON_CACHE_PLUGIN,
  )
  const rel = relative(cacheBase, logical)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).length !== 1) return undefined
  if (!await ordinaryDirectoryChain(codexHomeRoot(homeDir, configured), logical)) return undefined
  if (!await cacheIdentityReconciles(logical, rel)) return undefined
  try {
    return { logical, physical: await realpath(logical) }
  } catch {
    return undefined
  }
}

async function activeReleaseRoot(roots: CodexSkillTrustRoots): Promise<TrustedSkillRoot | undefined> {
  const logical = safeAbsolute(roots.activeReleaseRoot)
  const runtimeData = safeAbsolute(roots.runtimeDataRoot)
  const runtimeState = safeAbsolute(roots.runtimeStateRoot)
  if (
    !logical
    || !runtimeData
    || !runtimeState
    || !await samePhysicalDirectory(roots.executingPluginRoot, logical)
  ) return undefined
  const rel = relative(join(runtimeData, 'releases'), logical).split(sep)
  if (rel.length !== 2 || !/^sha256-[a-f0-9]{64}$/.test(rel[0] ?? '') || rel[1] !== 'payload') return undefined
  if (!await ordinaryDirectoryChain(runtimeData, logical)) return undefined
  try {
    const releaseId = rel.at(0)
    if (releaseId === undefined) return undefined
    const selection = JSON.parse(await readFile(join(runtimeState, 'selection.json'), 'utf8')) as unknown
    const manifest = parseManifest(
      await readFile(join(runtimeData, 'releases', releaseId, 'release.json'), 'utf8'),
    )
    if (
      typeof selection !== 'object'
      || selection === null
      || Array.isArray(selection)
      || (selection as Record<string, unknown>).activeRelease !== releaseId
      || manifest === null
      || manifest.releaseId !== releaseId
    ) return undefined
    return { logical, physical: await realpath(logical) }
  } catch {
    return undefined
  }
}

async function directDevelopmentRoot(roots: CodexSkillTrustRoots): Promise<TrustedSkillRoot | undefined> {
  const logical = safeAbsolute(roots.directDevelopmentRoot)
  if (!logical || !await samePhysicalDirectory(roots.executingPluginRoot, logical)) return undefined
  for (const required of [
    join(logical, '.codex-plugin', 'plugin.json'),
    join(logical, 'hooks', 'codex-skill-receipt.sh'),
    join(logical, 'packages', 'cli', 'dist', 'tenon.mjs'),
  ]) {
    try {
      const info = await lstat(required)
      if (!info.isFile() || info.isSymbolicLink()) return undefined
    } catch {
      return undefined
    }
  }
  try {
    const plugin = JSON.parse(await readFile(join(logical, '.codex-plugin', 'plugin.json'), 'utf8')) as unknown
    if (
      typeof plugin !== 'object'
      || plugin === null
      || Array.isArray(plugin)
      || (plugin as Record<string, unknown>).name !== 'tenon'
      || typeof (plugin as Record<string, unknown>).version !== 'string'
    ) return undefined
    return { logical, physical: await realpath(logical) }
  } catch {
    return undefined
  }
}

export async function trustedCodexSkillPath(
  roots: CodexSkillTrustRoots,
  skillId: string,
  homeDir = homedir(),
  configured?: string,
): Promise<string | undefined> {
  const candidates = await Promise.all([
    selectedCacheRoot(roots, homeDir, configured),
    activeReleaseRoot(roots),
    directDevelopmentRoot(roots),
  ])
  for (const root of candidates) {
    if (!root) continue
    const logical = join(root.logical, 'skills', skillId, 'SKILL.md')
    if (!await ordinaryDirectoryChain(root.logical, dirname(logical))) continue
    try {
      const info = await lstat(logical)
      if (!info.isFile() || info.isSymbolicLink()) continue
      const physical = await realpath(logical)
      if (!isInside(root.physical, physical)) continue
      return logical
    } catch {
      // The next exact trust root may still own the requested skill.
    }
  }
  return undefined
}
