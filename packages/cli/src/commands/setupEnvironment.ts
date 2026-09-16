import { dirname, join, resolve, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readAutomationJson } from '@tenon/automation'
import { PREREQ_HINTS, withLock } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { nodeExecDocker, probeAfkReadiness, type AfkReadiness, type CredLight, type ExecDockerFn } from '../afkReadiness.js'
import { REAL_RUNTIME_INSTALLER, type RuntimeInstaller } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { loadSkillSources, type SkillSource, type SkillSourcesResult, type SkillTier } from '../skillSources.js'
import {
  REAL_RELEASED_DASHBOARD_STARTER,
} from './released-dashboard-starter.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import {
  hostFlag,
  installedPipelineRoot,
  isNativePipelineHost,
  nativeInstallPlan,
  selectPipelineHost,
  type NativePipelineHost,
  type PipelineHost,
  type PipelineHostFlags,
} from './plugin-host.js'
import {
  codexStatusSpawnPlan,
  createCodexAuthExec,
  probeCodexAuth,
} from '../codexAuth.js'
import { commandExistsOnPath, resolveCommandOnPath } from './commandExists.js'
import {
  nativeHostCommandBinding,
} from './native-host-command-binding.js'
import { freezeTrustedExecutable } from './trusted-executable.js'
import type { SetupEnv } from './setup-env-types.js'
export type { SetupEnv } from './setup-env-types.js'

export const REAL_SETUP_ENV: SetupEnv = {
  homeDir: () => homedir(),
  runtimeEnv: () => ({ ...process.env }),
  isInteractive: () => process.stdin.isTTY === true
    && process.stdout.isTTY === true
    && process.env.CI === undefined,
  pluginRoot: () => {
    const r = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT
    return r !== undefined && r.trim() !== '' ? r : null
  },
  selfPath: () => {
    const candidate = resolve(process.argv[1] ?? '')
    // The user-facing launcher is a stable script under ~/.local/bin.  Follow the active process
    // path before deriving a dev fallback so `tenon dashboard` / `tenon update` never
    // mistake ~/.local for a marketplace candidate root.
    try {
      return realpathSync(candidate)
    } catch {
      return candidate
    }
  },
  pathExists: (path) => {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  readTextState: (path) => {
    try {
      return { state: 'ok', text: readFileSync(path, 'utf8') }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT'
        ? { state: 'missing' }
        : { state: 'error', detail: errMsg(error) }
    }
  },
  mkdirp: (dir) => { mkdirSync(dir, { recursive: true }) },
  commandExists: (name) => commandExistsOnPath(name),
  resolveHostCommand: (host) => {
    const executable = resolveCommandOnPath(host, {
      requireAbsolutePathEntries: true,
    })
    if (executable === undefined) return undefined
    const trusted = freezeTrustedExecutable(executable)
    const commandInterpreter = process.platform === 'win32'
      && /\.(?:cmd|bat)$/iu.test(trusted?.executable ?? '')
      ? freezeTrustedExecutable(
          process.env.ComSpec && win32.isAbsolute(process.env.ComSpec)
            ? process.env.ComSpec
            : win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        )
      : undefined
    return trusted === undefined
      ? undefined
      : nativeHostCommandBinding(
          trusted.executable,
          process.platform,
          process.env,
          trusted,
          commandInterpreter,
        )
  },
  resolveTrustedCommand: (name) => {
    const candidate = resolveCommandOnPath(name, { requireAbsolutePathEntries: true })
    return candidate === undefined ? undefined : freezeTrustedExecutable(candidate)?.executable
  },
  resolveTrustedCommandBinding: (name) => {
    const candidate = resolveCommandOnPath(name, { requireAbsolutePathEntries: true })
    return candidate === undefined ? undefined : freezeTrustedExecutable(candidate)
  },
  codexAuthStatus: (codexExecutable, commandBinding) => {
    if (codexExecutable === undefined) return probeCodexAuth()
    const invocation = commandBinding?.invocation(['login', 'status'])
    const plan = commandBinding === undefined
      ? codexStatusSpawnPlan(process.platform, process.env, () => codexExecutable)
      : invocation === undefined
        ? { unavailableReason: 'cli-missing' as const }
        : { status: invocation }
    return probeCodexAuth(createCodexAuthExec({ plan }))
  },
  listDir: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink()) // skill/plugin 常以 symlink 装入
        .map((e) => e.name)
    } catch {
      return [] // 缺目录/无权限 → 空（fail-safe，与 main.ts safeReaddirDirs 同口径）
    }
  },
  writeText: (path, text) => { writeFileSync(path, text, 'utf8') },
  writeTextAtomic: (path, text) => {
    const lockPath = `${path}.lock`
    const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`
    let lockFd: number | undefined
    try {
      lockFd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(tempPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(tempPath, path)
    } finally {
      try { unlinkSync(tempPath) } catch { /* rename 已消费或写入未开始 */ }
      if (lockFd !== undefined) {
        closeSync(lockFd)
        try { unlinkSync(lockPath) } catch { /* 锁已经由持有者完成清理 */ }
      }
    }
  },
  runCommand: (cmd, args, options) => {
    try {
      const stdout = execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      })
      return { code: 0, stdout, stderr: '' }
    } catch (e) {
      // execFileSync 非零退出会抛;把 status/stdout/stderr 折算回结构（不抛,逐条容错的前提）
      const err = e as { status?: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null }
      const stderr = err.stderr == null ? '' : String(err.stderr)
      return {
        code: typeof err.status === 'number' ? err.status : 1,
        stdout: err.stdout != null ? String(err.stdout) : '',
        stderr: stderr !== '' ? stderr : errMsg(e),
      }
    }
  },
  withHostMutationLock: (host, operation) => {
    const homeDir = homedir()
    const paths = resolveRuntimePaths({ homeDir, env: { ...process.env } })
    return withLock(join(paths.stateRoot, 'host-mutation', host), operation)
  },
  confirm: (question) => {
    process.stdout.write(question)
    try {
      const buf = Buffer.alloc(64)
      // 同步读 fd 0 一次。**不检查 isTTY**：判据是「读到了什么」而非「是不是终端」——
      // 故 `echo y | tenon setup` 这类管道输入同样会放行（非 TTY 不等于自动判 No）。
      const n = readSync(0, buf, 0, 64, null)
      const ans = buf.toString('utf8', 0, n).trim().toLowerCase()
      return ans === 'y' || ans === 'yes'
    } catch {
      return false // 读失败（无输入可读/fd 0 关闭等）→ 判 No，fail-closed（自动化走 --yes）
    }
  },
}

/**
 * 插件根优先取宿主注入；终端直接执行 bundle 时，从 dist/tenon.mjs 反推仓根。
 * 这样 `tenon update` 在宿主重新安装后可用刚解析出的候选根发布 managed runtime，
 * 而不依赖旧 hook env 或可变 marketplace checkout。
 */
export function resolvePipelineRoot(env: SetupEnv): string {
  const root = env.pluginRoot()
  if (root !== null) return root
  return resolve(dirname(env.selfPath()), '..', '..', '..')
}

// ── 全流程开场白（四段预告,纯呈现）─────────────────────────────────────────────────────

export interface SetupOpts extends PipelineHostFlags {
  dryRun?: boolean
  yes?: boolean
  /** Explicit target only applies to non-native adapters; defaults to current project. */
  target?: string
  /** Opt-in: native host SessionStart performs a throttled marketplace refresh/reinstall. */
  autoUpdate?: boolean
}

/** 全流程开场白:向用户预告下面四段会发生什么（纯 stdout 呈现,无副作用;真逻辑在各段自己的函数里）。 */
export function printPlanSkeleton(deps: CliDeps, opts: SetupOpts, host: PipelineHost): void {
  deps.io.out(`[setup] ${hostFlag(host)} 全功能就绪引导 —— 计划骨架`)
  deps.io.out('  1. 宿主安装:只验证/部署所选宿主，不会同时改动其他宿主。')
  deps.io.out('  2. 稳定入口:把已校验 release 原子发布到本机 runtime，再写 tenon / tenon-hook 启动器。')
  if (host === 'codex') {
    deps.io.out('  3. Codex 认证:Codex 安装会检查 `codex login status`，未登录时同时给出 ChatGPT 方案与 API Key 路径。')
  }
  const hostStepOffset = host === 'codex' ? 1 : 0
  deps.io.out(`  ${3 + hostStepOffset}. 上游技能:宿主安装与更新时从 skills/sources.yaml 列出的 GitHub 仓库获取最新技能；获取失败保留旧版本。`)
  deps.io.out(`  ${4 + hostStepOffset}. 运行时检查:docker/镜像/两 runner 凭证就绪清单（本流程末尾直接跑;--dry-run 只提示见 tenon setup runtime）。`)
  deps.io.out(`  ${5 + hostStepOffset}. 全功能红黄绿汇总:安装后运行 tenon doctor --json 获取全机汇总。`)
  if (opts.dryRun) deps.io.out('  （--dry-run:仅打印计划,不发布 runtime、不写任何文件）')
}

function autoUpdateConfigPath(env: SetupEnv): string {
  return join(resolveRuntimePaths({
    homeDir: env.homeDir(),
    env: env.runtimeEnv(),
  }).configRoot, 'auto-update.conf')
}

/** Native host only: write a tiny explicit preference consumed by hooks/auto-update.sh. */
export function configureAutoUpdate(deps: CliDeps, env: SetupEnv, host: PipelineHost, enabled: boolean): number {
  if (!enabled) return 0
  if (!isNativePipelineHost(host)) {
    deps.io.err(`ERROR: ${hostFlag(host)} 没有原生 marketplace，不能启用自动更新；请先更新承载该 adapter 的 Codex 或 Claude 插件。`)
    return 1
  }
  try {
    const config = autoUpdateConfigPath(env)
    env.mkdirp(dirname(config))
    env.writeText(config, `host=${host}\nenabled=true\n`)
    deps.io.out(`[setup] 已启用 ${hostFlag(host)} 自动更新（每天最多检查一次；新版本安装后请新开会话加载技能与 hooks）。`)
    return 0
  } catch (error) {
    deps.io.err(`WARN: 无法写入自动更新配置（不影响当前安装）:${errMsg(error)}`)
    return 0
  }
}

/** Codex intentionally keeps third-party hook execution behind one explicit local trust decision. */
export function printCodexHookTrust(deps: CliDeps): void {
  deps.io.out('[setup] Codex 已安装 Tenon hooks；为启用正常对话自动路由，请在 Codex 输入 /hooks，并信任 tenon。')
  deps.io.out('        这是 Codex 的一次性本机安全确认；未信任时 skills 仍可用，但 SessionStart/UserPromptSubmit hooks 不会执行。')
}

type JsonRecord = Record<string, unknown>

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Version 0.1 installed Codex hooks directly into ~/.codex/hooks.json and pointed them at the
 * mutable source checkout. Version 0.2 ships those hooks inside the native plugin and dispatches
 * through the immutable managed runtime. Keeping both registrations causes every event to fire
 * twice and lets a stale adapter participate in a new session.
 *
 * Match only the four exact legacy adapter scripts. A user command merely mentioning "pipeline"
 * or a different hook under adapters/ is never touched.
 */
const LEGACY_CODEX_ADAPTER_COMMAND = /(?:^|[\s"'])(?:[^\s"']*\/)?adapters\/codex\/hooks\/(?:inject|prompt|veto|track)\.sh(?=$|[\s"'])/

function isLegacyCodexAdapterHook(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value.command !== 'string') return false
  return LEGACY_CODEX_ADAPTER_COMMAND.test(value.command)
}

export interface LegacyCodexHookCleanup {
  readonly content: string
  readonly removed: number
}

/**
 * Pure, conservative migration for the old global Codex registration. It understands Codex's
 * nested hook groups, removes only our obsolete commands, and leaves malformed/unknown shapes
 * byte-for-byte untouched. The caller writes only when at least one owned command was removed.
 */
export function scrubLegacyCodexAdapterHooks(content: string): LegacyCodexHookCleanup {
  let root: unknown
  try {
    root = JSON.parse(content)
  } catch {
    return { content, removed: 0 }
  }
  if (!isJsonRecord(root) || !isJsonRecord(root.hooks)) return { content, removed: 0 }

  let removed = 0
  const hooks = root.hooks
  for (const eventName of Object.keys(hooks)) {
    const groups = hooks[eventName]
    if (!Array.isArray(groups)) continue

    const retainedGroups: unknown[] = []
    for (const group of groups) {
      if (isLegacyCodexAdapterHook(group)) {
        removed += 1
        continue
      }
      if (!isJsonRecord(group) || !Array.isArray(group.hooks)) {
        retainedGroups.push(group)
        continue
      }

      const retainedHooks = group.hooks.filter((hook) => {
        if (!isLegacyCodexAdapterHook(hook)) return true
        removed += 1
        return false
      })
      if (retainedHooks.length === 0) continue
      retainedGroups.push(retainedHooks.length === group.hooks.length ? group : { ...group, hooks: retainedHooks })
    }

    if (retainedGroups.length === 0) delete hooks[eventName]
    else hooks[eventName] = retainedGroups
  }
  if (removed === 0) return { content, removed: 0 }
  if (Object.keys(hooks).length === 0) delete root.hooks
  return { content: `${JSON.stringify(root, null, 2)}\n`, removed }
}

/**
 * Native Codex owns plugin hook lifecycle. Before publishing a runtime, migrate only obsolete
 * version-0.1 global registrations so a newly installed plugin never runs a duplicate adapter.
 */
export function migrateLegacyCodexHooks(deps: CliDeps, env: SetupEnv): number {
  const configPath = join(env.homeDir(), '.codex', 'hooks.json')
  if (!env.pathExists(configPath)) return 0

  const current = env.readText(configPath)
  if (current === undefined) {
    deps.io.err(`[setup] WARN: 无法读取 ${configPath}；未能确认旧版 pipeline Codex hooks 是否已迁移。`)
    return 1
  }
  const migration = scrubLegacyCodexAdapterHooks(current)
  if (migration.removed === 0) return 0

  try {
    env.writeText(configPath, migration.content)
  } catch (error) {
    deps.io.err(`ERROR: 无法迁移旧版 Codex hooks；为避免新旧 hooks 重复执行，未发布 runtime：${errMsg(error)}`)
    return 1
  }
  deps.io.out(`[setup] 已迁移 ${migration.removed} 个旧版 Codex hook；保留其余用户 hooks，由 tenon 插件统一接管。`)
  return 0
}

/** Verify a resolved plugin root before publishing it as a managed runtime or mutating an adapter target. */
import { execFileSync } from 'node:child_process'
import {
  accessSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
