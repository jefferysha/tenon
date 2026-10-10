import type { ProductPaths } from '@tenon/kernel'

export type NativeRuntimeHost = 'codex' | 'claude'

export type RuntimePaths = ProductPaths

export interface TrustedPathProof {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly uid: number
  readonly size: number
}

export interface TrustedExecutableProof {
  readonly version: 1
  readonly platform: NodeJS.Platform
  readonly requestedPath: string
  readonly executable: TrustedPathProof
  readonly parents: readonly TrustedPathProof[]
  readonly sha256: string
}

export interface RuntimeReleaseSource {
  readonly host: NativeRuntimeHost | 'adapter' | 'manual'
  readonly pluginVersion: string
}

export interface RuntimeStableReleaseTarget {
  readonly version: string
  readonly tag: string
  readonly commit: string
}

/** 源码开发安装的身份：安装时冻结并写进 release manifest；漂移比较与展示都以它为准。 */
export interface RuntimeDevSource {
  readonly kind: 'dev'
  /** 仓库工作区根的 realpath；同时是托管 payload 的候选根。 */
  readonly repoRealpath: string
  readonly commit: string
  /** 安装时 PAYLOAD_ENTRIES 范围内是否有未提交改动；只用于展示。 */
  readonly dirty: boolean
  readonly worktreeDigest: string
  readonly skillsIndexDigest: string
}

export interface RuntimeReleaseManifestV1 {
  readonly version: 1
  readonly releaseId: string
  readonly payloadDigest: string
  readonly createdAt: string
  readonly source: RuntimeReleaseSource
}

export interface RuntimeReleaseManifestV2 {
  readonly version: 2
  readonly releaseId: string
  readonly payloadDigest: string
  readonly createdAt: string
  readonly source: RuntimeReleaseSource
  /** Immutable native provenance; absent only for low-level/manual/adapter activations. */
  readonly stableTarget?: RuntimeStableReleaseTarget
  /** 源码开发安装的身份；与 stableTarget 互斥，只允许原生宿主。 */
  readonly devSource?: RuntimeDevSource
}

export type RuntimeReleaseManifest = RuntimeReleaseManifestV1 | RuntimeReleaseManifestV2

export interface RuntimeSelection {
  readonly version: 1
  readonly revision: number
  readonly activeRelease: string | null
  readonly previousRelease: string | null
  readonly updatedAt: string
}

export interface RuntimeLauncherFileSnapshot {
  readonly path: string
  readonly state:
    | { readonly kind: 'missing' }
    | { readonly kind: 'file'; readonly content: string; readonly mode: number }
}

export interface RuntimeLauncherSnapshot {
  readonly tenon: RuntimeLauncherFileSnapshot
  readonly hook: RuntimeLauncherFileSnapshot
}

export interface RuntimeAuditEntry {
  readonly version: 1
  readonly at: string
  readonly kind:
    | 'activation-prepared'
    | 'activated'
    | 'activation-rejected'
    | 'rollback-prepared'
    | 'rolled-back'
    | 'rollback-rejected'
    | 'update-rejected'
    | 'pruned'
  readonly releaseId?: string
  readonly previousRelease?: string | null
  readonly detail: string
}

export interface RuntimeActivation {
  readonly selection: RuntimeSelection
  readonly release: RuntimeReleaseManifest
  readonly releaseRoot: string
  /** Exact pre-activation launcher state used by the installer-owned compensation transaction. */
  readonly launcherSnapshot?: RuntimeLauncherSnapshot
  /** Exact launcher state written by this activation; compensation uses it as a CAS ownership proof. */
  readonly launcherCommitted?: RuntimeLauncherSnapshot
  /** Selection committed, but the terminal audit append still requires durable recovery. */
  readonly auditPending?: true
}

export interface RuntimeInspection {
  readonly selection: RuntimeSelection
  readonly active: RuntimeReleaseManifest | null
  readonly previous: RuntimeReleaseManifest | null
  readonly activeValid: boolean
  readonly previousValid: boolean
  readonly lastAudit: RuntimeAuditEntry | null
  /** True when audit.jsonl is present but cannot be consumed as one complete append-only log. */
  readonly auditCorrupt?: boolean
  /** The latest prepared audit matches committed state but its terminal event could not be appended. */
  readonly auditPending?: boolean
}

export class RuntimeFailure extends Error {
  readonly code: 'candidate-invalid' | 'no-active-release' | 'no-recovery-release' | 'runtime-corrupt'

  constructor(code: RuntimeFailure['code'], message: string) {
    super(message)
    this.name = 'RuntimeFailure'
    this.code = code
  }
}
