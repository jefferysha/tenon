import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import type {
  RuntimeAuditEntry,
  RuntimeDevSource,
  RuntimePaths,
  RuntimeReleaseManifest,
  RuntimeReleaseSource,
  RuntimeStableReleaseTarget,
  RuntimeSelection,
} from './types.js'
import { RuntimeFailure } from './types.js'

export const EMPTY_SELECTION: RuntimeSelection = {
  version: 1,
  revision: 0,
  activeRelease: null,
  previousRelease: null,
  updatedAt: '1970-01-01T00:00:00Z',
}

export const PAYLOAD_ENTRIES = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'adapters',
  'hooks',
  'packages/cli/dist/tenon.mjs',
  'packages/dashboard-app/dist',
  'packages/server/dist/dashboard.mjs',
  'runtime/tenon-bootstrap.mjs',
  'skills',
  'templates',
  'tools/verify-skills.sh',
] as const

const RELEASE_ID = /^sha256-[a-f0-9]{64}$/
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function validReleaseId(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_ID.test(value)
}

// POSIX implementations disagree on the errno for rename(stage, existing-nonempty-dir).
export function isExistingReleaseCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

function sourceFromUnknown(value: unknown): RuntimeReleaseSource | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'host,pluginVersion') return null
  const host = value.host
  const pluginVersion = nonEmptyString(value.pluginVersion)
  if ((host !== 'codex' && host !== 'claude' && host !== 'adapter' && host !== 'manual') || pluginVersion === null) {
    return null
  }
  return { host, pluginVersion }
}

function stableTargetFromUnknown(value: unknown): RuntimeStableReleaseTarget | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'commit,tag,version') return null
  const version = value.version
  const tag = value.tag
  const commit = value.commit
  if (typeof version !== 'string'
    || !STABLE_VERSION.test(version)
    || tag !== `v${version}`
    || typeof commit !== 'string'
    || !/^[a-f0-9]{40}$/.test(commit)) return null
  return { version, tag, commit }
}

const DEV_OID = /^[a-f0-9]{40}$/

function devSourceFromUnknown(value: unknown): RuntimeDevSource | null {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'commit,dirty,kind,repoRealpath,skillsIndexDigest,worktreeDigest') {
    return null
  }
  const { kind, repoRealpath, commit, dirty, worktreeDigest, skillsIndexDigest } = value
  if (kind !== 'dev'
    || typeof repoRealpath !== 'string'
    || !isAbsolute(repoRealpath)
    || normalize(repoRealpath) !== repoRealpath
    || /[\u0000-\u001f\u007f]/u.test(repoRealpath)
    || typeof commit !== 'string' || !DEV_OID.test(commit)
    || typeof dirty !== 'boolean'
    || typeof worktreeDigest !== 'string' || !DEV_OID.test(worktreeDigest)
    || typeof skillsIndexDigest !== 'string'
    || (skillsIndexDigest !== 'absent' && !DEV_OID.test(skillsIndexDigest))) return null
  return { kind: 'dev', repoRealpath, commit, dirty, worktreeDigest, skillsIndexDigest }
}

function identityFrame(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  hash.update(`${bytes.byteLength}:`, 'utf8')
  hash.update(bytes)
}

export function runtimeReleaseIdV2(
  payloadDigest: string,
  source: RuntimeReleaseSource,
  stableTarget?: RuntimeStableReleaseTarget,
  devSource?: RuntimeDevSource,
): string {
  const hash = createHash('sha256')
  for (const field of [
    'tenon-runtime-release-v2',
    payloadDigest,
    source.host,
    source.pluginVersion,
    stableTarget === undefined ? 'no-stable-target' : 'stable-target',
    stableTarget?.version ?? '',
    stableTarget?.tag ?? '',
    stableTarget?.commit ?? '',
  ]) identityFrame(hash, field)
  // 只有开发安装才追加帧：没有 devSource 的 release id 必须与历史算法逐字节相同。
  if (devSource !== undefined) {
    for (const field of [
      'dev-source',
      devSource.repoRealpath,
      devSource.commit,
      String(devSource.dirty),
      devSource.worktreeDigest,
      devSource.skillsIndexDigest,
    ]) identityFrame(hash, field)
  }
  return `sha256-${hash.digest('hex')}`
}

export function parseManifest(raw: string): RuntimeReleaseManifest | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || !validReleaseId(value.releaseId)) return null
  const payloadDigest = nonEmptyString(value.payloadDigest)
  const createdAt = nonEmptyString(value.createdAt)
  const source = sourceFromUnknown(value.source)
  if (payloadDigest === null || !/^[a-f0-9]{64}$/.test(payloadDigest) || createdAt === null || source === null) return null
  if (value.version === 1) {
    if (Object.keys(value).sort().join(',') !== 'createdAt,payloadDigest,releaseId,source,version'
      || value.releaseId !== `sha256-${payloadDigest}`) return null
    return { version: 1, releaseId: value.releaseId, payloadDigest, createdAt, source }
  }
  if (value.version !== 2) return null
  const expectedKeys = ['createdAt', 'payloadDigest', 'releaseId', 'source', 'version']
  if (value.stableTarget !== undefined) expectedKeys.push('stableTarget')
  if (value.devSource !== undefined) expectedKeys.push('devSource')
  if (Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')) return null
  const stableTarget = value.stableTarget === undefined
    ? undefined
    : stableTargetFromUnknown(value.stableTarget)
  const devSource = value.devSource === undefined
    ? undefined
    : devSourceFromUnknown(value.devSource)
  if (stableTarget === null || devSource === null) return null
  // 开发安装与正式标签互斥；开发安装只属于原生宿主。
  if (stableTarget !== undefined && devSource !== undefined) return null
  if (devSource !== undefined && source.host !== 'codex' && source.host !== 'claude') return null
  if ((stableTarget !== undefined && stableTarget.version !== source.pluginVersion)
    || value.releaseId !== runtimeReleaseIdV2(payloadDigest, source, stableTarget, devSource)) return null
  return {
    version: 2,
    releaseId: value.releaseId,
    payloadDigest,
    createdAt,
    source,
    ...(stableTarget === undefined ? {} : { stableTarget }),
    ...(devSource === undefined ? {} : { devSource }),
  }
}

export function parseSelection(raw: string): RuntimeSelection | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const revision = value.revision
  if (value.version !== 1 || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null
  const activeRelease = value.activeRelease
  const previousRelease = value.previousRelease
  const updatedAt = nonEmptyString(value.updatedAt)
  if ((activeRelease !== null && !validReleaseId(activeRelease))
    || (previousRelease !== null && !validReleaseId(previousRelease)) || updatedAt === null) return null
  return { version: 1, revision, activeRelease, previousRelease, updatedAt }
}

export function parseAudit(raw: string): RuntimeAuditEntry | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== 1) return null
  const at = nonEmptyString(value.at)
  const detail = nonEmptyString(value.detail)
  const kind = value.kind
  const releaseId = value.releaseId
  const previousRelease = value.previousRelease
  if (at === null || detail === null
    || (kind !== 'activation-prepared' && kind !== 'activated' && kind !== 'activation-rejected'
      && kind !== 'rollback-prepared' && kind !== 'rolled-back'
      && kind !== 'rollback-rejected' && kind !== 'update-rejected' && kind !== 'pruned')
    || (releaseId !== undefined && !validReleaseId(releaseId))
    || (previousRelease !== undefined && previousRelease !== null && !validReleaseId(previousRelease))) return null
  return {
    version: 1,
    at,
    kind,
    ...(releaseId === undefined ? {} : { releaseId }),
    ...(previousRelease === undefined ? {} : { previousRelease }),
    detail,
  }
}

export function stableJson(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export async function readReleaseManifest(releaseRoot: string): Promise<RuntimeReleaseManifest | null> {
  try {
    return parseManifest(await readFile(join(releaseRoot, 'release.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function readSelection(paths: RuntimePaths): Promise<RuntimeSelection> {
  try {
    const parsed = parseSelection(await readFile(paths.selectionPath, 'utf8'))
    if (parsed !== null) return parsed
    throw new RuntimeFailure('runtime-corrupt', 'managed runtime selection.json 格式无效')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_SELECTION
    throw error
  }
}

export interface RuntimeAuditState {
  readonly lastAudit: RuntimeAuditEntry | null
  readonly auditCorrupt: boolean
}

export async function readAuditState(paths: RuntimePaths): Promise<RuntimeAuditState> {
  try {
    const raw = await readFile(paths.auditPath, 'utf8')
    if (raw === '') return { lastAudit: null, auditCorrupt: false }
    if (!raw.endsWith('\n')) return { lastAudit: null, auditCorrupt: true }
    const lines = raw.slice(0, -1).split(/\r?\n/)
    let latest: RuntimeAuditEntry | null = null
    for (const line of lines) {
      if (line === '') return { lastAudit: null, auditCorrupt: true }
      const parsed = parseAudit(line)
      if (parsed === null) return { lastAudit: null, auditCorrupt: true }
      latest = parsed
    }
    return { lastAudit: latest, auditCorrupt: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lastAudit: null, auditCorrupt: false }
    }
    return { lastAudit: null, auditCorrupt: true }
  }
}

export async function lastAudit(paths: RuntimePaths): Promise<RuntimeAuditEntry | null> {
  return (await readAuditState(paths)).lastAudit
}

export async function writeAudit(paths: RuntimePaths, entry: RuntimeAuditEntry): Promise<void> {
  await appendFile(paths.auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
}
