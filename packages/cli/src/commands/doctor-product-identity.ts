import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { machineStateScopeId } from '@tenon/kernel'
import type { DoctorCheck } from './doctor-check.js'
import { green, red, yellow } from './doctor-check.js'
import { TRANSIENT_REMOTE_FAILURE } from './remote-git.js'
import type { DoctorProbes, DoctorProductIdentity } from '../deps.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { RuntimeScopeSnapshot } from '../runtime/scope.js'
import { resolveCommandOnPath } from './commandExists.js'
import { probeHealthyDashboard } from './dashboard-health.js'
import { parseDashboardPort } from './dashboard-launch-options.js'
import { DEFAULT_DASHBOARD_PORT } from './dashboard.js'
import { TENON_RELEASE_VERSION } from './plugin-host.js'
import { nativeHostMatchesStableTarget } from './managed-host-observation.js'
import { decodeNativeHostObservation, observeNativeHost } from './managed-host-state.js'
import type { SetupEnv } from './setupEnvironment.js'
import { inspectCandidatePayload } from '../runtime/release-store.js'
import { resolveStableTagTarget } from './stable-release.js'
import {
  nativeHostCommandBinding,
  type NativeHostCommandBinding,
} from './native-host-command-binding.js'
import { freezeTrustedExecutable, type TrustedExecutable } from './trusted-executable.js'

interface DoctorProductIdentityProbeRuntime {
  resolveHostCommand(
    command: 'codex' | 'claude',
    scope: RuntimeScopeSnapshot,
  ): NativeHostCommandBinding | undefined
  resolveTrustedCommand(
    command: 'bash' | 'git' | 'node',
    scope: RuntimeScopeSnapshot,
  ): TrustedExecutable | undefined
  readText(path: string): string | undefined
  run(
    file: string,
    args: readonly string[],
    options?: { readonly cwd?: string; readonly timeoutMs?: number },
  ): { readonly code: number; readonly stdout: string; readonly stderr: string }
  inspectCandidate: typeof inspectCandidatePayload
  probeDashboard: typeof probeHealthyDashboard
}

const REAL_PRODUCT_IDENTITY_RUNTIME: DoctorProductIdentityProbeRuntime = {
  resolveTrustedCommand(command, scope) {
    const candidate = resolveCommandOnPath(command, {
      pathValue: scope.env.PATH,
      platform: process.platform,
      requireAbsolutePathEntries: true,
    })
    return candidate === undefined ? undefined : freezeTrustedExecutable(candidate)
  },
  resolveHostCommand(command, scope) {
    const candidate = resolveCommandOnPath(command, {
      pathValue: scope.env.PATH,
      platform: process.platform,
      requireAbsolutePathEntries: true,
    })
    if (candidate === undefined) return undefined
    const trusted = freezeTrustedExecutable(candidate)
    if (trusted === undefined) return undefined
    const interpreter = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(trusted.executable)
      ? freezeTrustedExecutable(
          scope.env.ComSpec && win32.isAbsolute(scope.env.ComSpec)
            ? scope.env.ComSpec
            : win32.join(scope.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        )
      : undefined
    return nativeHostCommandBinding(
      trusted.executable,
      process.platform,
      scope.env,
      trusted,
      interpreter,
    )
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  run(file, args, options) {
    const asText = (value: unknown): string => Buffer.isBuffer(value)
      ? value.toString('utf8')
      : typeof value === 'string' ? value : ''
    try {
      return {
        code: 0,
        stdout: execFileSync(file, [...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options?.timeoutMs ?? 5_000,
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
        stderr: '',
      }
    } catch (error) {
      const failed = error as { status?: unknown; stdout?: unknown; stderr?: unknown }
      return {
        code: typeof failed.status === 'number' ? failed.status : 1,
        stdout: asText(failed.stdout),
        stderr: asText(failed.stderr),
      }
    }
  },
  inspectCandidate: inspectCandidatePayload,
  probeDashboard: probeHealthyDashboard,
}

export async function checkProductIdentity(
  p: DoctorProbes,
  options: { readonly verifyRemote?: boolean } = {},
): Promise<DoctorCheck> {
  const verifyRemote = options.verifyRemote === true
  const identity = await p.productIdentity({ verifyRemote })
  if (identity.state === 'unavailable') {
    // 链路不通不是「装坏了」。以前无论断网、缺 tag 还是真漂移都劝用户重跑 setup/update，
    // 断网时那条建议只会让人白跑一次安装；现在按 cause 各给各的修法。
    return identity.cause === 'network'
      ? yellow('identity:release', `无法证明发布身份: ${identity.detail}`, identity.remediation)
      : red('identity:release', `无法证明发布身份: ${identity.detail}`, identity.remediation)
  }
  const exact = identity.hostPluginVersion === identity.expectedVersion
    && identity.runtimePluginVersion === identity.expectedVersion
    && identity.dashboardServerVersion === identity.expectedVersion
    && identity.dashboardReleaseId === identity.runtimeReleaseId
    && identity.hostTargetExact
    && identity.payloadDigestExact
  const targetScope = identity.remoteTargetVerified ? 'exact' : 'exact-local'
  const detail = [
    `expected=${identity.expectedVersion}`,
    `host=${identity.hostPluginVersion ?? 'missing'}`,
    `root=${identity.hostPluginRoot ?? 'missing'}`,
    `target=${identity.stableTargetTag}@${identity.stableTargetCommit.slice(0, 12)}:${identity.hostTargetExact ? targetScope : 'drift'}`,
    `payload=${identity.hostPayloadDigest?.slice(0, 12) ?? 'missing'}/${identity.runtimePayloadDigest.slice(0, 12)}:${identity.payloadDigestExact ? 'exact' : 'drift'}`,
    `runtime=${identity.runtimePluginVersion}`,
    `dashboard=${identity.dashboardServerVersion ?? 'missing'}`,
    `release=${identity.dashboardReleaseId ?? 'missing'}/${identity.runtimeReleaseId}`,
  ].join('; ')
  return exact
    ? green(
        'identity:release',
        identity.remoteTargetVerified
          ? `${identity.host} 发布身份一致（${detail}）`
          : `${identity.host} 发布身份本地一致（${detail}）；本次未联网复核冻结 tag，需要时跑 tenon doctor --verify-release`,
      )
    : red(
        'identity:release',
        `发布身份漂移（${detail}）`,
        `运行 tenon update --${identity.host}，不要从 main 或源码目录直接启动`,
      )
}

/** 本机前提不满足（可信命令缺失、runtime 清单不完整）：与联网失败分开报。 */
function unavailableLocal(detail: string): DoctorProductIdentity {
  return {
    state: 'unavailable',
    cause: 'local',
    detail,
    remediation: '重新运行 tenon setup --<host> 或 tenon update，使宿主、runtime 与 Dashboard 收敛到同一发布版本',
  }
}

/** 探针失败的分因归类：文案与修法都由此决定，不再一句话盖住所有原因。 */
function classifyProbeFailure(error: unknown): {
  readonly cause: 'network' | 'missing-tag' | 'mismatch' | 'local'
  readonly detail: string
  readonly remediation: string
} {
  const message = error instanceof Error ? error.message : String(error)
  if (TRANSIENT_REMOTE_FAILURE.test(message) || /timed out|timeout|ETIMEDOUT/iu.test(message)) {
    return {
      cause: 'network',
      detail: `联网复核冻结发布 tag 失败（远端不可达或超时）：${message}`,
      remediation: '这是链路问题，不是安装问题：本地检查用 tenon doctor（不联网）即可；网络恢复后再跑 tenon doctor --verify-release 复核',
    }
  }
  if (/proof is missing|is not complete stable SemVer|does not resolve to a commit|final object is not a commit/u.test(message)) {
    return {
      cause: 'missing-tag',
      detail: `远端没有可用的冻结发布 tag：${message}`,
      remediation: '远端缺少这条 release tag；确认要装的版本仍在 GitHub Releases 上，再运行 tenon update --<host>',
    }
  }
  if (/does not match|is ambiguous|unexpected ref|is malformed|does not belong/u.test(message)) {
    return {
      cause: 'mismatch',
      detail: `冻结发布身份与远端不一致：${message}`,
      remediation: '本机记录的 tag/commit 与远端广告的不符；不要继续从当前 runtime 启动，运行 tenon update --<host> 重新收敛',
    }
  }
  return {
    cause: 'local',
    detail: message,
    remediation: '重新运行 tenon setup --<host> 或 tenon update，使宿主、runtime 与 Dashboard 收敛到同一发布版本',
  }
}

export function createDoctorProductIdentityProbe(
  runtimeScope: () => RuntimeScopeSnapshot,
  installer: RuntimeInstaller,
  runtime: DoctorProductIdentityProbeRuntime = REAL_PRODUCT_IDENTITY_RUNTIME,
): (options?: { readonly verifyRemote?: boolean }) => Promise<DoctorProductIdentity> {
  return async (options = {}) => {
    const verifyRemote = options.verifyRemote === true
    const scope = runtimeScope()
    try {
      const trustedBash = runtime.resolveTrustedCommand('bash', scope)
      const trustedGit = runtime.resolveTrustedCommand('git', scope)
      const trustedNode = runtime.resolveTrustedCommand('node', scope)
      if (trustedBash === undefined) return unavailableLocal('可信 Bash 不可执行')
      if (trustedGit === undefined) return unavailableLocal('可信 Git 不可执行')
      if (trustedNode === undefined) return unavailableLocal('可信 Node 不可执行')
      const inspection = await installer.inspect({
        homeDir: scope.homeDir,
        env: scope.env,
        trustedBashPath: trustedBash.executable,
        verifyTrustedBash: trustedBash.assert,
        trustedNodePath: trustedNode.executable,
        trustedNodeProof: trustedNode.proof,
        verifyTrustedNode: trustedNode.assert,
      })
      const active = inspection.activeValid ? inspection.active : null
      const host = active?.source.host
      if (active === null || (host !== 'codex' && host !== 'claude')) {
        return unavailableLocal('没有可验证的 native managed runtime')
      }
      if (active.version !== 2 || active.stableTarget === undefined) {
        return unavailableLocal('active runtime manifest 缺少持久化 stable tag/commit 证明')
      }
      const hostBinding = runtime.resolveHostCommand(host, scope)
      if (hostBinding === undefined) return unavailableLocal(`${host} 宿主不可执行`)
      const diagnosticEnv = {
        homeDir: () => scope.homeDir,
        runtimeEnv: () => scope.env,
        readText: (path: string) => runtime.readText(path),
        runCommand: (
          command: string,
          args: string[],
          options?: { readonly cwd?: string; readonly timeoutMs?: number },
        ) => {
          if (command === host) {
            const invocation = hostBinding.invocation(args)
            return invocation === undefined
              ? { code: 127, stdout: '', stderr: 'trusted host identity drifted' }
              : runtime.run(invocation.file, invocation.args, {
                  ...options,
                  ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
                })
          }
          if (command !== 'git') return { code: 127, stdout: '', stderr: 'untrusted command' }
          try {
            trustedGit.assert()
          } catch {
            return { code: 127, stdout: '', stderr: 'trusted git identity drifted' }
          }
          return runtime.run(trustedGit.executable, args, options)
        },
      } as SetupEnv
      const observation = decodeNativeHostObservation(observeNativeHost(diagnosticEnv, host))
      const hostTargetExactBeforePayload = nativeHostMatchesStableTarget(
        diagnosticEnv,
        host,
        active.stableTarget,
      )
      const candidateRoot = observation.plugin?.root
      const candidate = candidateRoot === undefined
        ? null
        : await (async () => {
            trustedBash.assert()
            trustedNode.assert()
            return runtime.inspectCandidate(candidateRoot, {
              bashPath: trustedBash.executable,
              verifyBash: trustedBash.assert,
              nodePath: trustedNode.executable,
              verifyNode: trustedNode.assert,
            })
          })()
      const hostTargetExactAfterPayload = nativeHostMatchesStableTarget(
        diagnosticEnv,
        host,
        active.stableTarget,
      )
      // 联网复核只在 --verify-release 时做。冻结的 tag/commit 是安装时就落盘的证明，本地一致性
      // （宿主 marketplace/plugin/payload 与它逐项相等）无需联网即可判定；为此在每次本地健康检查里
      // 打两趟远端 git（ls-remote + 浅 fetch，各 3 次重试 × 60 s 预算）是把 update 的职责搬进了
      // doctor——慢链路上能跑到十几分钟，而它回答的并不是「本机此刻是否健康」。
      const remoteTargetExact = verifyRemote
        ? (() => {
            const provenTarget = resolveStableTagTarget(diagnosticEnv, active.stableTarget.version)
            return provenTarget.tag === active.stableTarget.tag
              && provenTarget.commit === active.stableTarget.commit
          })()
        : true
      const hostTargetExact = hostTargetExactBeforePayload
        && hostTargetExactAfterPayload
        && remoteTargetExact
      const payloadDigestExact = candidate !== null
        && candidate.pluginVersion === active.stableTarget.version
        && candidate.payloadDigest === active.payloadDigest
      const port = parseDashboardPort(scope.env.TENON_DASHBOARD_PORT) ?? DEFAULT_DASHBOARD_PORT
      const dashboard = await runtime.probeDashboard(
        port,
        active.releaseId,
        machineStateScopeId(scope.paths.stateRoot),
        { observeAnyTransaction: true },
      )
      return {
        state: 'native',
        expectedVersion: TENON_RELEASE_VERSION,
        host,
        hostPluginVersion: observation.plugin?.version ?? null,
        hostPluginRoot: observation.plugin?.root ?? null,
        stableTargetTag: active.stableTarget.tag,
        stableTargetCommit: active.stableTarget.commit,
        hostTargetExact,
        remoteTargetVerified: verifyRemote,
        hostPayloadDigest: candidate?.payloadDigest ?? null,
        runtimePluginVersion: active.source.pluginVersion,
        runtimeReleaseId: active.releaseId,
        runtimePayloadDigest: active.payloadDigest,
        payloadDigestExact,
        dashboardServerVersion: dashboard?.serverVersion ?? null,
        dashboardReleaseId: dashboard?.releaseId ?? null,
      }
    } catch (error) {
      return { state: 'unavailable', ...classifyProbeFailure(error) }
    }
  }
}
