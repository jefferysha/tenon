import type { CliDeps } from '../deps.js'
import { printCodexAuthGuidance } from '../codexAuth.js'
import { REAL_RUNTIME_INSTALLER, type RuntimeInstaller } from '../runtime/installer.js'
import {
  inspectCandidatePayload,
  type CandidatePayloadIdentity,
} from '../runtime/release-store.js'
import { readInstallChannelMarker } from '../runtime/dev-install-marker.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import type { RuntimeReleaseManifest } from '../runtime/types.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import {
  bindNativeHostCommand,
  freezeTrustedLifecycleCommands,
} from './native-host-command-binding.js'
import {
  hostFlag,
  isNativePipelineHost,
  nativeUpdatePlan,
  selectPipelineHost,
  type PipelineHostFlags,
} from './plugin-host.js'
import { REAL_RELEASED_DASHBOARD_STARTER } from './released-dashboard-starter.js'
import { cmdSetupHost, REAL_SETUP_ENV, type SetupEnv } from './setup.js'
import {
  REAL_STABLE_RELEASE_RESOLVER,
  type StableReleaseResolver,
  type StableReleaseTarget,
} from './stable-release.js'
import { decideDevUpdate } from './update-dev-guard.js'
import { renderNativeUpdatePlan, runNativeUpdate } from './update-native.js'

export interface UpdateOpts extends PipelineHostFlags {
  dryRun?: boolean
  yes?: boolean
  auto?: boolean
  target?: string
  /** 开发安装（tenon setup --from-source）切回最新正式稳定版。 */
  toStable?: boolean
}

export { nativeUpdatePlan } from './plugin-host.js'

export function cmdUpdate(
  deps: CliDeps,
  opts: UpdateOpts,
  env: SetupEnv = REAL_SETUP_ENV,
  installer: RuntimeInstaller = REAL_RUNTIME_INSTALLER,
  dashboardStarter: ReleasedDashboardStarter = REAL_RELEASED_DASHBOARD_STARTER,
  releaseResolver: StableReleaseResolver = REAL_STABLE_RELEASE_RESOLVER,
  candidateInspector: (root: string) => Promise<CandidatePayloadIdentity> = inspectCandidatePayload,
): number | Promise<number> {
  const selection = selectPipelineHost(opts)
  if (selection.host === null) {
    deps.io.err(`ERROR: ${selection.error}。示例：tenon update --codex`)
    return 1
  }
  const host = selection.host
  if (!isNativePipelineHost(host)) {
    deps.io.out(`[update] ${hostFlag(host)} 没有独立 marketplace；从当前已更新的 Tenon 包重新部署 adapter。`)
    return cmdSetupHost(deps, host, { ...opts, autoUpdate: false }, env, installer, dashboardStarter, false)
  }
  if (opts.dryRun) {
    const previewTarget: StableReleaseTarget = {
      version: '<latest-stable>',
      tag: '<latest-stable>',
      commit: '0'.repeat(40),
    }
    renderNativeUpdatePlan(deps, host, nativeUpdatePlan(host, previewTarget))
    deps.io.out('[update] 执行时先只读解析并冻结官方 latest stable Release；dry-run 不联网。')
    deps.io.out('[update] --dry-run:未刷新 marketplace、未重装插件、未切换 launcher。')
    return 0
  }
  const hostBinding = env.resolveHostCommand(host)
  if (hostBinding === undefined) {
    if (host === 'codex') printCodexAuthGuidance(deps.io, { state: 'unavailable', reason: 'cli-missing' })
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
  const inspectCandidate = candidateInspector !== inspectCandidatePayload
    ? candidateInspector
    : lifecycleEnv.inspectCandidatePayload
      ?? ((root: string) => inspectCandidatePayload(root, {
        bashPath: trustedCommands.bash,
        ...(trustedBash === undefined ? {} : { verifyBash: trustedBash.assert }),
        nodePath: trustedCommands.node,
        ...(trustedNode === undefined ? {} : { verifyNode: trustedNode.assert }),
      }))
  const runtimeScope = {
    homeDir: lifecycleEnv.homeDir(),
    env: lifecycleEnv.runtimeEnv(),
    ...(trustedCommands.bash === undefined ? {} : { trustedBashPath: trustedCommands.bash }),
    ...(trustedBash === undefined ? {} : { verifyTrustedBash: trustedBash.assert }),
    ...(trustedCommands.node === undefined ? {} : { trustedNodePath: trustedCommands.node }),
    ...(trustedNode === undefined ? {} : {
      trustedNodeProof: trustedNode.proof,
      verifyTrustedNode: trustedNode.assert,
    }),
  }
  return (async () => {
    let active: RuntimeReleaseManifest | null = null
    let inspectFailed = false
    try {
      // 不看 activeValid：开发 release 校验失败时也不能被一次普通 update 悄悄换成正式版（fail-closed）。
      active = (await installer.inspect(runtimeScope)).active
    } catch {
      // runtime 状态读不出来：以本机 install-channel 标记为准——标记是 dev 就按开发安装拒绝，没有标记才走稳定路径。
      inspectFailed = true
    }
    const marker = readInstallChannelMarker(
      resolveRuntimePaths({ homeDir: runtimeScope.homeDir, env: runtimeScope.env }).configRoot,
    )
    const decision = decideDevUpdate(active, host, opts.toStable === true, { marker, inspectFailed })
    if (decision.action === 'refuse') {
      for (const line of decision.message) deps.io.err(line)
      return 1
    }
    return runNativeUpdate({
      deps,
      env: lifecycleEnv,
      installer,
      dashboardStarter,
      releaseResolver,
      inspectCandidate,
      host,
      hostExecutable: hostBinding.executable,
      trustedBashPath: trustedCommands.bash,
      verifyTrustedBash: trustedBash?.assert,
      trustedNodePath: trustedCommands.node,
      trustedNodeProof: trustedNode?.proof,
      verifyTrustedNode: trustedNode?.assert,
      auto: opts.auto === true,
      fromDev: decision.fromDev,
    })
  })()
}
