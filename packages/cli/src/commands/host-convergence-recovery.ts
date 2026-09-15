import type { CliDeps } from '../deps.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import {
  inspectCandidatePayload,
  type CandidatePayloadIdentity,
} from '../runtime/release-store.js'
import type { CandidatePayloadValidationOptions } from '../runtime/release-payload.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import {
  finalizePendingHostPluginConflictWithinTransaction,
  type HostPluginConvergenceReceipt,
} from './host-plugin-convergence.js'
import { writeHostPluginConvergenceReceipt } from './host-plugin-convergence-receipt.js'
import { nativeHostMatchesStableTarget } from './managed-host-observation.js'
import { decodeNativeHostObservation, observeNativeHost } from './managed-host-state.js'
import type { NativePipelineHost } from './plugin-host.js'
import type { SetupEnv } from './setupEnvironment.js'
import { compareReleaseOrder, resolveStableTagTarget, type StableReleaseTarget } from './stable-release.js'
import {
  nativeCandidateValidationOptions,
  nativeRuntimeInstallerScope,
} from './native-runtime-installer-scope.js'

interface ProvenConvergenceIdentity {
  readonly target: StableReleaseTarget
}

type CandidateInspector = (
  root: string,
  options?: CandidatePayloadValidationOptions,
) => Promise<CandidatePayloadIdentity>

async function proveConvergenceIdentity(
  deps: CliDeps,
  env: SetupEnv,
  installer: RuntimeInstaller,
  dashboardStarter: ReleasedDashboardStarter,
  host: NativePipelineHost,
  receipt: HostPluginConvergenceReceipt,
  dashboardPort: number,
  candidateInspector: CandidateInspector,
): Promise<ProvenConvergenceIdentity> {
  const runtime = await installer.inspect(nativeRuntimeInstallerScope(env))
  const active = runtime.active
  if (!runtime.activeValid
    || active === null
    || runtime.selection.activeRelease !== receipt.releaseId
    || active.releaseId !== receipt.releaseId) {
    throw new Error('active managed runtime 与 receipt 不一致')
  }
  const target = receipt.stableTarget ?? resolveStableTagTarget(env, active.source.pluginVersion)
  if (active.source.host !== host || active.source.pluginVersion !== target.version) {
    throw new Error('active managed runtime 的 host/version 与 receipt 稳定目标不一致')
  }
  if (active.version === 2
    && (active.stableTarget === undefined
      || active.stableTarget.version !== target.version
      || active.stableTarget.tag !== target.tag
      || active.stableTarget.commit !== target.commit)) {
    throw new Error('active managed runtime stable target 与 convergence receipt 不一致')
  }
  const proven = resolveStableTagTarget(env, target.version)
  if (proven.tag !== target.tag || proven.commit !== target.commit) {
    throw new Error(`稳定标签 ${target.tag} 已从 ${target.commit} 漂移到 ${proven.commit}`)
  }
  if (!nativeHostMatchesStableTarget(env, host, target)) {
    throw new Error('marketplace ref/HEAD/clean 或 plugin root/version 未收敛到 receipt 稳定目标')
  }
  const observation = decodeNativeHostObservation(observeNativeHost(env, host))
  if (observation.plugin === null) throw new Error('宿主 inventory 缺少 Tenon plugin root')
  const candidate = await candidateInspector(
    observation.plugin.root,
    nativeCandidateValidationOptions(env),
  )
  if (candidate.pluginVersion !== target.version || candidate.payloadDigest !== active.payloadDigest) {
    throw new Error('宿主 plugin payload 与 active managed runtime digest 不一致')
  }
  const dashboard = await dashboardStarter.inspect(deps, { port: dashboardPort, openBrowser: false })
  if (dashboard === null
    || dashboard.port !== dashboardPort
    || dashboard.releaseId !== receipt.releaseId
    || dashboard.serverVersion !== active.source.pluginVersion) {
    throw new Error('Dashboard 未与 active managed runtime 精确一致')
  }
  return { target }
}

/** A versioned installer may have proven a newer host before the old receipt can be superseded. */
export async function hostConvergenceHasNewerStableCandidate(
  env: SetupEnv,
  installer: RuntimeInstaller,
  host: NativePipelineHost,
  receipt: HostPluginConvergenceReceipt,
  candidateInspector: CandidateInspector = inspectCandidatePayload,
): Promise<boolean> {
  try {
    const runtime = await installer.inspect(nativeRuntimeInstallerScope(env))
    const active = runtime.active
    if (!runtime.activeValid
      || active === null
      || runtime.selection.activeRelease !== receipt.releaseId
      || active.releaseId !== receipt.releaseId
      || active.source.host !== host) return false
    const observation = decodeNativeHostObservation(observeNativeHost(env, host))
    if (observation.plugin === null
      || compareReleaseOrder(observation.plugin.version, active.source.pluginVersion) <= 0) return false
    const target = resolveStableTagTarget(env, observation.plugin.version)
    if (!nativeHostMatchesStableTarget(env, host, target)) return false
    const candidate = await candidateInspector(
      observation.plugin.root,
      nativeCandidateValidationOptions(env),
    )
    return candidate.pluginVersion === target.version
  } catch {
    return false
  }
}

/** Recovery success requires host, payload, runtime, and Dashboard to prove one immutable release. */
export async function recoverPendingHostConvergence(
  deps: CliDeps,
  env: SetupEnv,
  installer: RuntimeInstaller,
  dashboardStarter: ReleasedDashboardStarter,
  host: NativePipelineHost,
  receipt: HostPluginConvergenceReceipt,
  dashboardPort: number,
  candidateInspector: CandidateInspector = inspectCandidatePayload,
): Promise<boolean> {
  try {
    return await installer.withManagedTransaction(
      nativeRuntimeInstallerScope(env),
      async () => {
        let upgradedReceipt = receipt
        try {
          const proven = await proveConvergenceIdentity(
            deps, env, installer, dashboardStarter, host, receipt, dashboardPort, candidateInspector,
          )
          if (receipt.stableTarget === undefined) {
            upgradedReceipt = { ...receipt, stableTarget: proven.target }
            if (!writeHostPluginConvergenceReceipt(deps, env, upgradedReceipt)) {
              throw new Error('legacy receipt 无法在 cleanup 前升级为带 stable target 的 v4')
            }
          }
        } catch (error) {
          deps.io.err(
            `ERROR: 收敛 cleanup 前完整 identity 无法重新证明：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
          return false
        }
        const finalized = await finalizePendingHostPluginConflictWithinTransaction(
          deps, env, installer, host, upgradedReceipt,
        )
        if (finalized.state === 'failed') {
          deps.io.err(`ERROR: 冲突插件官方清理失败：${finalized.detail}`)
          return false
        }
        try {
          await proveConvergenceIdentity(
            deps, env, installer, dashboardStarter, host, upgradedReceipt, dashboardPort, candidateInspector,
          )
        } catch (error) {
          deps.io.err(
            `ERROR: 收敛 cleanup 后完整 identity 无法重新证明：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
          return false
        }
        if (finalized.state === 'cleaned') {
          const completed: HostPluginConvergenceReceipt = {
            ...upgradedReceipt,
            state: 'completed',
            conflictScopes: [],
            updatedAt: deps.clock(),
          }
          if (!writeHostPluginConvergenceReceipt(deps, env, completed)) {
            deps.io.err('ERROR: 宿主已清理并复证，但 completed receipt 持久化失败；保留 pending receipt 供重试。')
            return false
          }
          deps.io.out('[setup] 宿主插件 inventory 已收敛为唯一 Tenon 工作流身份。')
        }
        deps.io.out(
          `[dashboard] 已就绪：http://127.0.0.1:${dashboardPort}/；`
          + '如需打开：tenon dashboard --open',
        )
        return true
      }
    )
  } catch (error) {
    deps.io.err(
      `ERROR: 宿主收敛事务锁定失败：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}
