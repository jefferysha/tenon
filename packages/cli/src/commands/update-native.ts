import { join } from 'node:path'
import { LEGACY_PLUGIN_IDENTITY } from '../migration/legacy-tenon-migration.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { expectedStableLaunchers } from '../runtime/launchers.js'
import { DEFAULT_DASHBOARD_PORT } from './dashboard.js'
import { parseDashboardPort } from './dashboard-launch-options.js'
import { recoverPendingHostConvergence } from './host-convergence-recovery.js'
import { readHostPluginConvergenceReceipt, recordPendingHostPluginConflict } from './host-plugin-convergence.js'
import { nativeHostMatchesStableTarget } from './managed-host-observation.js'
import { runManagedHostCommand } from './managed-host-command.js'
import { observeNativeStableTarget, revalidateNativeStableCandidate } from './native-candidate-revalidation.js'
import {
  hostFlag,
  nativeUpdatePlan,
  parseHostPluginInventory,
} from './plugin-host.js'
import { publishManagedRelease } from './release-coordinator.js'
import {
  compareStableVersions,
  resolveStableTagTarget,
  type StableReleaseTarget,
} from './stable-release.js'
import { boundaryDetail, reportHostBoundary, type HostBoundaryState } from './update-boundary-report.js'
import { verifyUpdatedRoot } from './update-candidate-verification.js'
import { rejectUpdate } from './update-failure.js'
import { reportSuccessfulNativeUpdate } from './update-success-report.js'
import { runUpstreamSkillInstall } from './upstream-skill-step.js'
import { isAlreadyInstalledResult, renderNativeUpdatePlan } from './update-native-plan.js'
import type { NativeUpdateInput } from './update-native-contract.js'
export { renderNativeUpdatePlan } from './update-native-plan.js'
export async function runNativeUpdate(input: NativeUpdateInput): Promise<number> {
  const {
    deps,
    env,
    installer,
    dashboardStarter,
    releaseResolver,
    inspectCandidate,
    host,
    hostExecutable,
    trustedBashPath,
    verifyTrustedBash,
    trustedNodePath,
    trustedNodeProof,
    verifyTrustedNode,
    auto,
  } = input
  const dashboardPort = parseDashboardPort(env.runtimeEnv().TENON_DASHBOARD_PORT)
  const readyPort = dashboardPort ?? DEFAULT_DASHBOARD_PORT
  const runtimeScope = {
    homeDir: env.homeDir(),
    env: env.runtimeEnv(),
    trustedBashPath,
    ...(verifyTrustedBash === undefined ? {} : { verifyTrustedBash }),
    ...(trustedNodePath === undefined ? {} : { trustedNodePath }),
    ...(trustedNodeProof === undefined ? {} : { trustedNodeProof }),
    ...(verifyTrustedNode === undefined ? {} : { verifyTrustedNode }),
  }
  let pendingManagedJournal = false
  let prefetchedTarget: StableReleaseTarget | undefined
  if (installer.peekManagedJournal !== undefined) {
    let existingJournal
    try {
      existingJournal = await installer.peekManagedJournal(runtimeScope)
    } catch (error) {
      deps.io.err(
        `ERROR: managed release journal 无法只读检查；未解析远端版本、未写 runtime 状态：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
    pendingManagedJournal = existingJournal !== null
    if (!pendingManagedJournal) {
      try {
        prefetchedTarget = await releaseResolver.resolve(env)
      } catch (error) {
        deps.io.err(
          `ERROR: stable Release 解析失败；未执行宿主变更，也未创建 runtime/audit 状态：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
        return 1
      }
    }
  }
  const convergence = readHostPluginConvergenceReceipt(env, host)
  if (convergence.state === 'invalid') {
    deps.io.err(`ERROR: ${convergence.detail}；未执行新的 marketplace/runtime 变更。`)
    return 1
  }
  if (convergence.state === 'receipt' && convergence.receipt.state === 'cleanup-pending'
    && !pendingManagedJournal) {
    const target = prefetchedTarget
    let receiptVersion = convergence.receipt.stableTarget?.version
    if (receiptVersion === undefined) {
      const runtime = await installer.inspect(runtimeScope)
      if (runtime.activeValid
        && runtime.active !== null
        && runtime.selection.activeRelease === convergence.receipt.releaseId
        && runtime.active.releaseId === convergence.receipt.releaseId
        && runtime.active.source.host === host) receiptVersion = runtime.active.source.pluginVersion
    }
    let comparison: number | undefined
    if (target !== undefined && receiptVersion !== undefined) {
      try {
        comparison = compareStableVersions(target.version, receiptVersion)
      } catch (error) {
        deps.io.err(
          `ERROR: cleanup-pending runtime 版本 ${receiptVersion} 无法比较；`
          + `未执行宿主或 runtime mutation：${error instanceof Error ? error.message : String(error)}`,
        )
        return 1
      }
    }
    if (comparison === undefined || comparison === 0) {
      const recovered = await recoverPendingHostConvergence(
        deps,
        env,
        installer,
        dashboardStarter,
        host,
        convergence.receipt,
        readyPort,
        inspectCandidate,
      )
      return recovered ? 0 : 1
    }
    if (target === undefined || receiptVersion === undefined) {
      deps.io.err('ERROR: cleanup-pending 版本比较缺少冻结 identity；未执行 mutation。')
      return 1
    }
    if (comparison < 0) {
      deps.io.err(
        `ERROR: cleanup-pending runtime ${receiptVersion} 高于 latest stable ${target.version}；`
        + '拒绝隐式降级，未执行宿主或 runtime mutation。',
      )
      return 1
    }
    deps.io.out(
      `[update] 检测到旧 ${receiptVersion} cleanup-pending；继续发布更高 stable ${target.version}，`
      + '新 ready evidence 将原子接管收敛 receipt。',
    )
  }

  let hostBoundary: HostBoundaryState = 'in-progress'
  const outcome = await publishManagedRelease(
    deps,
    {
      operation: 'update',
      source: host,
      requiresStableTarget: true,
      resolveStableTargetBeforeRecovery: () => prefetchedTarget === undefined
        ? releaseResolver.resolve(env)
        : Promise.resolve(prefetchedTarget),
      proveFrozenTarget: (frozen) => {
        const proven = resolveStableTagTarget(env, frozen.version)
        if (proven.tag !== frozen.tag || proven.commit !== frozen.commit) {
          throw new Error(
            `稳定标签 ${frozen.tag} 当前证明 ${proven.commit} 与冻结 commit ${frozen.commit} 不一致`,
          )
        }
      },
      runtime: runtimeScope,
      openBrowser: false,
      ...(dashboardPort === null ? {} : { dashboardPort }),
      prepareCandidate: async (transaction) => {
        const target = await transaction.resolveStableTarget(
          () => prefetchedTarget === undefined
            ? releaseResolver.resolve(env)
            : Promise.resolve(prefetchedTarget),
          (frozen) => {
            const proven = resolveStableTagTarget(env, frozen.version)
            if (proven.tag !== frozen.tag || proven.commit !== frozen.commit) {
              throw new Error(
                `稳定标签 ${frozen.tag} 当前证明 ${proven.commit} 与冻结 commit ${frozen.commit} 不一致`,
              )
            }
          },
        )
        deps.io.out(`[update] 已冻结稳定目标：${target.tag} @ ${target.commit}`)
        const beforeInventoryResult = env.runCommand(host, ['plugin', 'list', '--json'])
        const beforeInventory = beforeInventoryResult.code === 0
          ? parseHostPluginInventory(host, beforeInventoryResult.stdout)
          : null
        if (beforeInventory === null) {
          throw new Error(
            `更新前宿主 plugin inventory 无法验证：`
            + `${beforeInventoryResult.stderr.trim() || `退出码 ${beforeInventoryResult.code}`}`,
          )
        }
        const runtime = await installer.inspect(runtimeScope)
        for (const [label, version] of [
          ['宿主 plugin', beforeInventory.tenonVersion],
          ['active managed runtime', runtime.activeValid ? runtime.active?.source.pluginVersion ?? null : null],
        ] as const) {
          if (version === null) continue
          let comparison: number
          try {
            comparison = compareStableVersions(version, target.version)
          } catch (error) {
            throw new Error(`${label} 版本无法参与稳定版本比较：${error instanceof Error ? error.message : String(error)}`)
          }
          if (comparison > 0) throw new Error(`拒绝从${label} ${version} 降级到 ${target.version}`)
        }
        const hostExact = beforeInventory.tenonRoot !== null
          && beforeInventory.tenonVersion === target.version
          && nativeHostMatchesStableTarget(env, host, target)
        // An unchanged lock keeps the payload digest, so the exact-runtime check below still reports current.
        if (hostExact) await runUpstreamSkillInstall(deps, env, installer, runtimeScope, host, beforeInventory.tenonRoot)
        if (hostExact && verifyUpdatedRoot(deps, env, beforeInventory.tenonRoot, target.version)) {
          const candidateIdentity = await inspectCandidate(beforeInventory.tenonRoot)
          if (candidateIdentity.pluginVersion === target.version
            && nativeHostMatchesStableTarget(env, host, target)) {
            const active = runtime.active
            const runtimePaths = resolveRuntimePaths({ homeDir: env.homeDir(), env: env.runtimeEnv() })
            const runtimeExact = runtime.activeValid
              && active !== null
              && runtime.selection.activeRelease === active.releaseId
              && active.version === 2
              && active.source.host === host
              && active.source.pluginVersion === target.version
              && active.payloadDigest === candidateIdentity.payloadDigest
              && active.stableTarget?.version === target.version
              && active.stableTarget.tag === target.tag
              && active.stableTarget.commit === target.commit
            if (runtimeExact) {
              const dashboard = await dashboardStarter.inspect(deps, {
                port: dashboardPort ?? DEFAULT_DASHBOARD_PORT,
                openBrowser: false,
              })
              const currentActivation = {
                selection: runtime.selection,
                release: active,
                releaseRoot: join(runtimePaths.releasesRoot, active.releaseId),
                launcherCommitted: expectedStableLaunchers(
                  runtimePaths,
                  env.homeDir(),
                  trustedNodePath,
                  trustedNodeProof,
                ),
              }
              if (dashboard?.releaseId === active.releaseId
                && dashboard.serverVersion === target.version
                && !beforeInventory.enabledIds.has(LEGACY_PLUGIN_IDENTITY)) {
                return {
                  candidateRoot: beforeInventory.tenonRoot,
                  evidence: beforeInventoryResult.stdout,
                  currentActivation,
                  currentDashboardExact: true as const,
                }
              }
              return { candidateRoot: beforeInventory.tenonRoot, evidence: beforeInventoryResult.stdout, currentActivation }
            }
            return { candidateRoot: beforeInventory.tenonRoot, evidence: beforeInventoryResult.stdout }
          }
        }
        const plan = nativeUpdatePlan(host, target)
        renderNativeUpdatePlan(deps, host, plan)
        let inventory = ''
        for (let index = 0; index < plan.length; index += 1) {
          const item = plan.at(index)
          const stepId = ([
            'plugin-remove',
            'marketplace-remove',
            'marketplace-register',
            'plugin-install',
            'inventory-after',
          ] as const).at(index)
          if (item === undefined || stepId === undefined) {
            throw new Error('宿主更新计划与受管步骤不一致')
          }
          const result = await runManagedHostCommand(transaction, stepId, env, item, target)
          if (result.stdout.trim() !== '' && !auto) deps.io.out(result.stdout.trimEnd())
          if (result.code !== 0) {
            if (stepId === 'plugin-install' && isAlreadyInstalledResult(result)) {
              const inventoryItem = plan.at(-1)
              if (inventoryItem === undefined) throw new Error('宿主更新计划缺少 inventory 步骤')
              const inventoryResult = await runManagedHostCommand(
                transaction,
                'inventory-after',
                env,
                inventoryItem,
              )
              const parsedInventory = inventoryResult.code === 0
                ? parseHostPluginInventory(host, inventoryResult.stdout)
                : null
              if (parsedInventory?.tenonRoot !== null && parsedInventory?.tenonRoot !== undefined) {
                inventory = inventoryResult.stdout
                break
              }
            }
            throw new Error(
              `${item.cmd} ${item.args.join(' ')} 失败：${result.stderr.trim() || `退出码 ${result.code}`}`,
            )
          }
          inventory = result.stdout
        }
        const parsedInventory = parseHostPluginInventory(host, inventory)
        if (parsedInventory === null) {
          throw new Error(`${hostFlag(host)} 更新后的宿主插件清单响应畸形；未切换 launcher。`)
        }
        const root = parsedInventory.tenonRoot
        if (root === null) throw new Error(`${hostFlag(host)} 更新后未在宿主插件清单中找到 tenon；未切换 launcher。`)
        hostBoundary = 'committed'
        if (parsedInventory.tenonVersion !== target.version) {
          throw new Error(
            `${hostFlag(host)} 更新后插件版本 ${parsedInventory.tenonVersion ?? 'unknown'} `
            + `与目标稳定版本 ${target.version} 不一致；未切换 launcher。`,
          )
        }
        if (!observeNativeStableTarget(env, host, target, '更新后宿主目标 identity 无法验证')) {
          throw new Error('更新后 marketplace/tag commit 与插件 inventory 未收敛到同一冻结稳定版本')
        }
        await runUpstreamSkillInstall(deps, env, installer, runtimeScope, host, root)
        if (!verifyUpdatedRoot(deps, env, root, target.version)) {
          throw new Error('宿主刷新后的 tenon 候选未通过打包资产校验')
        }
        if (!nativeHostMatchesStableTarget(env, host, target)) {
          throw new Error('候选校验后 marketplace/tag commit 发生漂移；拒绝激活')
        }
        return { candidateRoot: root, evidence: inventory }
      },
      revalidateCandidate: (candidate, context) => {
        const target = context.stableTarget
        if (target === undefined) throw new Error('候选重证缺少冻结 stable target')
        revalidateNativeStableCandidate(
          deps,
          env,
          host,
          target,
          candidate.candidateRoot,
          (root) => verifyUpdatedRoot(deps, env, root, target.version),
        )
      },
      commitReadyEvidence: async (activation, candidate, transactionId, context) => {
        const target = context.stableTarget
        if (target === undefined) throw new Error('ready evidence 缺少冻结 stable target context')
        const parsedInventory = revalidateNativeStableCandidate(
          deps,
          env,
          host,
          target,
          candidate.candidateRoot,
          (root) => verifyUpdatedRoot(deps, env, root, target.version),
        )
        const candidateIdentity = await inspectCandidate(candidate.candidateRoot)
        if (candidateIdentity.pluginVersion !== target.version
          || candidateIdentity.payloadDigest !== activation.release.payloadDigest) {
          throw new Error('ready evidence 的宿主 candidate digest 与 active runtime 不一致')
        }
        if (!recordPendingHostPluginConflict(
          deps,
          env,
          host,
          parsedInventory,
          activation,
          candidate.candidateRoot,
          transactionId,
          target,
        )) throw new Error('宿主插件收敛 receipt 未能持久化')
      },
    },
    installer,
    dashboardStarter,
  )
  if (!outcome.ok) {
    deps.io.err(`ERROR: ${outcome.detail}`)
    reportHostBoundary(deps, host, hostBoundary)
    return rejectUpdate(deps, installer, env, boundaryDetail(hostBoundary, outcome.state, outcome.detail))
  }
  if (outcome.state === 'current') {
    const tag = outcome.stableTarget?.tag ?? 'latest stable'
    deps.io.out(`[update] ${tag} 已在宿主、managed runtime 与 Dashboard 精确生效；无需更新。`)
    deps.io.out(`[dashboard] 已就绪：http://127.0.0.1:${readyPort}/；如需打开：tenon dashboard --open`)
    return 0
  }
  return reportSuccessfulNativeUpdate(
    deps,
    env,
    host,
    hostExecutable,
    outcome.activation,
    readyPort,
    auto,
  )
}
