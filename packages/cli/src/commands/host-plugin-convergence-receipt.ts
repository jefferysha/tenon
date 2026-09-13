import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { CliDeps } from '../deps.js'
import { LEGACY_PLUGIN_IDENTITY } from '../migration/legacy-tenon-migration.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import type { SetupEnv } from './setupEnvironment.js'
import type {
  HostPluginScope,
  NativePipelineHost,
} from './plugin-host.js'
import type { StableReleaseTarget } from './stable-release.js'

export interface HostPluginConvergenceReceipt {
  readonly version: 4
  /** Managed release WAL owner; makes evidence replay a compare-and-return operation. */
  readonly transactionId: string
  readonly state: 'cleanup-pending' | 'completed'
  readonly host: NativePipelineHost
  readonly conflictPluginId: string
  readonly conflictScopes: readonly HostPluginScope[]
  readonly releaseId: string
  readonly releaseRoot: string
  readonly candidateRoot: string
  /** Absent only on decoded v2/v3 receipts; recovery re-derives and proves their release tag. */
  readonly stableTarget?: StableReleaseTarget
  readonly createdAtEpoch: number
  readonly updatedAt: string
}

export interface HostPluginConvergencePaths {
  readonly receiptPath: string
  readonly sessionProofPath: string
}

export type ConvergenceRead =
  | { readonly state: 'none' }
  | { readonly state: 'invalid'; readonly detail: string }
  | { readonly state: 'receipt'; readonly receipt: HostPluginConvergenceReceipt }

export function hostPluginConvergencePaths(
  env: SetupEnv,
  host: NativePipelineHost,
): HostPluginConvergencePaths {
  const paths = resolveRuntimePaths({ homeDir: env.homeDir(), env: env.runtimeEnv() })
  return {
    receiptPath: join(paths.migrationsRoot, 'host-plugin-convergence', `${host}.json`),
    sessionProofPath: join(paths.stateRoot, 'migration', 'tenon-session-loaded'),
  }
}

function isReleaseId(value: unknown): value is string {
  return typeof value === 'string' && /^sha256-[a-f0-9]{64}$/.test(value)
}

function parseStableTarget(value: unknown): StableReleaseTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const target = value as Partial<StableReleaseTarget>
  return typeof target.version === 'string'
    && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(target.version)
    && target.tag === `v${target.version}`
    && typeof target.commit === 'string'
    && /^[a-f0-9]{40}$/.test(target.commit)
    ? { version: target.version, tag: target.tag, commit: target.commit }
    : null
}

export const MAX_SUPPORTED_CONVERGENCE_RECEIPT_VERSION = 4

type ReceiptParse =
  | { readonly kind: 'ok'; readonly receipt: HostPluginConvergenceReceipt }
  | { readonly kind: 'malformed' }
  /** Written by a newer tenon; a downgraded CLI must say so instead of looking corrupt. */
  | { readonly kind: 'unsupported-version'; readonly version: number }

function parseReceipt(raw: string, host: NativePipelineHost): ReceiptParse {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { kind: 'malformed' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'malformed' }
  const receipt = value as Partial<HostPluginConvergenceReceipt>
  const receiptVersion = Reflect.get(value, 'version')
  if (
    typeof receiptVersion === 'number'
    && Number.isSafeInteger(receiptVersion)
    && receiptVersion > MAX_SUPPORTED_CONVERGENCE_RECEIPT_VERSION
  ) return { kind: 'unsupported-version', version: receiptVersion }
  if (
    (receiptVersion !== 2 && receiptVersion !== 3 && receiptVersion !== 4)
    || (receipt.state !== 'cleanup-pending' && receipt.state !== 'completed')
    || receipt.host !== host
    || receipt.conflictPluginId !== LEGACY_PLUGIN_IDENTITY
    || !Array.isArray(receipt.conflictScopes)
    || (receipt.state === 'cleanup-pending' && receipt.conflictScopes.length === 0)
    || receipt.conflictScopes.some(
      (scope) => scope !== 'user' && scope !== 'project' && scope !== 'local' && scope !== 'managed',
    )
    || new Set(receipt.conflictScopes).size !== receipt.conflictScopes.length
    || !isReleaseId(receipt.releaseId)
    || typeof receipt.releaseRoot !== 'string'
    || !isAbsolute(receipt.releaseRoot)
    || normalize(receipt.releaseRoot) !== receipt.releaseRoot
    || typeof receipt.candidateRoot !== 'string'
    || !isAbsolute(receipt.candidateRoot)
    || normalize(receipt.candidateRoot) !== receipt.candidateRoot
    || typeof receipt.createdAtEpoch !== 'number'
    || !Number.isSafeInteger(receipt.createdAtEpoch)
    || receipt.createdAtEpoch < 0
    || typeof receipt.updatedAt !== 'string'
    || receipt.updatedAt === ''
  ) return { kind: 'malformed' }
  const transactionId = Reflect.get(value, 'transactionId')
  const stableTarget = parseStableTarget(Reflect.get(value, 'stableTarget'))
  if ((receiptVersion === 3 || receiptVersion === 4)
    && (typeof transactionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(transactionId))) {
    return { kind: 'malformed' }
  }
  if (receiptVersion === 4 && stableTarget === null) return { kind: 'malformed' }
  return {
    kind: 'ok',
    receipt: {
      ...(receipt as Omit<HostPluginConvergenceReceipt, 'version' | 'transactionId' | 'stableTarget'>),
      version: 4,
      transactionId: receiptVersion === 3 || receiptVersion === 4
        ? transactionId as string
        : 'legacy-v2',
      ...(stableTarget === null ? {} : { stableTarget }),
    },
  }
}

/**
 * A receipt only exists to finish a pending legacy-plugin cleanup.  Refusing to guess at a newer
 * schema is correct, but a downgraded CLI must not become a brick: name the exact file, what is
 * lost by deleting it, and how to check the host afterwards.
 */
function unsupportedVersionDetail(
  receiptPath: string,
  version: number,
  host: NativePipelineHost,
): string {
  return `迁移 receipt 版本 ${version} 高于当前 tenon 支持的最高版本 `
    + `${MAX_SUPPORTED_CONVERGENCE_RECEIPT_VERSION}，通常来自更新版本的 tenon：${receiptPath}。`
    + '恢复方式一（推荐）：装回写入该 receipt 的更新版 tenon 并重新运行 setup/update。'
    + `恢复方式二：先运行 \`${host} plugin list\` 确认没有待清理的旧 tenon 插件，`
    + `再删除该文件（rm ${receiptPath}）后重新运行 setup；`
    + '删除后本次遗留的旧插件清理事务不会再被自动完成，需要自行确认宿主里没有重复登记'
}

export function readHostPluginConvergenceReceipt(
  env: SetupEnv,
  host: NativePipelineHost,
): ConvergenceRead {
  const { receiptPath } = hostPluginConvergencePaths(env, host)
  const read = env.readTextState(receiptPath)
  if (read.state === 'missing') return { state: 'none' }
  if (read.state === 'error') {
    return { state: 'invalid', detail: `迁移 receipt 读取失败：${receiptPath}（${read.detail}）` }
  }
  const parsed = parseReceipt(read.text, host)
  if (parsed.kind === 'ok') return { state: 'receipt', receipt: parsed.receipt }
  if (parsed.kind === 'unsupported-version') {
    return { state: 'invalid', detail: unsupportedVersionDetail(receiptPath, parsed.version, host) }
  }
  return {
    state: 'invalid',
    detail: `迁移 receipt 非法：${receiptPath}。`
      + `确认 \`${host} plugin list\` 中没有待清理的旧 tenon 插件后，`
      + `可删除该文件（rm ${receiptPath}）再重新运行 setup`,
  }
}

export function parseSessionProof(raw: string | undefined): {
  readonly host: string
  readonly releaseId: string
  readonly releaseRoot: string
  readonly loadedAtEpoch: number
} | null {
  if (raw === undefined) return null
  const fields = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator <= 0 || fields.has(line.slice(0, separator))) return null
    fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const host = fields.get('host')
  const releaseId = fields.get('release_id')
  const releaseRoot = fields.get('release_root')
  const loadedAtEpoch = Number(fields.get('loaded_at_epoch'))
  if (fields.get('version') !== '2' || (host !== 'codex' && host !== 'claude')
    || !isReleaseId(releaseId)
    || typeof releaseRoot !== 'string'
    || releaseRoot === ''
    || !Number.isSafeInteger(loadedAtEpoch)
    || loadedAtEpoch < 0) return null
  return { host, releaseId, releaseRoot, loadedAtEpoch }
}

export function writeHostPluginConvergenceReceipt(
  deps: CliDeps,
  env: SetupEnv,
  receipt: HostPluginConvergenceReceipt,
): boolean {
  const { receiptPath } = hostPluginConvergencePaths(env, receipt.host)
  try {
    env.mkdirp(dirname(receiptPath))
    env.writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    return true
  } catch (error) {
    deps.io.err(
      `ERROR: 无法持久化宿主插件收敛 receipt；为避免无证据清理，冲突登记保持不变：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}
