import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface ProductPathInput {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly platform?: NodeJS.Platform
}

/**
 * Tenon-owned machine state. Host directories such as ~/.claude and ~/.codex are deliberately
 * absent: they remain native-host discovery surfaces and are never Tenon storage roots.
 */
export interface ProductPaths {
  readonly homeDir: string
  readonly dataRoot: string
  readonly stateRoot: string
  readonly configRoot: string
  readonly releasesRoot: string
  readonly stagingRoot: string
  readonly bootstrapRoot: string
  readonly migrationsRoot: string
  readonly channelsRoot: string
  readonly selectionPath: string
  readonly auditPath: string
  readonly registryPath: string
  readonly secretsPath: string
  readonly dashboardTokenPath: string
  readonly dashboardPidfilePath: string
  /** Machine-local declared identity override `{ id, name }` (below `TENON_USER`, above git config). */
  readonly userConfigPath: string
  /** Per-install 0600 random key for HMAC identity digests in pending-decision security observations. */
  readonly decisionObservationKeyPath: string
  /** Outer lock root for the complete managed release transaction. */
  readonly managedTransactionRoot: string
}

interface ProductRootContract {
  readonly version: 1
  readonly dataRoot: string
  readonly stateRoot: string
  readonly configRoot: string
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function usableAbsolute(
  value: string | undefined,
  paths: typeof posix | typeof win32,
): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed !== '' && paths.isAbsolute(trimmed) ? paths.resolve(trimmed) : null
}

function namespacedRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string,
  paths: typeof posix | typeof win32,
): string {
  return paths.join(usableAbsolute(env[key], paths) ?? paths.join(homeDir, fallback), 'tenon')
}

function parseProductRootContract(
  raw: string,
  paths: typeof posix | typeof win32,
): ProductRootContract {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('TENON_RUNTIME_ROOTS 不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('TENON_RUNTIME_ROOTS 不是合法对象')
  }
  const record = value as Record<string, unknown>
  const dataRoot = usableAbsolute(typeof record.dataRoot === 'string' ? record.dataRoot : undefined, paths)
  const stateRoot = usableAbsolute(typeof record.stateRoot === 'string' ? record.stateRoot : undefined, paths)
  const configRoot = usableAbsolute(typeof record.configRoot === 'string' ? record.configRoot : undefined, paths)
  if (record.version !== 1 || dataRoot === null || stateRoot === null || configRoot === null) {
    throw new Error('TENON_RUNTIME_ROOTS 必须是 version=1 的绝对 data/state/config root')
  }
  return { version: 1, dataRoot, stateRoot, configRoot }
}

/** Serialize the exact roots selected by the installer for stable launcher/bootstrap handoff. */
export function serializeProductRootContract(
  paths: Pick<ProductPaths, 'dataRoot' | 'stateRoot' | 'configRoot'>,
): string {
  return JSON.stringify({
    version: 1,
    dataRoot: paths.dataRoot,
    stateRoot: paths.stateRoot,
    configRoot: paths.configRoot,
  } satisfies ProductRootContract)
}

/** Resolve every Tenon-owned machine path from one platform-aware source of truth. */
export function resolveProductPaths(input: ProductPathInput = {}): ProductPaths {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const paths = pathApi(platform)
  const homeDir = paths.resolve(input.homeDir ?? homedir())
  const inherited = env.TENON_RUNTIME_ROOTS === undefined
    ? null
    : parseProductRootContract(env.TENON_RUNTIME_ROOTS, paths)
  const overridden = usableAbsolute(env.TENON_RUNTIME_HOME, paths)

  let dataRoot: string
  let stateRoot: string
  let configRoot: string
  if (inherited !== null) {
    dataRoot = inherited.dataRoot
    stateRoot = inherited.stateRoot
    configRoot = inherited.configRoot
  } else if (overridden !== null) {
    dataRoot = paths.join(overridden, 'data')
    stateRoot = paths.join(overridden, 'state')
    configRoot = paths.join(overridden, 'config')
  } else if (platform === 'darwin') {
    const base = paths.join(homeDir, 'Library', 'Application Support', 'tenon')
    dataRoot = base
    stateRoot = paths.join(base, 'state')
    configRoot = paths.join(base, 'config')
  } else if (platform === 'win32') {
    const local = usableAbsolute(env.LOCALAPPDATA, paths)
      ?? paths.join(homeDir, 'AppData', 'Local')
    const roaming = usableAbsolute(env.APPDATA, paths)
      ?? paths.join(homeDir, 'AppData', 'Roaming')
    dataRoot = paths.join(local, 'tenon')
    stateRoot = paths.join(local, 'tenon', 'state')
    configRoot = paths.join(roaming, 'tenon')
  } else {
    dataRoot = namespacedRoot(homeDir, env, 'XDG_DATA_HOME', '.local/share', paths)
    stateRoot = namespacedRoot(homeDir, env, 'XDG_STATE_HOME', '.local/state', paths)
    configRoot = namespacedRoot(homeDir, env, 'XDG_CONFIG_HOME', '.config', paths)
  }

  return {
    homeDir,
    dataRoot,
    stateRoot,
    configRoot,
    releasesRoot: paths.join(dataRoot, 'releases'),
    stagingRoot: paths.join(dataRoot, '.staging'),
    bootstrapRoot: paths.join(dataRoot, 'bootstrap'),
    migrationsRoot: paths.join(stateRoot, 'migrations'),
    channelsRoot: paths.join(stateRoot, 'channels'),
    selectionPath: paths.join(stateRoot, 'selection.json'),
    auditPath: paths.join(stateRoot, 'audit.jsonl'),
    registryPath: paths.join(configRoot, 'projects.json'),
    secretsPath: paths.join(configRoot, 'secrets.json'),
    dashboardTokenPath: paths.join(stateRoot, 'dashboard-token.json'),
    dashboardPidfilePath: paths.join(stateRoot, 'dashboard-server.json'),
    userConfigPath: paths.join(configRoot, 'user.json'),
    decisionObservationKeyPath: paths.join(stateRoot, 'decision-observation-identity.key'),
    managedTransactionRoot: paths.join(stateRoot, 'managed-release-transaction'),
  }
}
