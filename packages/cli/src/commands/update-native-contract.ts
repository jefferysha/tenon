import type { CliDeps } from '../deps.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { CandidatePayloadIdentity } from '../runtime/release-store.js'
import type { TrustedExecutableProof } from '../runtime/types.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import type { NativePipelineHost } from './plugin-host.js'
import type { SetupEnv } from './setup.js'
import type { StableReleaseResolver } from './stable-release.js'

export interface NativeUpdateInput {
  readonly deps: CliDeps
  readonly env: SetupEnv
  readonly installer: RuntimeInstaller
  readonly dashboardStarter: ReleasedDashboardStarter
  readonly releaseResolver: StableReleaseResolver
  readonly inspectCandidate: (root: string) => Promise<CandidatePayloadIdentity>
  readonly host: NativePipelineHost
  readonly hostExecutable: string
  readonly trustedBashPath: string | undefined
  readonly verifyTrustedBash: (() => void) | undefined
  readonly trustedNodePath: string | undefined
  readonly trustedNodeProof?: TrustedExecutableProof
  readonly verifyTrustedNode: (() => void) | undefined
  readonly auto: boolean
  /** 从开发安装经 --to-stable 切回：开发版本号可能高于最新正式版，跳过「拒绝降级」。 */
  readonly fromDev?: boolean
}
