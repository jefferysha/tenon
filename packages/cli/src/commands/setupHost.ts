import { dirname, join, resolve } from 'node:path'
import { readAutomationJson } from '@tenon/automation'
import { PREREQ_HINTS } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { nodeExecDocker, probeAfkReadiness, type AfkReadiness, type CredLight, type ExecDockerFn } from '../afkReadiness.js'
import { REAL_RUNTIME_INSTALLER, type RuntimeInstaller } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { loadSkillSources, type SkillSource, type SkillSourcesResult, type SkillTier } from '../skillSources.js'
import {
  DEFAULT_DASHBOARD_PORT,
  type ReleasedDashboardStarter,
} from './dashboard.js'
import { REAL_RELEASED_DASHBOARD_STARTER } from './released-dashboard-starter.js'
import {
  hostFlag,
  isNativePipelineHost,
  nativeUpdatePlan,
  type ParsedHostPluginInventory,
  type PipelineHost,
  TENON_RELEASE_VERSION,
} from './plugin-host.js'
import { publishSetupManagedRuntime } from './setup-managed-runtime.js'
import { migrateLegacyProjectRegistry } from '../migration/legacy-project-registry.js'
import {
  readHostPluginConvergenceReceipt,
  recordPendingHostPluginConflict,
} from './host-plugin-convergence.js'

// ── 注入面（测试注入临时 HOME / spy;真实现 = node:fs + os.homedir）──────────────────

import {
  configureAutoUpdate,
  migrateLegacyCodexHooks,
  printCodexHookTrust,
  REAL_SETUP_ENV,
  resolvePipelineRoot,
  type SetupEnv,
  type SetupOpts,
} from './setupEnvironment.js'
import {
  bindNativeHostCommand,
  freezeTrustedLifecycleCommands,
} from './native-host-command-binding.js'
import type { StableReleaseTarget } from './stable-release.js'
import { verifyPackagedAssets } from './packaged-assets.js'
import { revalidateNativeStableCandidate } from './native-candidate-revalidation.js'
import { installNativePluginCandidate } from './native-plugin-candidate.js'
import { runUpstreamSkillInstall } from './upstream-skill-step.js'
import {
  inspectCandidatePayload,
  type CandidatePayloadIdentity,
} from '../runtime/release-store.js'
import { parseDashboardPort } from './dashboard-launch-options.js'
import {
  hostConvergenceHasNewerStableCandidate,
  recoverPendingHostConvergence,
} from './host-convergence-recovery.js'
export { verifyPackagedAssets } from './packaged-assets.js'

function commandText(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ')
}

/** Host-specific installation that keeps native marketplaces and non-native adapters separate. */
export function cmdSetupHost(
  deps: CliDeps,
  host: PipelineHost,
  opts: SetupOpts,
  env: SetupEnv = REAL_SETUP_ENV,
  installer: RuntimeInstaller = REAL_RUNTIME_INSTALLER,
  dashboardStarter?: ReleasedDashboardStarter,
  openDashboard = true,
  candidateInspector: (root: string) => Promise<CandidatePayloadIdentity> = inspectCandidatePayload,
): number | Promise<number> {
  if (opts.autoUpdate && !isNativePipelineHost(host)) {
    deps.io.err(`ERROR: ${hostFlag(host)} 是 adapter，自动更新由承载它的 Codex 或 Claude 插件负责；请改用 tenon setup --codex --auto-update 或 --claude --auto-update。`)
    return 1
  }

  if (opts.dryRun) {
    if (isNativePipelineHost(host)) {
      deps.io.out(`[setup] ${hostFlag(host)}:将安装本仓 marketplace 中的唯一 tenon 插件。`)
      const target: StableReleaseTarget = {
        version: TENON_RELEASE_VERSION,
        tag: `v${TENON_RELEASE_VERSION}`,
        commit: '0'.repeat(40),
      }
      deps.io.out('[setup] 仅在宿主状态不精确时，按以下条件 remove/rebind 计划收敛到正式标签：')
      for (const item of nativeUpdatePlan(host, target)) deps.io.out(`[setup] $ ${commandText(item.cmd, item.args)}`)
      deps.io.out('[setup] 将用宿主插件清单解析候选根，校验并原子发布 managed runtime；不会直连可变 checkout。')
      if (host === 'codex') deps.io.out('[setup] 安装后需在 Codex 输入 /hooks 并信任 tenon，正常对话路由才会启用。')
    } else {
      const root = resolvePipelineRoot(env)
      const assetCode = verifyPackagedAssets(deps, env, root, true)
      if (assetCode !== 0) return assetCode
      deps.io.out(`[setup] ${hostFlag(host)}:将运行打包 adapter → ${opts.target ?? deps.cwd}`)
    }
    if (opts.autoUpdate) deps.io.out(`[setup] 将启用 ${hostFlag(host)} 自动更新偏好。`)
    return 0
  }

  if (isNativePipelineHost(host)) {
    const hostBinding = env.resolveHostCommand(host)
    if (hostBinding === undefined) {
      deps.io.err(`ERROR: ${host} CLI 不在可信的绝对 PATH 项中；未执行宿主或 Tenon 状态变更。`)
      return 1
    }
    const trustedCommands = freezeTrustedLifecycleCommands(env)
    if (trustedCommands.missing.length > 0) {
      deps.io.err(
        `ERROR: ${trustedCommands.missing.join('/')} 不在可信的绝对 PATH 项中；`
        + '未执行宿主或 Tenon 状态变更。',
      )
      return 1
    }
    const lifecycleEnv = bindNativeHostCommand(env, host, hostBinding, trustedCommands)
    const trustedBash = trustedCommands.bashBinding
    const trustedNode = trustedCommands.nodeBinding
    const runtimeScope = {
      homeDir: lifecycleEnv.homeDir(),
      env: lifecycleEnv.runtimeEnv(),
      ...(trustedCommands.bash === undefined ? {} : { trustedBashPath: trustedCommands.bash }),
      ...(trustedBash === undefined ? {} : { verifyTrustedBash: trustedBash.assert }),
      ...(trustedCommands.node === undefined ? {} : { trustedNodePath: trustedCommands.node }),
      ...(trustedNode === undefined ? {} : { trustedNodeProof: trustedNode.proof, verifyTrustedNode: trustedNode.assert }),
    }
    const inspectCandidate = candidateInspector !== inspectCandidatePayload
      ? candidateInspector
      : lifecycleEnv.inspectCandidatePayload
        ?? ((root: string) => inspectCandidatePayload(root, {
          bashPath: trustedCommands.bash,
          ...(trustedBash === undefined ? {} : { verifyBash: trustedBash.assert }),
          nodePath: trustedCommands.node,
          ...(trustedNode === undefined ? {} : { verifyNode: trustedNode.assert }),
        }))
    return (async () => {
      const convergence = readHostPluginConvergenceReceipt(lifecycleEnv, host)
      if (convergence.state === 'invalid') {
        deps.io.err(`ERROR: ${convergence.detail}；未执行新的 marketplace/runtime 变更。`)
        return 1
      }
      if (convergence.state === 'receipt' && convergence.receipt.state === 'cleanup-pending') {
        const hostAhead = await hostConvergenceHasNewerStableCandidate(
          lifecycleEnv,
          installer,
          host,
          convergence.receipt,
          inspectCandidate,
        )
        if (hostAhead) {
          deps.io.out(
            '[setup] 宿主已由版本化 installer 绑定到比 pending receipt 更新的稳定候选；'
            + '保留旧登记并先发布新 managed runtime。',
          )
        } else {
          if (dashboardStarter === undefined) {
            deps.io.err('ERROR: 收敛 receipt 恢复缺少 Dashboard verifier；未报告 setup 成功。')
            return 1
          }
          const configuredPort = parseDashboardPort(lifecycleEnv.runtimeEnv().TENON_DASHBOARD_PORT)
          const recovered = await recoverPendingHostConvergence(
            deps,
            lifecycleEnv,
            installer,
            dashboardStarter,
            host,
            convergence.receipt,
            configuredPort ?? DEFAULT_DASHBOARD_PORT,
            inspectCandidate,
          )
          // waiting/completed 都是本次 setup 的完整动作；不要在同一调用继续刷新或再发布候选。
          return recovered ? 0 : 1
        }
      }

      const runtimeCode = await publishSetupManagedRuntime(
        deps,
        lifecycleEnv,
        installer,
        async (transaction) => {
          const candidate = await installNativePluginCandidate(deps, lifecycleEnv, host, transaction)
          if (candidate === null) throw new Error('宿主插件未能解析为可发布候选')
          await runUpstreamSkillInstall(deps, lifecycleEnv, installer, runtimeScope, host, candidate.root)
          // The upstream skill step can change a root that was verified earlier, so assets are always re-verified.
          const assetCode = verifyPackagedAssets(deps, lifecycleEnv, candidate.root, false)
          if (assetCode !== 0) throw new Error('宿主候选未通过插件资产校验')
          if (host === 'codex') {
            // Hook migration owns its own idempotent file transaction; it is not a host CLI
            // mutation and therefore must not masquerade as a host-inventory WAL checkpoint.
            const migrationCode = migrateLegacyCodexHooks(deps, lifecycleEnv)
            if (migrationCode !== 0) throw new Error('旧 Codex hook 迁移失败')
          }
          return {
            candidateRoot: candidate.root,
            evidence: candidate.inventoryRaw,
          }
        },
        host,
        dashboardStarter,
        openDashboard,
        async (activation, candidate, transactionId, frozenTarget) => {
          let inventory: ParsedHostPluginInventory
          try {
            if (frozenTarget === undefined) throw new Error('ready evidence 缺少冻结 stable target')
            inventory = revalidateNativeStableCandidate(
              deps,
              lifecycleEnv,
              host,
              frozenTarget,
              candidate.candidateRoot,
              (root) => verifyPackagedAssets(deps, lifecycleEnv, root, false, true) === 0,
            )
          } catch (error) {
            deps.io.err(
              `ERROR: ready evidence 前宿主候选重证失败：`
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            return false
          }
          const candidateIdentity = await inspectCandidate(candidate.candidateRoot)
          if (candidateIdentity.pluginVersion !== frozenTarget.version
            || candidateIdentity.payloadDigest !== activation.release.payloadDigest) {
            deps.io.err('ERROR: ready evidence 的宿主 candidate digest 与 active runtime 不一致。')
            return false
          }
          return recordPendingHostPluginConflict(
            deps,
            lifecycleEnv,
            host,
            inventory,
            activation,
            candidate.candidateRoot,
            transactionId,
            frozenTarget,
          )
        },
        (candidate, frozenTarget) => {
          if (frozenTarget === undefined) throw new Error('候选重证缺少冻结 stable target')
          revalidateNativeStableCandidate(
            deps,
            lifecycleEnv,
            host,
            frozenTarget,
            candidate.candidateRoot,
            (root) => verifyPackagedAssets(deps, lifecycleEnv, root, false, true) === 0,
          )
        },
      )
      if (runtimeCode !== 0) return runtimeCode
      const migrateProjectRegistry = lifecycleEnv.migrateProjectRegistry ?? migrateLegacyProjectRegistry
      const migrated = await migrateProjectRegistry({
        homeDir: lifecycleEnv.homeDir(),
        platform: process.platform,
        env: lifecycleEnv.runtimeEnv(),
        readText: lifecycleEnv.readText,
        pathExists: lifecycleEnv.pathExists,
      })
      if (migrated.discovered > 0 || migrated.rejected > 0) {
        deps.io.out(
          `[setup] 旧项目注册表迁移：发现 ${migrated.discovered}，新增 ${migrated.imported}，`
          + `拒绝 ${migrated.rejected}；后续只读取 Tenon 产品域。`,
        )
      }
      if (host === 'codex') printCodexHookTrust(deps)
      return configureAutoUpdate(deps, lifecycleEnv, host, opts.autoUpdate === true)
    })()
  } else {
    const root = resolvePipelineRoot(env)
    const assetCode = verifyPackagedAssets(deps, env, root, false)
    if (assetCode !== 0) return assetCode
    return publishSetupManagedRuntime(
      deps,
      env,
      installer,
      () => ({ candidateRoot: root }),
      host,
      dashboardStarter,
      openDashboard,
    ).then((runtimeCode) => {
      if (runtimeCode !== 0) return runtimeCode
      const adapter = join(root, 'adapters', 'install.sh')
      const args = [adapter, hostFlag(host), '--target', opts.target ?? deps.cwd, '--yes']
      deps.io.out(`[setup] $ bash ${args.join(' ')}`)
      const result = env.runCommand('bash', args)
      if (result.stdout.trim() !== '') deps.io.out(result.stdout.trimEnd())
      if (result.code !== 0) {
        deps.io.err(`ERROR: ${hostFlag(host)} adapter 安装失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
        return 1
      }
      return configureAutoUpdate(deps, env, host, opts.autoUpdate === true)
    })
  }
}

// ── 技能安装段（Phase 2 · S2）:读 registry → 分组命令 → 幂等差集 → 计划 → 逐条容错 → 汇总 ──────

/** 命令分组；Codex 安装面先行，同时保留 Claude Code 兼容安装。 */
