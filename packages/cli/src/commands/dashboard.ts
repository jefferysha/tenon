/** Launch the pre-built server and SPA shipped inside the immutable plugin release. */
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { machineStateScopeId } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import type { ManagedDashboardIdentity } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import {
  DashboardTerminationUnconfirmedError,
  launchDetachedDashboardProcess,
  type DashboardProcessHandle,
} from './dashboard-process.js'
import {
  probeHealthyDashboard,
  stopOwnedDashboard,
  waitForHealthyServer,
  type DashboardHealthIdentity,
} from './dashboard-health.js'
import {
  dashboardProcessEnvironment,
  parseDashboardPort,
  type ReleasedDashboardOptions,
} from './dashboard-launch-options.js'
import { freezeTrustedExecutable, type TrustedExecutable } from './trusted-executable.js'
import { attachToRunningDashboard, OPEN_FAILED_GUIDANCE, requestDashboardBrowserOpen } from './dashboard-open.js'
import {
  releasedDashboardSession,
  type ReleasedDashboardSession,
  type ReleasedDashboardStopOutcome,
} from './dashboard-session.js'
export type { ReleasedDashboardOptions } from './dashboard-launch-options.js'
export type { ReleasedDashboardSession, ReleasedDashboardStopOutcome } from './dashboard-session.js'
export { releasedDashboardSession } from './dashboard-session.js'

export {
  DashboardTerminationUnconfirmedError,
  type DashboardProcessHandle,
} from './dashboard-process.js'

/** One production endpoint for the bundled SPA and its API. */
export const DEFAULT_DASHBOARD_PORT = 18765

export interface DashboardOpts {
  port?: string
  dryRun?: boolean
  /** Start the server as the managed background service instead of attaching this terminal. */
  background?: boolean
  /** Open the local dashboard after the managed server has passed its health check. */
  open?: boolean
}

export interface DashboardRuntime {
  resolveRoot(): string
  fileExists(path: string): boolean
  launch(serverBundle: string, env: NodeJS.ProcessEnv, nodeExecutable?: string): Promise<number>
  launchDetached(serverBundle: string, env: NodeJS.ProcessEnv, nodeExecutable?: string): Promise<DashboardProcessHandle | null>
  resolveStateScopeId(): string
  waitForHealthyServer(
    port: number,
    expectedReleaseId: string | undefined,
    expectedStateScopeId: string,
    expectedTransactionId?: string,
  ): Promise<DashboardHealthIdentity | null>
  probeHealthyServer(
    port: number,
    expectedReleaseId: string | undefined,
    expectedStateScopeId: string,
    expectedTransactionId?: string | '*',
  ): Promise<DashboardHealthIdentity | null>
  stopOwnedDashboard(identity: DashboardHealthIdentity): Promise<boolean>
  /**
   * Asks the server behind `url` to open the user's browser signed in (the login URL never reaches the caller);
   * resolves false when nothing was opened.
   */
  openBrowser(url: string): Promise<boolean>
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

function launch(
  serverBundle: string,
  env: NodeJS.ProcessEnv,
  nodeExecutable = process.execPath,
): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(nodeExecutable, [serverBundle], { stdio: 'inherit', env })
    child.once('error', () => resolveCode(1))
    child.once('exit', (code) => resolveCode(code ?? 1))
  })
}

export interface DashboardCommandEnvironment {
  resolveTrustedNode(): TrustedExecutable | undefined
}

const REAL_DASHBOARD_COMMAND_ENV: DashboardCommandEnvironment = {
  resolveTrustedNode: () => freezeTrustedExecutable(process.execPath),
}

/** Resolve the active payload root without consulting the caller's project directory. */
function resolveDashboardRoot(): string {
  const declared = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT
  if (declared !== undefined && declared.trim() !== '') return declared
  const candidate = resolve(process.argv[1] ?? '')
  try {
    return resolve(dirname(realpathSync(candidate)), '..', '..', '..')
  } catch {
    return resolve(dirname(candidate), '..', '..', '..')
  }
}

export const REAL_DASHBOARD_RUNTIME: DashboardRuntime = {
  resolveRoot: resolveDashboardRoot,
  fileExists,
  launch,
  launchDetached: launchDetachedDashboardProcess,
  resolveStateScopeId: () =>
    machineStateScopeId(resolveRuntimePaths({ env: process.env, homeDir: homedir() }).stateRoot),
  waitForHealthyServer,
  probeHealthyServer: (port, releaseId, stateScopeId, transactionId) =>
    probeHealthyDashboard(port, releaseId, stateScopeId, {
      ...(transactionId === '*'
        ? { observeAnyTransaction: true }
        : { expectedTransactionId: transactionId }),
    }),
  stopOwnedDashboard,
  // The server opens the browser itself with a one-time login URL nobody else sees.
  openBrowser: requestDashboardBrowserOpen,
}

interface DashboardAssets {
  readonly serverBundle: string
  readonly webIndex: string
}

function packagedAssets(runtime: DashboardRuntime, root: string): DashboardAssets | string[] {
  const serverBundle = join(root, 'packages', 'server', 'dist', 'dashboard.mjs')
  const webIndex = join(root, 'packages', 'dashboard-app', 'dist', 'index.html')
  const missing = [serverBundle, webIndex].filter((path) => !runtime.fileExists(path))
  return missing.length === 0 ? { serverBundle, webIndex } : missing
}

function isDashboardAssets(value: DashboardAssets | string[]): value is DashboardAssets {
  return !Array.isArray(value)
}

export interface ReleasedDashboardStarter {
  inspect(
    deps: CliDeps,
    opts: ReleasedDashboardOptions,
  ): Promise<ManagedDashboardIdentity | null>
  adopt(
    deps: CliDeps,
    identity: ManagedDashboardIdentity,
  ): Promise<ReleasedDashboardSession | null>
  start(
    deps: CliDeps,
    payloadRoot: string,
    opts: ReleasedDashboardOptions,
  ): Promise<ReleasedDashboardStartOutcome>
}

export type ReleasedDashboardStartOutcome =
  | { readonly state: 'ready'; readonly session: ReleasedDashboardSession }
  | { readonly state: 'failed'; readonly detail: string }
  | { readonly state: 'indeterminate'; readonly detail: string }

async function stopFailedCandidate(
  deps: CliDeps,
  child: DashboardProcessHandle,
  detail: string,
): Promise<ReleasedDashboardStartOutcome> {
  try {
    await child.terminate()
  } catch (error) {
    const terminationDetail = error instanceof Error ? error.message : String(error)
    deps.io.err(`[dashboard] ${detail}，且终止状态无法确认：${terminationDetail}`)
    return {
      state: 'indeterminate',
      detail: terminationDetail,
    }
  }
  deps.io.err(`[dashboard] ${detail}；候选进程已确认退出，未打开浏览器。`)
  return { state: 'failed', detail: `${detail}; candidate exit confirmed` }
}

async function startManagedDashboard(
  deps: CliDeps,
  payloadRoot: string,
  opts: ReleasedDashboardOptions,
  runtime: DashboardRuntime,
  expectedReleaseId?: string,
): Promise<ReleasedDashboardStartOutcome> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT
  const assets = packagedAssets(runtime, payloadRoot)
  if (!isDashboardAssets(assets)) {
    deps.io.err(
      `ERROR: 当前 Tenon 插件缺少已发布 dashboard 资产：${assets.join('、')}。` +
      '请运行 tenon update --codex（或 --claude）恢复完整插件包。',
    )
    return { state: 'failed', detail: 'released Dashboard assets are incomplete' }
  }
  let child: DashboardProcessHandle | null
  try {
    opts.verifyTrustedNode?.()
    child = await runtime.launchDetached(
      assets.serverBundle,
      dashboardProcessEnvironment(port, opts.transactionId),
      opts.trustedNodePath,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    deps.io.err(`[dashboard] 候选 server 启动结果无法确认：${detail}`)
    return { state: 'indeterminate', detail: `candidate Dashboard spawn state is unknown: ${detail}` }
  }
  if (child === null) {
    deps.io.err('[dashboard] 受管 server 进程无法启动；runtime 已保留，可运行 tenon dashboard 诊断。')
    return { state: 'failed', detail: 'candidate Dashboard process could not be spawned' }
  }
  let healthy: DashboardHealthIdentity | null
  let expectedStateScopeId: string
  try {
    expectedStateScopeId = runtime.resolveStateScopeId()
    healthy = await runtime.waitForHealthyServer(
      port,
      expectedReleaseId,
      expectedStateScopeId,
      opts.transactionId,
    )
  } catch (error) {
    return stopFailedCandidate(
      deps,
      child,
      `候选 server readiness 抛出异常：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (healthy === null) {
    return stopFailedCandidate(
      deps,
      child,
      `受管 server 在 http://127.0.0.1:${port}/ 未通过健康检查`,
    )
  }
  const identityMatchesSpawn = healthy.version === 1
    && healthy.port === port
    && healthy.pid === child.pid
    && Number.isSafeInteger(healthy.pid)
    && healthy.pid > 0
    && (expectedReleaseId === undefined || healthy.releaseId === expectedReleaseId)
    && (opts.expectedServerVersion === undefined
      || healthy.serverVersion === opts.expectedServerVersion)
    && healthy.stateScopeId === expectedStateScopeId
    && healthy.transactionId === opts.transactionId
  if (!identityMatchesSpawn) {
    return stopFailedCandidate(
      deps,
      child,
      '健康服务 identity 与本次 spawn 的 release/port/PID/state scope/transaction 不一致',
    )
  }
  const url = `http://127.0.0.1:${port}/`
  deps.io.out(`[dashboard] 受管服务健康检查通过：${url}`)
  let browserOpened = true
  try {
    if (opts.openBrowser === true) browserOpened = await runtime.openBrowser(url)
  } catch {
    browserOpened = false
  }
  if (!browserOpened) {
    // Browser policy/headless hosts can reject an OS open request even though the product is up.
    // Do not roll back a healthy immutable runtime; the plain URL only shows a sign-in prompt, so
    // point at the two ways to obtain a signed-in page instead.
    deps.io.err(OPEN_FAILED_GUIDANCE)
  }
  return {
    state: 'ready',
    session: releasedDashboardSession(
      deps,
      healthy as ManagedDashboardIdentity,
      runtime.stopOwnedDashboard,
    ),
  }
}

/**
 * Start a dashboard from the exact immutable payload selected by setup/update. It is deliberately
 * separate from `cmdDashboard` so activation never races the mutable marketplace checkout.
 */
export async function startReleasedDashboard(
  deps: CliDeps,
  payloadRoot: string,
  opts: ReleasedDashboardOptions,
  runtime: DashboardRuntime = REAL_DASHBOARD_RUNTIME,
): Promise<ReleasedDashboardStartOutcome> {
  const expectedReleaseId = basename(payloadRoot) === 'payload' ? basename(dirname(payloadRoot)) : ''
  if (!/^sha256-[a-f0-9]{64}$/.test(expectedReleaseId)) {
    deps.io.err('[dashboard] 受管 payload 缺少合法 content-addressed release identity；拒绝启动。')
    return { state: 'failed', detail: 'managed payload has no content-addressed release identity' }
  }
  return startManagedDashboard(deps, payloadRoot, opts, runtime, expectedReleaseId)
}

/** Start the released single-entry dashboard, or print its exact packaged plan in dry-run mode. */
export async function cmdDashboard(
  deps: CliDeps,
  opts: DashboardOpts,
  runtime: DashboardRuntime = REAL_DASHBOARD_RUNTIME,
  commandEnv: DashboardCommandEnvironment = REAL_DASHBOARD_COMMAND_ENV,
): Promise<number> {
  const explicitPort = opts.port === undefined ? null : parseDashboardPort(opts.port)
  if (opts.port !== undefined && explicitPort === null) {
    deps.io.err('ERROR: --port 必须是 1 到 65535 的整数。')
    return 1
  }

  const root = runtime.resolveRoot()
  const assets = packagedAssets(runtime, root)
  if (!isDashboardAssets(assets)) {
    deps.io.err(
      `ERROR: 当前 Tenon 插件缺少已发布 dashboard 资产：${assets.join('、')}。` +
      '请运行 tenon update --codex（或 --claude）恢复完整插件包。',
    )
    return 1
  }

  const inheritedPort = parseDashboardPort(process.env.TENON_DASHBOARD_PORT)
  const port = explicitPort ?? inheritedPort ?? DEFAULT_DASHBOARD_PORT
  deps.io.out(`[dashboard] 使用插件内置 SPA + server bundle 启动单一入口：http://127.0.0.1:${port}/`)
  deps.io.out(`[dashboard] server: ${assets.serverBundle}`)
  deps.io.out(`[dashboard] web: ${assets.webIndex}`)
  if (opts.dryRun) {
    deps.io.out('[dashboard] --dry-run：未启动 server。')
    return 0
  }
  // A dashboard that already runs needs no new process, so no Node identity either: `--open` only asks it
  // to open the browser.
  if (opts.background === true || opts.open === true) {
    const attached = await attachToRunningDashboard(deps, port, opts.open === true, runtime)
    if (attached !== null) return attached
  }
  const trustedNode = commandEnv.resolveTrustedNode()
  if (trustedNode === undefined) {
    deps.io.err('ERROR: Dashboard 启动前无法冻结当前 Node 物理身份。')
    return 1
  }

  // Browser opening is meaningful only after readiness; make `--open` imply the safe managed
  // background mode rather than racing a foreground server startup.
  if (opts.background === true || opts.open === true) {
    return (await startManagedDashboard(
      deps,
      root,
      {
        port,
        openBrowser: opts.open === true,
        trustedNodePath: trustedNode.executable,
        verifyTrustedNode: trustedNode.assert,
      },
      runtime,
    )).state === 'ready' ? 0 : 1
  }

  try {
    trustedNode.assert()
  } catch (error) {
    deps.io.err(`ERROR: Dashboard 启动前 Node 身份已漂移：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const code = await runtime.launch(
    assets.serverBundle,
    dashboardProcessEnvironment(port),
    trustedNode.executable,
  )
  if (code !== 0) deps.io.err(`[dashboard] server 退出，code=${code}`)
  return code
}
