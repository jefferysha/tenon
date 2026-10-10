import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { errMsg, type CliDeps } from '../deps.js'
import { removeInstallChannelMarker, writeInstallChannelMarker } from '../runtime/dev-install-marker.js'
import {
  compareDevSource, computeDevSourceIdentity, devSourceEquals, devVersionLabel, resolveSourceRepo,
  type SourceRepoResolution,
} from '../runtime/dev-source-identity.js'
import type { RuntimeInstaller, RuntimeInstallerScope } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { releaseCandidateVersion } from '../runtime/release-payload.js'
import type { RuntimeActivation, RuntimeDevSource } from '../runtime/types.js'
import {
  ensureUpstreamSkillsForSource, upstreamSkillIds, type EnsureUpstreamSkillsOutcome,
} from '../upstream-skills/ensure.js'
import { parseDashboardPort } from './dashboard-launch-options.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import {
  decodeDevObservation, devHostMatches, devHostPlan, devHostReconciliation, observeDevNativeHost,
} from './dev-host.js'
import { readHostPluginConvergenceReceipt } from './host-plugin-convergence.js'
import { runManagedHostCommand } from './managed-host-command.js'
import { nativeHostConvergenceSequence } from './native-host-convergence-sequence.js'
import { verifyPackagedAssets } from './packaged-assets.js'
import {
  hostFlag, isNativePipelineHost, parseHostPluginInventory,
  type NativePipelineHost, type PipelineHost,
} from './plugin-host.js'
import {
  publishManagedRelease,
  type ManagedHostPreparationContext, type ManagedReleaseOutcome, type ManagedReleaseRequest,
} from './release-coordinator.js'
import { disableAutoUpdateForDev, printCodexHookTrust, type SetupEnv } from './setupEnvironment.js'

export interface SourceInstallPorts {
  readonly resolveRepo: (input: string) => SourceRepoResolution
  readonly ensureSkills: (repo: string) => Promise<EnsureUpstreamSkillsOutcome>
  readonly build: (repo: string) => { readonly code: number; readonly detail: string }
  readonly identity: (repo: string) => RuntimeDevSource
  readonly pluginVersion: (repo: string) => Promise<string>
  readonly publish: (request: ManagedReleaseRequest) => Promise<ManagedReleaseOutcome>
}

export interface SourceInstallInput {
  readonly deps: CliDeps
  readonly host: NativePipelineHost
  readonly repoInput: string
  readonly skipBuild: boolean
  /** 已绑定可信宿主命令的生命周期 env（cmdSetupHost 里的 lifecycleEnv）。 */
  readonly env: SetupEnv
  readonly runtimeScope: RuntimeInstallerScope
  readonly openBrowser: boolean
}

function commandText(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ')
}

/** `--from-source` 的选项组合校验；返回错误文案或 null。 */
export function validateFromSourceOptions(
  host: PipelineHost,
  opts: { readonly fromSource?: string; readonly skipBuild?: boolean; readonly autoUpdate?: boolean },
): string | null {
  if (opts.fromSource === undefined) {
    return opts.skipBuild === true ? '--skip-build 只能与 --from-source 同用' : null
  }
  if (!isNativePipelineHost(host)) {
    return `--from-source 只能与 --claude 或 --codex 之一同用（${hostFlag(host)} 是 adapter）`
  }
  if (opts.autoUpdate === true) return '开发安装不参与自动更新；--from-source 不能与 --auto-update 同用'
  if (opts.fromSource.trim() === '') return '--from-source 需要一个 Tenon 源码仓库路径'
  return null
}

/** `tenon setup --claude --from-source <repo> --dry-run`：只读，打印计划。 */
export function describeSourceInstallPlan(
  deps: CliDeps,
  host: NativePipelineHost,
  repoInput: string,
  skipBuild: boolean,
  ports: Pick<SourceInstallPorts, 'resolveRepo' | 'identity'> = {
    resolveRepo: (input) => resolveSourceRepo(input),
    identity: (repo) => computeDevSourceIdentity(repo),
  },
): number {
  const resolved = ports.resolveRepo(repoInput)
  if (!resolved.ok) {
    deps.io.err(`ERROR: ${resolved.reason}`)
    return 1
  }
  const repo = resolved.repo
  let identity: RuntimeDevSource
  try {
    identity = ports.identity(repo)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  deps.io.out(`[setup] ${hostFlag(host)} 源码开发安装（--dry-run：不拉取、不构建、不改宿主、不写 runtime）：`)
  deps.io.out(
    `[setup] 仓库 ${repo}；当前身份 commit ${identity.commit.slice(0, 7)}、`
    + `${identity.dirty ? '工作区有未提交改动' : '工作区干净'}、`
    + `worktree ${identity.worktreeDigest.slice(0, 7)}、skills-index ${identity.skillsIndexDigest.slice(0, 7)}`,
  )
  deps.io.out('[setup] 1. 缺上游技能或缺 skills/skills.lock.json 时按 skills/sources.yaml 获取；失败整体中止，不改宿主')
  deps.io.out(skipBuild
    ? '[setup] 2. 已按 --skip-build 跳过构建'
    : `[setup] 2. 构建：npm --prefix ${repo} run build`)
  deps.io.out('[setup] 3. 移除既有 tenon 登记，再把该目录登记为 marketplace 并安装：')
  for (const item of devHostPlan(host, repo)) deps.io.out(`[setup] $ ${commandText(item.cmd, item.args)}`)
  deps.io.out('[setup] 4. 以仓库工作区为候选根校验并原子发布 managed runtime（release 记录 channel=dev、commit、dirty、worktreeDigest、skillsIndexDigest）')
  deps.io.out(`[setup] 5. 写入 install-channel 标记并关闭 auto-update；之后 tenon update 默认拒绝，切回正式版：tenon update ${hostFlag(host)} --to-stable`)
  return 0
}

export function createSourceInstallPorts(context: {
  readonly deps: CliDeps
  readonly env: SetupEnv
  readonly installer: RuntimeInstaller
  readonly dashboardStarter: ReleasedDashboardStarter | undefined
}): SourceInstallPorts {
  const { deps, env } = context
  const paths = resolveRuntimePaths({ homeDir: env.homeDir(), env: env.runtimeEnv() })
  return {
    resolveRepo: (input) => resolveSourceRepo(input),
    ensureSkills: (repo) => ensureUpstreamSkillsForSource({
      repo,
      env,
      workRoot: paths.stagingRoot,
      stateRoot: paths.stateRoot,
      now: () => new Date().toISOString(),
      log: (line) => deps.io.out(line),
      ...(env.installUpstreamSkills === undefined ? {} : { install: env.installUpstreamSkills }),
    }),
    // 构建输出直接流到终端（几分钟的 tsc / vite 不该被缓冲吞掉），退出码是唯一的判据。
    build: (repo) => {
      const result = spawnSync('npm', ['--prefix', repo, 'run', 'build'], { stdio: 'inherit' })
      return { code: result.status ?? 1, detail: result.error === undefined ? '' : errMsg(result.error) }
    },
    identity: (repo) => computeDevSourceIdentity(repo),
    pluginVersion: (repo) => releaseCandidateVersion(repo),
    publish: (request) => publishManagedRelease(deps, request, context.installer, context.dashboardStarter),
  }
}

/** 正式安装 / 切回正式版成功之后清掉开发标记，让 hook 与 auto-update.sh 回到正式版行为。 */
export function clearDevInstallMarker(env: Pick<SetupEnv, 'homeDir' | 'runtimeEnv'>): void {
  removeInstallChannelMarker(resolveRuntimePaths({ homeDir: env.homeDir(), env: env.runtimeEnv() }).configRoot)
}

interface DevCandidateContext {
  readonly deps: CliDeps
  readonly env: SetupEnv
  readonly host: NativePipelineHost
  readonly repo: string
  readonly version: string
}

/**
 * 宿主加载根必须带着 sources.yaml 里的全部上游技能；宿主 CLI 是自己缓存的唯一 writer，
 * Tenon 不去改它，缺就中止（Task 1 实测两个宿主都会复制被忽略的文件）。
 */
function assertHostHasUpstreamSkills(env: SetupEnv, repo: string, hostRoot: string): void {
  if (hostRoot === repo) return
  const missing = upstreamSkillIds(repo).filter((id) => !env.pathExists(join(hostRoot, 'skills', id, 'SKILL.md')))
  if (missing.length > 0) {
    throw new Error(
      `宿主加载根 ${hostRoot} 缺少上游技能 ${missing.slice(0, 5).join('、')}`
      + `${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}；宿主没有复制被 git 忽略的文件`,
    )
  }
}

async function prepareDevCandidate(
  ctx: DevCandidateContext,
  transaction: ManagedHostPreparationContext,
): Promise<{ readonly candidateRoot: string; readonly evidence: string }> {
  const { deps, env, host, repo, version } = ctx
  const plan = devHostPlan(host, repo)
  const listItem = plan.at(-1)
  if (listItem === undefined) throw new Error('开发安装宿主计划缺少 inventory 命令')
  const before = await runManagedHostCommand(transaction, 'inventory-before', env, listItem)
  if (before.code !== 0) {
    throw new Error(`宿主 plugin inventory 读取失败：${before.stderr.trim() || before.stdout.trim() || `退出码 ${before.code}`}`)
  }
  const parsedBefore = parseHostPluginInventory(host, before.stdout)
  if (parsedBefore === null) throw new Error('宿主 plugin inventory 响应畸形')
  const steps = nativeHostConvergenceSequence(plan, { plugin: parsedBefore.tenonRegistered })
  let inventory = ''
  for (const step of steps) {
    deps.io.out(`[setup] $ ${commandText(step.item.cmd, step.item.args)}`)
    const result = await runManagedHostCommand(transaction, step.id, env, step.item)
    if (step.id === 'inventory-after') {
      if (result.code !== 0) throw new Error(`宿主 plugin inventory 读取失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
      inventory = result.stdout
    }
  }
  const parsed = parseHostPluginInventory(host, inventory)
  if (parsed === null || parsed.tenonRoot === null) throw new Error(`${hostFlag(host)} 插件清单中没有启用的 tenon`)
  if (parsed.tenonVersion !== version) {
    throw new Error(`${hostFlag(host)} 插件版本 ${parsed.tenonVersion ?? 'unknown'} 不等于源码仓库的 ${version}`)
  }
  assertHostHasUpstreamSkills(env, repo, parsed.tenonRoot)
  if (verifyPackagedAssets(deps, env, repo, false) !== 0) throw new Error('源码仓库未通过插件资产校验')
  return { candidateRoot: repo, evidence: inventory }
}

function revalidateDevCandidate(
  ctx: DevCandidateContext & { readonly devSource: RuntimeDevSource; readonly identity: (repo: string) => RuntimeDevSource },
  candidate: { readonly candidateRoot: string },
): void {
  const { deps, env, host, repo, version } = ctx
  if (candidate.candidateRoot !== repo) {
    throw new Error(`候选根 ${candidate.candidateRoot} 不是冻结的源码仓库 ${repo}`)
  }
  const drift = compareDevSource(ctx.devSource, ctx.identity(repo))
  if (drift.length > 0) {
    throw new Error(
      `工作区在安装期间发生变化（${drift.join('；')}）；请重新运行 `
      + `tenon setup ${hostFlag(host)} --from-source ${repo}`,
    )
  }
  const observation = decodeDevObservation(observeDevNativeHost(env, host))
  if (!devHostMatches(observation, repo, version)) {
    throw new Error('宿主登记不再绑定冻结的源码仓库与版本')
  }
  if (verifyPackagedAssets(deps, env, repo, false, true) !== 0) throw new Error('候选打包资产重证失败')
}

function commitDevEvidence(
  ctx: { readonly deps: CliDeps; readonly env: SetupEnv; readonly host: NativePipelineHost; readonly devSource: RuntimeDevSource },
  activation: RuntimeActivation,
): void {
  const { release } = activation
  if (release.version !== 2 || release.devSource === undefined || !devSourceEquals(release.devSource, ctx.devSource)) {
    throw new Error('ready evidence 的 release 没有携带冻结的 devSource')
  }
  const configRoot = resolveRuntimePaths({ homeDir: ctx.env.homeDir(), env: ctx.env.runtimeEnv() }).configRoot
  writeInstallChannelMarker(configRoot, {
    host: ctx.host,
    releaseId: release.releaseId,
    installedAt: ctx.deps.clock(),
    devSource: ctx.devSource,
  })
  disableAutoUpdateForDev(ctx.deps, ctx.env, ctx.host)
}

export async function cmdSetupFromSource(input: SourceInstallInput, ports: SourceInstallPorts): Promise<number> {
  const { deps, host, env } = input
  const resolved = ports.resolveRepo(input.repoInput)
  if (!resolved.ok) {
    deps.io.err(`ERROR: ${resolved.reason}`)
    return 1
  }
  const repo = resolved.repo

  // 旧 pipeline 插件的迁移收敛绑定正式稳定标签，开发安装不接管它。
  const convergence = readHostPluginConvergenceReceipt(env, host)
  if (convergence.state === 'invalid') {
    deps.io.err(`ERROR: ${convergence.detail}；未执行任何变更。`)
    return 1
  }
  if (convergence.state === 'receipt' && convergence.receipt.state === 'cleanup-pending') {
    deps.io.err(`ERROR: 旧 Tenon 插件的迁移清理仍在等待（cleanup-pending）；请先完成正式 setup：tenon setup ${hostFlag(host)}。未执行任何变更。`)
    return 1
  }

  const skills = await ports.ensureSkills(repo)
  if (skills.state === 'failed') {
    deps.io.err(`ERROR: ${skills.detail}`)
    deps.io.err('[setup] 未创建事务、未改动宿主与 runtime；网络恢复后重跑同一命令即可（幂等）。')
    return 1
  }

  if (input.skipBuild) {
    deps.io.out('[setup] 已按 --skip-build 跳过构建；请确认 packages/*/dist 与源码一致。')
  } else {
    deps.io.out(`[setup] 构建源码：npm --prefix ${repo} run build（几分钟，输出直接显示）`)
    const built = ports.build(repo)
    if (built.code !== 0) {
      deps.io.err(`ERROR: 源码构建失败（退出码 ${built.code}）${built.detail === '' ? '' : `：${built.detail}`}；未改动宿主与 runtime。`)
      return 1
    }
  }

  let devSource: RuntimeDevSource
  let version: string
  try {
    devSource = ports.identity(repo)
    version = await ports.pluginVersion(repo)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  deps.io.out(
    `[setup] 冻结源码身份：${repo} @ ${devSource.commit.slice(0, 7)}`
    + `${devSource.dirty ? '（工作区有未提交改动）' : ''}，版本展示 ${devVersionLabel(version, devSource.commit)}`,
  )

  const devEnv: SetupEnv = { ...env, managedHostReconciliation: devHostReconciliation(env, repo, version) }
  const dashboardPort = parseDashboardPort(env.runtimeEnv().TENON_DASHBOARD_PORT)
  const context: DevCandidateContext = { deps, env: devEnv, host, repo, version }
  const request: ManagedReleaseRequest = {
    operation: 'setup',
    source: host,
    expectedPluginVersion: version,
    devSource,
    runtime: input.runtimeScope,
    openBrowser: input.openBrowser,
    ...(dashboardPort === null ? {} : { dashboardPort }),
    prepareCandidate: (transaction) => prepareDevCandidate(context, transaction),
    revalidateCandidate: (candidate) => {
      revalidateDevCandidate({ ...context, devSource, identity: ports.identity }, candidate)
    },
    commitReadyEvidence: (activation) => {
      commitDevEvidence({ deps, env, host, devSource }, activation)
    },
  }
  const outcome = await ports.publish(request)
  if (!outcome.ok) {
    deps.io.err(`ERROR: ${outcome.detail}`)
    deps.io.err(
      `[setup] ${hostFlag(host)} 宿主登记由宿主 CLI 独立管理；Tenon 只补偿自己的 managed transaction。`
      + `重跑 tenon setup ${hostFlag(host)} --from-source ${repo} 会从 WAL 幂等恢复。`,
    )
    return 1
  }
  if (outcome.state === 'current') {
    deps.io.out('[setup] 宿主、managed runtime 与 Dashboard 已精确就绪；未重复发布。')
    return 0
  }
  deps.io.out(`[setup] 已发布开发 runtime：${outcome.activation.release.releaseId}（revision ${outcome.activation.selection.revision}）。`)
  deps.io.out(
    `[setup] 这是源码开发安装（${devVersionLabel(version, devSource.commit)}），不是正式版：`
    + `同步源码改动请重跑 tenon setup ${hostFlag(host)} --from-source ${repo}；`
    + `切回正式版：tenon update ${hostFlag(host)} --to-stable。新开会话加载技能与 hooks。`,
  )
  if (host === 'codex') printCodexHookTrust(deps)
  return 0
}
