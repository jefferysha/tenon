/**
 * Trust boundary for the Build -> Verify revision.
 *
 * `build_sha` is deliberately kept as the public state field for compatibility, but a
 * value written by the current runtime is a typed token.  Nothing outside this module should
 * compare a raw Git SHA or workspace baseline directly: those values do not bind the project,
 * worktree, or the Build transition that produced them.
 */
import { sha256Hex } from '../sha256.js'

export const BUILD_REVISION_TOKEN_PREFIX = 'build:v1:'
export const BUILD_REVISION_CODE = 'verify-build-revision-untrusted' as const
export const BUILD_REVISION_REMEDIATION = 'return-to-build-and-capture-current-revision' as const

export const BUILD_REVISION_REASONS = [
  'missing', 'null', 'ambiguous', 'malformed', 'isolation-mismatch',
  'capability-unavailable', 'provenance-missing', 'provenance-mismatch',
  'state-stale', 'revision-stale', 'project-mismatch', 'worktree-mismatch',
  'evaluation-error',
] as const
export type BuildRevisionReason = (typeof BUILD_REVISION_REASONS)[number]

export type BuildRevisionKind = 'git' | 'workspace'

/**
 * 隔离方式对应的构建版本类别，是捕获、复核与 Dashboard 快照共用的唯一判定：`branch` 绑 git object，
 * 其余（`worktree`、`in-place`）绑工作区内容指纹——任务 worktree 里的实现常常尚未提交，HEAD 不动而内容在变。
 * 取值是否合法由调用方另行判定（复核对非法取值返回 `isolation-mismatch`），这里不抛错。
 */
export function expectedBuildRevisionKind(isolation: string): BuildRevisionKind {
  return isolation === 'branch' ? 'git' : 'workspace'
}

export interface BuildRevisionIdentity {
  /** Physical Git common directory.  It is consumed locally and never put in a blocker. */
  readonly repository: string
  /** Physical worktree top-level + Git directory identity. */
  readonly worktree: string
}

export interface BuildRevisionObservation {
  readonly kind: BuildRevisionKind
  readonly revision: string
  readonly identity: BuildRevisionIdentity
}

export interface BuildRevisionToken {
  readonly kind: BuildRevisionKind
  readonly revisionHash: string
  readonly repositoryHash: string
  readonly worktreeHash: string
  readonly value: string
}

export interface BuildRevisionProvenance {
  readonly currentStep: string
  readonly stateBuildSha?: string
  /** Digest of the canonical current fields read with the validated head. */
  readonly stateHash?: string
  readonly recordTo: string
  readonly buildShaEffects: readonly string[]
}

export interface BuildRevisionBlocker {
  readonly kind: 'verify-build-revision-untrusted'
  readonly code: typeof BUILD_REVISION_CODE
  readonly reason: BuildRevisionReason
  readonly remediation: typeof BUILD_REVISION_REMEDIATION
  readonly stateHash?: string
  readonly revisionHash?: string
}

/**
 * 构建候选的隔离方式不再是用户要填的槽（设计 §1b Q1 删除了 isolation 的检查与推荐值）：状态里没设（空串或字面 'null'）
 * 就按 in-place 取——冻结与复验都绑定工作区内容，不依赖 Git 分支 / worktree，也不依赖 HEAD。显式写过的
 * branch / worktree / in-place 原样使用；枚举之外的脏值原样返回，由调用方失败关闭。
 * 冻结（freeze-build-sha）与复验（build-head-unchanged）必须经这一个函数取值，两边才不会各取各的。
 */
export function effectiveBuildIsolation(raw: string): string {
  return raw === '' || raw === 'null' ? 'in-place' : raw
}

export interface BuildRevisionAssessmentRequest {
  readonly buildSha: unknown
  readonly isolation: string
  readonly expectedStep?: string
  readonly stateHash?: string
  readonly observe: () => Promise<BuildRevisionObservation>
  readonly provenance?: () => Promise<BuildRevisionProvenance | undefined>
}

export type BuildRevisionAssessment =
  | { readonly trusted: true; readonly token: BuildRevisionToken }
  | { readonly trusted: false; readonly blocker: BuildRevisionBlocker }

export class BuildRevisionCaptureError extends Error {
  readonly blocker: BuildRevisionBlocker

  constructor(reason: BuildRevisionReason, stateHash?: string, revisionHash?: string) {
    super('build revision capture was not trusted')
    this.name = 'BuildRevisionCaptureError'
    this.blocker = makeBuildRevisionBlocker(reason, stateHash, revisionHash)
  }
}

export function makeBuildRevisionBlocker(
  reason: BuildRevisionReason,
  stateHash?: string,
  revisionHash?: string,
): BuildRevisionBlocker {
  return {
    kind: 'verify-build-revision-untrusted',
    code: BUILD_REVISION_CODE,
    reason,
    remediation: BUILD_REVISION_REMEDIATION,
    ...(stateHash === undefined ? {} : { stateHash }),
    ...(revisionHash === undefined ? {} : { revisionHash }),
  }
}

function sha256(domain: string, value: string): string {
  return sha256Hex(`${domain}\0${value}`)
}

/** Hash arbitrary state input without exposing it in API/log projections. */
export function safeRevisionHash(value: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(value) ?? ''
  } catch {
    encoded = ''
  }
  return `sha256:${sha256('tenon/build-revision/state/v1', encoded)}`
}

export function hashBuildRevisionIdentity(identity: BuildRevisionIdentity): {
  readonly repositoryHash: string
  readonly worktreeHash: string
} {
  return {
    repositoryHash: sha256('tenon/build-revision/repository/v1', identity.repository),
    worktreeHash: sha256('tenon/build-revision/worktree/v1', identity.worktree),
  }
}

function hashRevision(kind: BuildRevisionKind, revision: string): string {
  return sha256(`tenon/build-revision/revision/${kind}/v1`, revision)
}

const TOKEN_RE = /^build:v1:(git|workspace):([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/
const GIT_REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const WORKSPACE_REVISION_RE = /^workspace:sha256:[a-f0-9]{64}$/

export function createBuildRevisionToken(
  kind: BuildRevisionKind,
  revision: string,
  identity: BuildRevisionIdentity,
): BuildRevisionToken {
  if (kind !== 'git' && kind !== 'workspace') throw new BuildRevisionCaptureError('malformed')
  if (typeof revision !== 'string') throw new BuildRevisionCaptureError('malformed')
  const normalized = revision.trim().toLowerCase()
  if (kind === 'git' && !GIT_REVISION_RE.test(normalized)) {
    throw new BuildRevisionCaptureError('malformed')
  }
  if (kind === 'workspace' && !WORKSPACE_REVISION_RE.test(normalized)) {
    throw new BuildRevisionCaptureError('malformed')
  }
  if (identity === null || typeof identity !== 'object'
    || typeof identity.repository !== 'string' || typeof identity.worktree !== 'string'
    || identity.repository.trim() === '' || identity.worktree.trim() === '') {
    throw new BuildRevisionCaptureError('capability-unavailable')
  }
  const { repositoryHash, worktreeHash } = hashBuildRevisionIdentity(identity)
  const revisionHash = hashRevision(kind, normalized)
  return {
    kind,
    revisionHash,
    repositoryHash,
    worktreeHash,
    value: `${BUILD_REVISION_TOKEN_PREFIX}${kind}:${revisionHash}:${repositoryHash}:${worktreeHash}`,
  }
}

export function parseBuildRevisionToken(value: unknown): BuildRevisionToken | undefined {
  if (typeof value !== 'string') return undefined
  const match = TOKEN_RE.exec(value)
  if (!match) return undefined
  const kind = match[1] as BuildRevisionKind
  const revisionHash = match[2]
  const repositoryHash = match[3]
  const worktreeHash = match[4]
  if (!revisionHash || !repositoryHash || !worktreeHash) return undefined
  return {
    kind,
    revisionHash,
    repositoryHash,
    worktreeHash,
    value,
  }
}

function blockerFor(
  reason: BuildRevisionReason,
  request: BuildRevisionAssessmentRequest,
  token?: BuildRevisionToken,
): BuildRevisionBlocker {
  return makeBuildRevisionBlocker(
    reason,
    request.stateHash,
    token === undefined ? undefined : `sha256:${token.revisionHash}`,
  )
}

/**
 * Re-evaluate the token against fresh capabilities and the immutable transition head.
 * Every failure is a closed, privacy-safe blocker; callers must never turn one into `skipped`.
 */
export async function assessBuildRevisionTrust(
  request: BuildRevisionAssessmentRequest,
): Promise<BuildRevisionAssessment> {
  const candidate = request.buildSha
  if (candidate === undefined || candidate === '') {
    return { trusted: false, blocker: blockerFor('missing', request) }
  }
  if (candidate === null || candidate === 'null') {
    return { trusted: false, blocker: blockerFor('null', request) }
  }
  if (Array.isArray(candidate)) {
    return { trusted: false, blocker: blockerFor('ambiguous', request) }
  }
  if (typeof candidate !== 'string') {
    return { trusted: false, blocker: blockerFor('malformed', request) }
  }
  const token = parseBuildRevisionToken(candidate)
  if (token === undefined) return { trusted: false, blocker: blockerFor('malformed', request) }
  if (request.isolation !== 'in-place' && request.isolation !== 'branch' && request.isolation !== 'worktree') {
    return { trusted: false, blocker: blockerFor('isolation-mismatch', request, token) }
  }
  if (token.kind !== expectedBuildRevisionKind(request.isolation)) {
    return { trusted: false, blocker: blockerFor('isolation-mismatch', request, token) }
  }

  let observation: BuildRevisionObservation
  try {
    observation = await request.observe()
  } catch {
    return { trusted: false, blocker: blockerFor('evaluation-error', request, token) }
  }
  if (!observation || typeof observation !== 'object'
    || (observation.kind !== 'git' && observation.kind !== 'workspace')
    || typeof observation.revision !== 'string'
    || observation.kind !== token.kind
    || typeof observation.identity !== 'object' || observation.identity === null
    || typeof observation.identity.repository !== 'string'
    || typeof observation.identity.worktree !== 'string'
    || observation.revision.trim() === ''
    || observation.identity.repository.trim() === ''
    || observation.identity.worktree.trim() === '') {
    return { trusted: false, blocker: blockerFor('capability-unavailable', request, token) }
  }
  let fresh: BuildRevisionToken
  try {
    fresh = createBuildRevisionToken(observation.kind, observation.revision, observation.identity)
  } catch {
    return { trusted: false, blocker: blockerFor('evaluation-error', request, token) }
  }
  if (fresh.repositoryHash !== token.repositoryHash) {
    return { trusted: false, blocker: blockerFor('project-mismatch', request, token) }
  }
  if (fresh.worktreeHash !== token.worktreeHash) {
    return { trusted: false, blocker: blockerFor('worktree-mismatch', request, token) }
  }
  if (fresh.revisionHash !== token.revisionHash) {
    return { trusted: false, blocker: blockerFor('revision-stale', request, token) }
  }

  if (!request.provenance) {
    return { trusted: false, blocker: blockerFor('provenance-missing', request, token) }
  }
  let provenance: BuildRevisionProvenance | undefined
  try {
    provenance = await request.provenance()
  } catch {
    return { trusted: false, blocker: blockerFor('provenance-mismatch', request, token) }
  }
  if (provenance === undefined) {
    return { trusted: false, blocker: blockerFor('provenance-missing', request, token) }
  }
  if (typeof provenance !== 'object'
    || typeof provenance.currentStep !== 'string'
    || (provenance.stateBuildSha !== undefined && typeof provenance.stateBuildSha !== 'string')
    || (provenance.stateHash !== undefined && typeof provenance.stateHash !== 'string')
    || typeof provenance.recordTo !== 'string'
    || !Array.isArray(provenance.buildShaEffects)
    || provenance.buildShaEffects.some((effect) => typeof effect !== 'string')) {
    return { trusted: false, blocker: blockerFor('provenance-mismatch', request, token) }
  }
  if (request.stateHash !== undefined && provenance.stateHash !== request.stateHash) {
    return { trusted: false, blocker: blockerFor('state-stale', request, token) }
  }
  const matchingEffects = provenance.buildShaEffects.filter((effect) => effect === token.value)
  if (provenance.currentStep !== (request.expectedStep ?? provenance.currentStep)
    || provenance.stateBuildSha !== token.value
    || provenance.recordTo !== provenance.currentStep
    || provenance.buildShaEffects.length !== 1
    || matchingEffects.length !== 1) {
    return { trusted: false, blocker: blockerFor('provenance-mismatch', request, token) }
  }
  return { trusted: true, token }
}

export function isBuildRevisionBlocker(value: unknown): value is BuildRevisionBlocker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.kind === 'verify-build-revision-untrusted'
    && candidate.code === BUILD_REVISION_CODE
    && typeof candidate.reason === 'string'
    && (BUILD_REVISION_REASONS as readonly string[]).includes(candidate.reason)
    && candidate.remediation === BUILD_REVISION_REMEDIATION
    && (candidate.stateHash === undefined || (typeof candidate.stateHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(candidate.stateHash)))
    && (candidate.revisionHash === undefined || (typeof candidate.revisionHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(candidate.revisionHash)))
}
