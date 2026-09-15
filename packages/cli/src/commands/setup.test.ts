/**
 * setup 命令 —— mock/真临时 fs 混合回归（full-install F3 骨架 + S2 技能安装段）。
 * 覆盖:①--dry-run 零写零发布(spy env 断言零 mutation);②managed runtime 发布只经注入边界、
 * 从不把启动器直连 marketplace checkout；③runtime 占位分派、skills 真实装派;
 * ④program 装配 flag 解析(--dry-run/--yes 透传);⑤技能安装段 S2 七钉(命令生成/官方第三方标注/幂等/
 * dry-run 零执行/失败容错/engine 附加/禁整装)。候选根仅经 managed-runtime 发布边界进入稳定启动器。
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeDeps } from '../test-support.js'
import { buildProgram, CliExit } from '../program.js'
import { readSkillSources, type SkillSource, type SkillSourcesResult } from '../skillSources.js'
import {
  buildSkillsPlan,
  commandExistsOnPath,
  cmdSetup,
  cmdSetupHost,
  cmdSetupRuntime,
  cmdSetupSkills,
  REAL_RUNTIME_ENV,
  scrubLegacyCodexAdapterHooks,
  verifyPackagedAssets,
  type PlannedCommand,
  type RuntimeEnv,
  type SetupEnv,
} from './setup.js'
import { resolveCommandOnPath } from './commandExists.js'
import { nativeHostCommandBinding } from './native-host-command-binding.js'
import type { ExecDockerFn } from '../afkReadiness.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { UpstreamSkillInstallInput } from '../upstream-skills/install.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import { createHostTargetPlan } from './host-target-plan.js'
import { cmdUpdate } from './update.js'
import {
  readHostPluginConvergenceReceipt,
  recordPendingHostPluginConflict,
} from './host-plugin-convergence.js'
import { parseHostPluginInventory, TENON_RELEASE_VERSION } from './plugin-host.js'
import { freezeTrustedExecutable, type TrustedExecutable } from './trusted-executable.js'

const CURRENT_RELEASE_TAG = `v${TENON_RELEASE_VERSION}` as const

async function createTrustedNode(root: string): Promise<{ bin: string; executable: string }> {
  const bin = join(root, 'trusted-bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  chmodSync(bin, 0o700)
  const executable = join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
  await cp(process.execPath, executable)
  chmodSync(executable, 0o700)
  if (process.platform === 'darwin') {
    const nodeLibDir = join(dirname(process.execPath), '..', 'lib')
    const nodeLib = readdirSync(nodeLibDir).find((entry) => /^libnode\..+\.dylib$/u.test(entry))
    if (nodeLib !== undefined) {
      await cp(join(nodeLibDir, nodeLib), join(bin, nodeLib))
    }
  }
  return { bin, executable }
}

function hermeticProvenancePath(bin: string): string {
  const required = process.platform === 'win32'
    ? [
        bin,
        process.env.SystemRoot === undefined ? undefined : join(process.env.SystemRoot, 'System32'),
        process.env.ComSpec === undefined ? undefined : dirname(process.env.ComSpec),
        process.env.PATH ?? process.env.Path,
      ]
    : [bin, '/usr/bin', '/bin']
  return required.filter((entry): entry is string => entry !== undefined && entry !== '').join(delimiter)
}

// ── spy env:记录全部 fs mutation + exec 调用,断言「零副作用」/「未碰 PATH」/「零执行」──────
interface SpyCalls {
  mkdirp: string[]
  writeText: Array<[string, string]>
  exec: Array<[string, string[]]>
}
type ExecStub = (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string }

function fakeTrustedExecutable(
  executable: string,
  verify: () => boolean = () => true,
): TrustedExecutable {
  return {
    executable,
    requestedPath: executable,
    proof: {} as TrustedExecutable['proof'],
    verify,
    assert: () => {
      if (!verify()) throw new Error(`trusted executable drifted: ${executable}`)
    },
  }
}

function spyEnv(over: Partial<SetupEnv> = {}, exec?: ExecStub, confirmAns = true): { env: SetupEnv; calls: SpyCalls } {
  const calls: SpyCalls = { mkdirp: [], writeText: [], exec: [] }
  const mutationBaselines = new Map<string, number>()
  const env: SetupEnv = {
    homeDir: () => '/home/test',
    runtimeEnv: () => ({}),
    pluginRoot: () => '/plugin',
  selfPath: () => '/plugin/packages/cli/dist/tenon.mjs',
  mkdirp: (d) => { calls.mkdirp.push(d) },
  pathExists: () => false,
  readText: () => undefined,
  readTextState: (path) => {
    const read = over.readText?.(path)
    if (read !== undefined) return { state: 'ok', text: read }
    return over.pathExists?.(path) === true
      ? { state: 'error', detail: 'injected unreadable path' }
      : { state: 'missing' }
    },
    commandExists: () => true,
    resolveHostCommand: (host) => over.commandExists?.(host) === false
      ? undefined
      : nativeHostCommandBinding(host, 'darwin', {}),
    codexAuthStatus: async () => ({ state: 'authenticated' }),
    listDir: () => [],
    writeText: (p, text) => { calls.writeText.push([p, text]) },
    writeTextAtomic: (p, text) => { calls.writeText.push([p, text]) },
    inspectCandidatePayload: async () => ({
      pluginVersion: TENON_RELEASE_VERSION,
      payloadDigest: 'a'.repeat(64),
    }),
    migrateProjectRegistry: async () => ({
      status: 'completed',
      discovered: 0,
      imported: 0,
      rejected: 0,
    }),
    runCommand: (cmd, args) => {
      calls.exec.push([cmd, args])
      if (cmd === 'git' && args.join(' ') === [
        'ls-remote',
        'https://github.com/jefferysha/tenon.git',
        `refs/tags/${CURRENT_RELEASE_TAG}`,
        `refs/tags/${CURRENT_RELEASE_TAG}^{}`,
      ].join(' ')) {
        return { code: 0, stdout: `${'a'.repeat(40)}\trefs/tags/${CURRENT_RELEASE_TAG}\n`, stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'init') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[2] === 'fetch') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[2] === 'rev-parse' && args[3] === 'FETCH_HEAD^{commit}') {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      }
      if (cmd === 'git' && args[2] === 'cat-file') {
        return { code: 0, stdout: 'commit\n', stderr: '' }
      }
      const result = exec ? exec(cmd, args) : { code: 0, stdout: '', stderr: '' }
      if (result.code !== 0 || result.stdout.trim() !== '') return result
      const text = `${cmd} ${args.join(' ')}`
      if (text.endsWith('plugin marketplace list --json')
        || args.some((arg) => arg.includes('plugin marketplace list --json'))) {
        return cmd.endsWith('claude')
          ? {
              code: 0,
              stdout: JSON.stringify([{
                name: 'tenon',
                installLocation: '/installed/tenon',
                repo: 'jefferysha/tenon',
                source: 'github',
              }]),
              stderr: '',
            }
          : {
              code: 0,
              stdout: JSON.stringify({ marketplaces: [{
                name: 'tenon',
                root: '/installed/tenon',
                marketplaceSource: { sourceType: 'git', source: 'jefferysha/tenon' },
              }] }),
              stderr: '',
            }
      }
      if (/git -C \/installed\/tenon rev-parse HEAD$/.test(text)) {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      }
      if (/git -C \/installed\/tenon remote get-url origin$/.test(text)) {
        return { code: 0, stdout: 'https://github.com/jefferysha/tenon.git\n', stderr: '' }
      }
      if (/git -C \/installed\/tenon diff --quiet HEAD --$/.test(text)
        || /git -C \/installed\/tenon ls-files --others --exclude-standard$/.test(text)
        || text.startsWith('git diff --no-index --quiet -- ')) {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (text === 'git -C /installed/tenon symbolic-ref --quiet --short HEAD') {
        return { code: 1, stdout: '', stderr: '' }
      }
      if (text === 'git -C /installed/tenon describe --tags --exact-match HEAD') {
        return { code: 0, stdout: `${CURRENT_RELEASE_TAG}\n`, stderr: '' }
      }
      return result
    },
    managedHostReconciliation: (_host, stepId, command) => {
      const key = `${command.cmd}\u0000${command.args.join('\u0000')}`
      const baseline = calls.exec.filter(([cmd, args]) =>
        `${cmd}\u0000${args.join('\u0000')}` === key).length
      mutationBaselines.set(stepId, baseline)
      const desired = `test-desired:${stepId}`
      return {
        desired,
        observe: () => {
          const executions = calls.exec.filter(([cmd, args]) =>
            `${cmd}\u0000${args.join('\u0000')}` === key).length
          return executions > (mutationBaselines.get(stepId) ?? baseline)
            ? desired
            : `test-before:${stepId}:${baseline}`
        },
        isDesired: (observation) => observation === desired,
      }
    },
    confirm: () => confirmAns,
    ...over,
  }
  return { env, calls }
}

describe('Codex CLI PATH availability preflight', () => {
  test('rejects a directory named codex and accepts an executable file or symlink to one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-command-path-'))
    const fakeBin = join(root, 'bin')
    const realBin = join(root, 'real-bin')
    mkdirSync(fakeBin)
    mkdirSync(realBin)
    try {
      mkdirSync(join(fakeBin, 'codex'))
      expect(commandExistsOnPath('codex', { pathValue: fakeBin, platform: 'darwin' })).toBe(false)

      rmSync(join(fakeBin, 'codex'), { recursive: true })
      const target = join(realBin, 'codex-real')
      writeFileSync(target, '#!/bin/sh\nexit 0\n')
      chmodSync(target, 0o755)
      symlinkSync(target, join(fakeBin, 'codex'))
      expect(commandExistsOnPath('codex', { pathValue: fakeBin, platform: 'darwin' })).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ordinary tool discovery keeps relative PATH compatibility while trusted host discovery excludes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-command-relative-path-'))
    const relativeBin = join(root, 'node_modules', '.bin')
    mkdirSync(relativeBin, { recursive: true })
    const tool = join(relativeBin, 'openspec')
    writeFileSync(tool, '#!/bin/sh\nexit 0\n')
    chmodSync(tool, 0o755)
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      expect(commandExistsOnPath('openspec', {
        pathValue: './node_modules/.bin',
        platform: 'darwin',
      })).toBe(true)
      expect(resolveCommandOnPath('openspec', {
        pathValue: './node_modules/.bin',
        platform: 'darwin',
        requireAbsolutePathEntries: true,
      })).toBeUndefined()
    } finally {
      process.chdir(previousCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Windows npm batch shims use a bounded cmd.exe plan and reject expansion characters', () => {
    const executable = 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd'
    const binding = nativeHostCommandBinding(executable, 'win32', {
      SystemRoot: 'C:\\Windows',
    })
    expect(binding?.invocation(['plugin', 'list', '--json'])).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd" plugin list --json"',
      ],
      cwd: 'C:\\Users\\Alice\\AppData\\Roaming\\npm',
    })
    expect(binding?.invocation(['plugin', 'add', 'bad&plugin'])).toBeUndefined()
    expect(nativeHostCommandBinding(
      'C:\\Users\\100%\\AppData\\Roaming\\npm\\codex.cmd',
      'win32',
      { SystemRoot: 'C:\\Windows' },
    )).toBeUndefined()
  })
})

function setupPathExists(path: string): boolean {
  return !path.includes('/host-plugin-convergence/')
}

function setupReadText(path: string): string | undefined {
  if (path.endsWith('/.codex/hooks.json')) return '{}\n'
  if (path.endsWith('/.codex-marketplace-install.json')) {
    return JSON.stringify({ ref_name: CURRENT_RELEASE_TAG })
  }
  if (path.endsWith('/.codex-plugin/plugin.json')
    || path.endsWith('/.claude-plugin/plugin.json')) {
    return JSON.stringify({ version: TENON_RELEASE_VERSION })
  }
  return undefined
}

interface RuntimeCalls {
  readonly activations: Array<readonly [string, string, string]>
  readonly reverts: Array<readonly [string, string]>
  readonly journalWrites: import('../runtime/installer.js').ManagedReleaseJournalRecord[]
}

interface DashboardCalls {
  readonly starts: Array<readonly [string, {
    readonly openBrowser?: boolean
    readonly port?: number
    readonly transactionId?: string
    readonly expectedServerVersion?: string
  }]>
}

function fakeRuntimeInstaller(
  fail = false,
  previousRelease: string | null = null,
  activeRelease: string | null = null,
  initialJournal: import('../runtime/installer.js').ManagedReleaseJournalRecord | null = null,
  recoveredActivation?: import('../runtime/types.js').RuntimeActivation,
  activePluginVersion = '1.0.1',
  activeHost: 'codex' | 'claude' = 'codex',
): { installer: RuntimeInstaller; calls: RuntimeCalls } {
  const calls: RuntimeCalls = { activations: [], reverts: [], journalWrites: [] }
  const releaseId = `sha256-${'a'.repeat(64)}`
  let journal: import('../runtime/installer.js').ManagedReleaseJournalRecord | null = initialJournal
  let currentActivation = initialJournal?.activation ?? recoveredActivation
  const installer: RuntimeInstaller = {
    withManagedTransaction: async (scope, operation) => operation({
      checkpointActivation: async () => ({
        selection: {
          version: 1,
          revision: 0,
          activeRelease: previousRelease,
          previousRelease: null,
          updatedAt: '2026-07-23T00:00:00Z',
        },
        launchers: {
          tenon: { path: '/home/test/.local/bin/tenon', state: { kind: 'missing' } },
          hook: { path: '/home/test/.local/bin/tenon-hook', state: { kind: 'missing' } },
        },
      }),
      activate: async (candidateRoot, host, expectedPluginVersion, stableTarget) => {
        calls.activations.push([candidateRoot, host, scope.homeDir])
        if (fail) throw new Error('candidate rejected')
        currentActivation = {
          release: {
            version: stableTarget === undefined ? 1 : 2,
            releaseId,
            payloadDigest: 'a'.repeat(64),
            createdAt: '2026-07-24T00:00:00Z',
            source: { host, pluginVersion: expectedPluginVersion ?? '1.0.0' },
            ...(stableTarget === undefined ? {} : { stableTarget }),
          },
          selection: {
            version: 1,
            revision: 1,
            activeRelease: releaseId,
            previousRelease,
            updatedAt: '2026-07-24T00:00:00Z',
          },
          releaseRoot: `/runtime/releases/${releaseId}`,
        }
        return currentActivation
      },
      recoverActivation: async () => currentActivation === undefined
        ? { state: 'not-started' as const }
        : { state: 'activated' as const, activation: currentActivation },
      revertActivation: async (activation) => {
        calls.reverts.push([scope.homeDir, activation.release.releaseId])
        currentActivation = undefined
      },
      proveActivation: async (activation) =>
        currentActivation?.release.releaseId === activation.release.releaseId
        && currentActivation.selection.revision === activation.selection.revision,
      journal: {
        create: (operationName, source, now) => ({
          version: 1,
          transactionId: initialJournal === null
            ? 'setup-test-transaction'
            : 'setup-test-transaction-new',
          operation: operationName,
          source,
          phase: 'preparing-host',
          startedAt: now,
          updatedAt: now,
        }),
        read: async () => journal,
        write: async (record) => {
          journal = record
          calls.journalWrites.push(record)
        },
        clear: async () => { journal = null },
      },
    }),
    inspect: async () => ({
      selection: { version: 1, revision: 0, activeRelease, previousRelease: null, updatedAt: '1970-01-01T00:00:00Z' },
      active: activeRelease === null ? null : {
        version: 1,
        releaseId: activeRelease,
        payloadDigest: activeRelease.replace(/^sha256-/, ''),
        createdAt: '2026-07-24T00:00:00Z',
        source: { host: activeHost, pluginVersion: activePluginVersion },
      },
      previous: null,
      activeValid: activeRelease !== null,
      previousValid: false,
      lastAudit: null,
    }),
    rollback: async () => { throw new Error('not used') },
  }
  return { installer, calls }
}

function fakeDashboardStarter(
  fail = false,
  initialRelease: string | null = null,
  initialServerVersion = TENON_RELEASE_VERSION,
): { starter: ReleasedDashboardStarter; calls: DashboardCalls } {
  const calls: DashboardCalls = { starts: [] }
  let running = initialRelease === null
    ? null
    : {
        version: 1 as const,
        serverVersion: initialServerVersion,
        port: 18_765,
        pid: 320,
        releaseId: initialRelease,
        stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
      }
  return {
    starter: {
      inspect: async () => running,
      adopt: async () => null,
      start: async (_deps, payloadRoot, opts) => {
        calls.starts.push([payloadRoot, opts])
        const releaseId = payloadRoot.split('/').at(-2) ?? ''
        if (!fail) {
          running = {
            version: 1,
            serverVersion: opts.expectedServerVersion ?? TENON_RELEASE_VERSION,
            port: opts.port ?? 18_765,
            pid: 321,
            releaseId,
            stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
            ...(opts.transactionId === undefined ? {} : { transactionId: opts.transactionId }),
          }
        }
        return fail
          ? { state: 'failed', detail: 'injected readiness failure' }
          : {
              state: 'ready',
              session: {
                ownership: {
                  version: 1,
                  serverVersion: opts.expectedServerVersion ?? TENON_RELEASE_VERSION,
                  port: opts.port ?? 18_765,
                  pid: 321,
                  releaseId,
                  stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
                  ...(opts.transactionId === undefined ? {} : { transactionId: opts.transactionId }),
                },
                stop: async () => ({ state: 'stopped' as const }),
              },
            }
      },
    },
    calls,
  }
}

// ── 运行时段 fake RuntimeEnv（注入 docker exec + hostEnv + image;零真 docker 子进程）──────────
/** 缺省:docker 可用 + 镜像在位;over 覆写 exec/hostEnv/resolveImage 造 docker 缺 / 镜像缺 / 凭证态。 */
function fakeRt(over: Partial<RuntimeEnv> = {}): RuntimeEnv {
  const okExec: ExecDockerFn = async (args) => {
    if (args[0] === 'info') return { stdout: 'ok', stderr: '', exitCode: 0 }
    if (args[0] === 'image' && args[1] === 'inspect') return { stdout: '[]', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  return { exec: okExec, hostEnv: {}, resolveImage: () => 'sandcastle:local', ...over }
}
/** docker daemon 不可用（info 非零）——镜像 inspect 不应再被调（短路）。 */
const dockerDownExec: ExecDockerFn = async () => ({ stdout: '', stderr: 'daemon down', exitCode: 1 })

// ── S2 registry fixtures（inline SkillSource[] 子集,不碰真 yaml）──────────────────────
const ECC_NAMES = [
  'browser-qa', 'e2e-testing', 'search-first', 'deep-research', 'market-research', 'code-tour', 'github-ops',
  'react-patterns', 'python-patterns', 'python-testing', 'nestjs-patterns', 'postgres-patterns', 'docker-patterns',
  'deployment-patterns', 'frontend-patterns',
] as const
const eccSources: SkillSource[] = ECC_NAMES.map((n) => ({
  token: n, tool: 'skills-cli', source: 'affaan-m/ECC', skill: n,
  tier: n === 'browser-qa' || n === 'e2e-testing' ? 'mandatory' : 'optional', official: false,
  ...(n === 'browser-qa' ? { engine: 'playwright@claude-plugins-official' } : {}),
}))
const cmdText = (c: PlannedCommand): string => [c.cmd, ...c.args].join(' ')

/** Native setup must resolve the real plugin root from the host-owned inventory, not cache guesses. */
const codexInstallExec: ExecStub = (cmd, args) => {
  if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
    return {
      code: 0,
      stdout: JSON.stringify({
        installed: [{
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          version: TENON_RELEASE_VERSION,
          source: { path: '/installed/tenon' },
        }],
      }),
      stderr: '',
    }
  }
  return { code: 0, stdout: '', stderr: '' }
}

describe('①--dry-run —— 按宿主打印计划且零写、零发布', () => {
  test('setup --codex --dry-run:骨架含三段 + Phase 锚点,且零 mutation', () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv()
    expect(cmdSetup(deps, undefined, { codex: true, dryRun: true }, env)).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('计划骨架')
    expect(out).toContain('唯一 tenon 插件')
    expect(out).toContain('plugin remove tenon@tenon')
    expect(out).toContain('plugin marketplace remove tenon')
    expect(out).toContain('仅在宿主状态不精确时')
    expect(out).toContain('内置技能')
    expect(out).toContain('技能安装计划')
    expect(out).toContain('运行时就绪检查')
    expect(out).toContain('--dry-run')
    // 零副作用铁律（含技能段:dry-run 零执行）
    expect(calls.mkdirp).toHaveLength(0)
    expect(calls.writeText).toHaveLength(0)
    expect(calls.exec).toHaveLength(0)
  })

  test('未选择宿主 → fail-loud，不会悄悄同时安装 Codex 与 Claude', () => {
    const deps = makeDeps()
    expect(cmdSetup(deps, undefined, { dryRun: true }, spyEnv().env)).toBe(1)
    expect(deps.errLines.join('\n')).toContain('必须指定一个宿主')
  })
})

describe('①a 自动更新偏好 —— 只允许原生宿主，且在插件校验后写入用户配置', () => {
  test('Codex 已有完整已验证插件时复用宿主清单根，--auto-update 写入精确每日更新偏好', async () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      runtimeEnv: () => ({ TENON_DASHBOARD_PORT: '43210' }),
    }, codexInstallExec)
    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()

    expect(await cmdSetupHost(deps, 'codex', { codex: true, autoUpdate: true }, env, runtime.installer, dashboard.starter)).toBe(0)
    expect(calls.writeText).toEqual([[
      join(resolveRuntimePaths({ homeDir: '/home/test', env: {} }).configRoot, 'auto-update.conf'),
      'host=codex\nenabled=true\n',
    ]])
    expect(calls.mkdirp).toContain(resolveRuntimePaths({ homeDir: '/home/test', env: {} }).configRoot)
    const commands = calls.exec.map(([cmd, args]) => [cmd, args.join(' ')] as const)
    expect(commands[0]).toEqual([
      'git',
      `ls-remote https://github.com/jefferysha/tenon.git refs/tags/${CURRENT_RELEASE_TAG} refs/tags/${CURRENT_RELEASE_TAG}^{}`,
    ])
    expect(commands.find(([cmd, args]) => cmd === 'codex' && args === 'plugin list --json'))
      .toEqual(['codex', 'plugin list --json'])
    expect(commands).toContainEqual(['codex', 'plugin marketplace list --json'])
    expect(commands).toContainEqual(['bash', `/installed/tenon/tools/verify-skills.sh --quiet --root /installed/tenon --node ${process.execPath}`])
    expect(commands.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('plugin remove') || args.includes('plugin add')))).toBe(false)
    expect(deps.outLines.join('\n')).toContain('已启用 --codex 自动更新')
    expect(deps.outLines.join('\n')).toContain('输入 /hooks')
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    const frozenIndex = runtime.calls.journalWrites.findIndex((record) =>
      record.stableTarget?.tag === CURRENT_RELEASE_TAG
      && record.stableTarget.commit === 'a'.repeat(40))
    expect(frozenIndex).toBeGreaterThanOrEqual(0)
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'a'.repeat(64)}/payload`,
      { openBrowser: true, port: 43_210, transactionId: 'setup-test-transaction', expectedServerVersion: TENON_RELEASE_VERSION },
    ]])
  })

  test('native setup carries the frozen absolute Bash path into managed runtime activation', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      resolveTrustedCommand: (name) => name === 'bash' ? '/trusted/bin/bash' : 'git',
      resolveTrustedCommandBinding: (name) => ({
        executable: name === 'bash' ? '/trusted/bin/bash' : name,
        requestedPath: name === 'bash' ? '/trusted/bin/bash' : name,
        verify: () => true,
        assert: () => {},
      }),
    }, codexInstallExec)
    const runtime = fakeRuntimeInstaller()
    let activationScope: object | undefined
    const installer: RuntimeInstaller = {
      ...runtime.installer,
      withManagedTransaction: async (scope, operation) => {
        activationScope = scope
        return runtime.installer.withManagedTransaction(scope, operation)
      },
    }

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      installer,
      fakeDashboardStarter().starter,
      true,
      async () => ({ pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }),
    )).toBe(0)
    expect(Reflect.get(activationScope ?? {}, 'trustedBashPath')).toBe('/trusted/bin/bash')
  })

  // 首次安装没有可删除的登记：计划里不得出现 plugin remove，否则会在 marketplace add 之前
  // 先把宿主置空，制造断网即无法恢复的裸露窗口。
  test('Codex 没有已登记插件时执行不含 plugin remove 的正式 marketplace 安装计划', async () => {
    const deps = makeDeps()
    let inventoryReads = 0
    const exec: ExecStub = (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        inventoryReads += 1
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: inventoryReads === 1
              ? []
              : [{ pluginId: 'tenon@tenon', name: 'tenon', marketplaceName: 'tenon', version: TENON_RELEASE_VERSION, source: { path: '/installed/tenon' } }],
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const { env, calls } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, exec)
    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()

    expect(
      await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer, dashboard.starter),
      `${deps.errLines.join('\n')}\n${JSON.stringify(calls.exec)}`,
    ).toBe(0)
    expect(calls.exec.filter(([cmd, args]) => cmd === 'codex'
      && args[0] === 'plugin'
      && (args[1] === 'remove'
        || args[1] === 'add'
        || (args[1] === 'marketplace' && (args[2] === 'remove' || args[2] === 'add'))))
      .map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([
      ['codex', 'plugin marketplace remove tenon --json'],
      ['codex', `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`],
      ['codex', 'plugin add tenon@tenon --json'],
    ])
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    const frozenIndex = runtime.calls.journalWrites.findIndex((record) =>
      record.stableTarget?.tag === CURRENT_RELEASE_TAG
      && record.stableTarget.commit === 'a'.repeat(40))
    const firstMutationIndex = runtime.calls.journalWrites.findIndex((record) =>
      (record.hostSteps?.length ?? 0) > 0)
    expect(frozenIndex).toBeGreaterThanOrEqual(0)
    expect(firstMutationIndex).toBeGreaterThan(frozenIndex)
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'a'.repeat(64)}/payload`,
      { openBrowser: true, port: 18_765, transactionId: 'setup-test-transaction', expectedServerVersion: TENON_RELEASE_VERSION },
    ]])
  })

  test.each(
    (['setup', 'update'] as const).flatMap((operation) => (
      [
        'preparing-host',
        'candidate-resolved',
        'activating-runtime',
        'runtime-activated',
        'starting-dashboard',
        'dashboard-ready',
        'evidence-committed',
      ] as const
    ).map((phase) => [operation, phase] as const)),
  )(
    `single setup retires a real-shape v1.0.1 %s/%s WAL before publishing ${CURRENT_RELEASE_TAG}`,
    async (operation, phase) => {
    const deps = makeDeps()
    const legacyReleaseId = `sha256-${'c'.repeat(64)}`
    const legacyTransactionId = 'legacy-v101-transaction'
    const checkpoint = {
      selection: {
        version: 1 as const,
        revision: 0,
        activeRelease: null,
        previousRelease: null,
        updatedAt: '2026-07-23T00:00:00Z',
      },
      launchers: {
        tenon: { path: '/home/test/.local/bin/tenon', state: { kind: 'missing' as const } },
        hook: { path: '/home/test/.local/bin/tenon-hook', state: { kind: 'missing' as const } },
      },
    }
    const legacyActivation = {
      release: {
        version: 1 as const,
        releaseId: legacyReleaseId,
        payloadDigest: 'c'.repeat(64),
        createdAt: '2026-07-24T00:00:00Z',
        source: { host: 'codex' as const, pluginVersion: '1.0.1' },
      },
      selection: {
        version: 1 as const,
        revision: 1,
        activeRelease: legacyReleaseId,
        previousRelease: null,
        updatedAt: '2026-07-24T00:00:00Z',
      },
      releaseRoot: `/runtime/releases/${legacyReleaseId}`,
    }
    const hasActivation = phase === 'activating-runtime'
      || phase === 'runtime-activated'
      || phase === 'starting-dashboard'
      || phase === 'dashboard-ready'
      || phase === 'evidence-committed'
    const hasRunningDashboard = phase === 'starting-dashboard'
      || phase === 'dashboard-ready'
      || phase === 'evidence-committed'
    const legacyDashboard = {
      version: 1 as const,
      serverVersion: '',
      port: 18_765,
      pid: 901,
      releaseId: legacyReleaseId,
      stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
      transactionId: legacyTransactionId,
      owner: 'transaction' as const,
    }
    const legacyJournal = {
      version: 1 as const,
      transactionId: legacyTransactionId,
      operation,
      source: 'codex' as const,
      phase,
      startedAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-24T00:00:00Z',
      ...(phase === 'preparing-host'
        ? {
            hostSteps: [{
              id: operation === 'update' ? 'marketplace-refresh' : 'legacy-install',
              state: 'completed' as const,
            }],
          }
        : { candidateRoot: '/legacy/v101' }),
      ...(phase === 'activating-runtime' || hasActivation ? { activationCheckpoint: checkpoint } : {}),
      ...(phase === 'runtime-activated'
        || phase === 'starting-dashboard'
        || phase === 'dashboard-ready'
        || phase === 'evidence-committed'
        ? { activation: legacyActivation }
        : {}),
      ...(phase === 'dashboard-ready' || phase === 'evidence-committed'
        ? { dashboard: legacyDashboard }
        : {}),
    } as import('../runtime/installer.js').ManagedReleaseJournalRecord
    let running = hasRunningDashboard
      ? { ...legacyDashboard, serverVersion: '1.0.1' }
      : null
    const starts: string[] = []
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async (_deps, identity) => running === null || running.releaseId !== identity.releaseId
        ? null
        : {
            ownership: running,
            stop: async () => {
              running = null
              return { state: 'stopped' as const }
            },
          },
      start: async (_deps, payloadRoot, opts) => {
        starts.push(payloadRoot)
        const releaseId = payloadRoot.split('/').at(-2)!
        running = {
          version: 1,
          serverVersion: opts.expectedServerVersion ?? TENON_RELEASE_VERSION,
          port: opts.port ?? 18_765,
          pid: 902,
          releaseId,
          stateScopeId: `sha256-v1-${'8'.repeat(64)}`,
          transactionId: opts.transactionId!,
          owner: 'transaction',
        }
        return {
          state: 'ready' as const,
          session: {
            ownership: running,
            stop: async () => ({ state: 'stopped' as const }),
          },
        }
      },
    }
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const runtime = fakeRuntimeInstaller(
      false,
      hasActivation ? legacyReleaseId : null,
      null,
      legacyJournal,
      phase === 'activating-runtime' ? legacyActivation : undefined,
    )

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer, dashboard)).toBe(0)
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    expect(starts).toEqual([`/runtime/releases/sha256-${'a'.repeat(64)}/payload`])
    expect(deps.outLines.join('\n')).toContain(`v1.0.1 ${operation}/${phase} WAL 原子转换`)
    const convertedIndex = runtime.calls.journalWrites.findIndex((record) =>
      record.transactionId === legacyTransactionId
      && record.phase === 'preparing-host'
      && record.stableTarget?.tag === CURRENT_RELEASE_TAG)
    const activatedIndex = runtime.calls.journalWrites.findIndex((record) =>
      record.phase === 'runtime-activated'
      && record.activation?.release.source.pluginVersion === TENON_RELEASE_VERSION)
    expect(convertedIndex).toBeGreaterThanOrEqual(0)
    expect(activatedIndex).toBeGreaterThan(convertedIndex)
    },
  )

  test('single setup converts an empty v1.0.1 update WAL before the first legacy host step', async () => {
    const deps = makeDeps()
    const journal = {
      version: 1 as const,
      transactionId: 'legacy-v101-empty-update',
      operation: 'update' as const,
      source: 'codex' as const,
      phase: 'preparing-host' as const,
      startedAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-23T00:00:00Z',
    }
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const runtime = fakeRuntimeInstaller(false, null, null, journal)

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
    ), deps.errLines.join('\n')).toBe(0)
    expect(runtime.calls.journalWrites).toContainEqual(expect.objectContaining({
      transactionId: journal.transactionId,
      operation: 'setup',
      phase: 'preparing-host',
      stableTarget: { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) },
    }))
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
  })

  test('v1.0.1 starting-dashboard 的迟到进程由同一 successor transaction 精确停止', async () => {
    const deps = makeDeps()
    const legacyReleaseId = `sha256-${'c'.repeat(64)}`
    const transactionId = 'legacy-late-dashboard'
    const checkpoint = {
      selection: {
        version: 1 as const,
        revision: 0,
        activeRelease: legacyReleaseId,
        previousRelease: null,
        updatedAt: '2026-07-23T00:00:00Z',
      },
      launchers: {
        tenon: { path: '/home/test/.local/bin/tenon', state: { kind: 'missing' as const } },
        hook: { path: '/home/test/.local/bin/tenon-hook', state: { kind: 'missing' as const } },
      },
    }
    const activation = {
      release: {
        version: 1 as const,
        releaseId: legacyReleaseId,
        payloadDigest: 'c'.repeat(64),
        createdAt: '2026-07-24T00:00:00Z',
        source: { host: 'codex' as const, pluginVersion: '1.0.1' },
      },
      selection: {
        version: 1 as const,
        revision: 1,
        activeRelease: legacyReleaseId,
        previousRelease: null,
        updatedAt: '2026-07-24T00:00:00Z',
      },
      releaseRoot: `/runtime/releases/${legacyReleaseId}`,
    }
    const journal = {
      version: 1 as const,
      transactionId,
      operation: 'setup' as const,
      source: 'codex' as const,
      phase: 'starting-dashboard' as const,
      startedAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-24T00:00:00Z',
      candidateRoot: '/legacy/v101',
      activationCheckpoint: checkpoint,
      activation,
    }
    const lateIdentity = {
      version: 1 as const,
      serverVersion: '1.0.1',
      port: 18_765,
      pid: 901,
      releaseId: legacyReleaseId,
      stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
      transactionId,
      owner: 'transaction' as const,
    }
    let probes = 0
    let lateStopped = false
    let current: typeof lateIdentity | null = null
    const starts: string[] = []
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => {
        probes += 1
        if (probes <= 2) return null
        if (!lateStopped && starts.length === 0) return lateIdentity
        return current
      },
      adopt: async (_deps, identity) => identity.pid !== lateIdentity.pid
        ? null
        : {
            ownership: lateIdentity,
            stop: async () => {
              lateStopped = true
              current = null
              return { state: 'stopped' as const }
            },
          },
      start: async (_deps, payloadRoot, opts) => {
        starts.push(payloadRoot)
        current = {
          ...lateIdentity,
          serverVersion: opts.expectedServerVersion ?? TENON_RELEASE_VERSION,
          pid: 902,
          releaseId: payloadRoot.split('/').at(-2)!,
          stateScopeId: `sha256-v1-${'8'.repeat(64)}`,
          transactionId: opts.transactionId!,
        }
        return {
          state: 'ready' as const,
          session: {
            ownership: current,
            stop: async () => ({ state: 'stopped' as const }),
          },
        }
      },
    }
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const runtime = fakeRuntimeInstaller(false, legacyReleaseId, null, journal)

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer, dashboard)).toBe(0)
    expect(lateStopped).toBe(true)
    expect(starts).toEqual([`/runtime/releases/sha256-${'a'.repeat(64)}/payload`])
    const converted = runtime.calls.journalWrites.find((record) =>
      record.phase === 'preparing-host' && record.stableTarget?.tag === CURRENT_RELEASE_TAG)
    expect(converted?.transactionId).toBe(transactionId)
  })

  test('legacy update WAL 的 successor tag 无法证明时保留旧 Dashboard 和原 WAL', async () => {
    const deps = makeDeps()
    const legacyReleaseId = `sha256-${'c'.repeat(64)}`
    const transactionId = 'legacy-resolver-failure'
    const activation = {
      release: {
        version: 1 as const,
        releaseId: legacyReleaseId,
        payloadDigest: 'c'.repeat(64),
        createdAt: '2026-07-24T00:00:00Z',
        source: { host: 'codex' as const, pluginVersion: '1.0.1' },
      },
      selection: {
        version: 1 as const,
        revision: 1,
        activeRelease: legacyReleaseId,
        previousRelease: null,
        updatedAt: '2026-07-24T00:00:00Z',
      },
      releaseRoot: `/runtime/releases/${legacyReleaseId}`,
    }
    const journal = {
      version: 1 as const,
      transactionId,
      operation: 'update' as const,
      source: 'codex' as const,
      phase: 'runtime-activated' as const,
      startedAt: '2026-07-23T00:00:00Z',
      updatedAt: '2026-07-24T00:00:00Z',
      candidateRoot: '/legacy/v101',
      activationCheckpoint: {
        selection: {
          version: 1 as const,
          revision: 0,
          activeRelease: null,
          previousRelease: null,
          updatedAt: '2026-07-23T00:00:00Z',
        },
        launchers: {
          tenon: { path: '/home/test/.local/bin/tenon', state: { kind: 'missing' as const } },
          hook: { path: '/home/test/.local/bin/tenon-hook', state: { kind: 'missing' as const } },
        },
      },
      activation,
    }
    let dashboardInspections = 0
    let dashboardStops = 0
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => {
        dashboardInspections += 1
        return {
          version: 1,
          serverVersion: '1.0.1',
          port: 18_765,
          pid: 901,
          releaseId: legacyReleaseId,
          stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
          transactionId,
          owner: 'transaction',
        }
      },
      adopt: async () => ({
        ownership: {
          version: 1,
          serverVersion: '1.0.1',
          port: 18_765,
          pid: 901,
          releaseId: legacyReleaseId,
          stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
          transactionId,
          owner: 'transaction',
        },
        stop: async () => {
          dashboardStops += 1
          return { state: 'stopped' as const }
        },
      }),
      start: async () => ({ state: 'failed' as const, detail: 'must not start' }),
    }
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const baseRun = env.runCommand
    env.runCommand = (cmd, args) => cmd === 'git' && args[0] === 'ls-remote'
      ? { code: 7, stdout: '', stderr: 'release unavailable' }
      : baseRun(cmd, args)
    const runtime = fakeRuntimeInstaller(false, legacyReleaseId, null, journal)

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer, dashboard)).toBe(1)
    expect(runtime.calls.activations).toEqual([])
    expect(runtime.calls.journalWrites).toEqual([])
    expect(dashboardInspections).toBe(0)
    expect(dashboardStops).toBe(0)
  })

  test(`单次 installer 将 v1.0.1 pending receipt 桥接到已绑定的 ${CURRENT_RELEASE_TAG} host/runtime`, async () => {
    const deps = makeDeps()
    const oldReleaseId = `sha256-${'c'.repeat(64)}`
    const newReleaseId = `sha256-${'a'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const receipt = JSON.stringify({
      version: 3,
      transactionId: 'legacy-receipt-transaction',
      state: 'cleanup-pending',
      host: 'codex',
      conflictPluginId: 'pipeline-lite@pipeline-lite',
      conflictScopes: ['user'],
      releaseId: oldReleaseId,
      releaseRoot: `/runtime/releases/${oldReleaseId}/payload`,
      candidateRoot: '/legacy/v101',
      createdAtEpoch: 1_700_000_000,
      updatedAt: '2026-07-26T00:00:00Z',
    })
    const inventory = JSON.stringify({
      installed: [
        { pluginId: 'pipeline-lite@pipeline-lite', enabled: true, source: { path: '/legacy/v101' } },
        {
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          enabled: true,
          version: TENON_RELEASE_VERSION,
          source: { path: '/installed/tenon' },
        },
      ],
    })
    const { env, calls } = spyEnv({
      pathExists: (path) => path === receiptPath || path === proofPath || setupPathExists(path),
      readText: (path) => {
        if (path === receiptPath) return receipt
        if (path === proofPath) {
          return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${oldReleaseId}\nrelease_root=/runtime/releases/${oldReleaseId}/payload\n`
        }
        return setupReadText(path)
      },
    }, (cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: inventory, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    let running = {
      version: 1 as const,
      serverVersion: '1.0.1',
      port: 18_765,
      pid: 901,
      releaseId: oldReleaseId,
      stateScopeId: `sha256-v1-${'9'.repeat(64)}`,
      transactionId: 'old-dashboard',
    }
    let oldDashboardStops = 0
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async (_deps, identity) => identity.pid !== running.pid
        ? null
        : {
            ownership: running,
            stop: async () => {
              oldDashboardStops += 1
              running = null as unknown as typeof running
              return { state: 'stopped' as const }
            },
          },
      start: async (_deps, payloadRoot, opts) => {
        running = {
          version: 1,
          serverVersion: opts.expectedServerVersion ?? TENON_RELEASE_VERSION,
          port: opts.port ?? 18_765,
          pid: 902,
          releaseId: payloadRoot.split('/').at(-2)!,
          stateScopeId: `sha256-v1-${'8'.repeat(64)}`,
          transactionId: opts.transactionId!,
        }
        return {
          state: 'ready' as const,
          session: { ownership: running, stop: async () => ({ state: 'stopped' as const }) },
        }
      },
    }
    const runtime = fakeRuntimeInstaller(false, oldReleaseId, oldReleaseId, null, undefined, '1.0.1')

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      runtime.installer,
      dashboard,
      true,
      async () => ({ pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }),
    ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    expect(oldDashboardStops).toBe(1)
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json')).toBe(false)
    const receiptWrites = calls.writeText
      .filter(([path]) => path === receiptPath)
      .map(([, text]) => JSON.parse(text))
    expect(receiptWrites.at(-1)).toMatchObject({
      version: 4,
      state: 'cleanup-pending',
      releaseId: newReleaseId,
      stableTarget: { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) },
    })
  })

  test('legacy v3 receipt 在 cleanup 前升级，completed v4 可由下一次命令继续读取', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const receipt = JSON.stringify({
      version: 3,
      transactionId: 'legacy-v3-cleanup',
      state: 'cleanup-pending',
      host: 'codex',
      conflictPluginId: 'pipeline-lite@pipeline-lite',
      conflictScopes: ['user'],
      releaseId,
      releaseRoot: `/runtime/releases/${releaseId}/payload`,
      candidateRoot: '/installed/tenon',
      createdAtEpoch: 1_700_000_000,
      updatedAt: '2026-07-26T00:00:00Z',
    })
    let removed = false
    const inventory = () => JSON.stringify({
      installed: [
        ...(!removed
          ? [{ pluginId: 'pipeline-lite@pipeline-lite', enabled: true, source: { path: '/legacy/v101' } }]
          : []),
        {
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          enabled: true,
          version: TENON_RELEASE_VERSION,
          source: { path: '/installed/tenon' },
        },
      ],
    })
    const { env, calls } = spyEnv({
      pathExists: () => true,
      readText: (path) => {
        if (path === receiptPath) return receipt
        if (path === proofPath) {
          return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
        }
        return setupReadText(path)
      },
    }, (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: inventory(), stderr: '' }
      }
      if (cmd === 'codex' && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json') {
        removed = true
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller(false, null, releaseId, null, undefined, TENON_RELEASE_VERSION)
    const dashboard = fakeDashboardStarter(false, releaseId)
    const proofEvents: string[] = []
    const baseWriteTextAtomic = env.writeTextAtomic
    env.writeTextAtomic = (path, text) => {
      if (path === receiptPath && JSON.parse(text).state === 'completed') proofEvents.push('completed')
      baseWriteTextAtomic(path, text)
    }
    let candidateProofs = 0

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      true,
      async () => {
        candidateProofs += 1
        proofEvents.push(`candidate:${candidateProofs}`)
        return { pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }
      },
    )).toBe(0)
    const receiptWrites = calls.writeText.filter(([path]) => path === receiptPath)
    const upgraded = JSON.parse(receiptWrites[0]![1])
    const completedText = receiptWrites.at(-1)![1]
    const completed = JSON.parse(completedText)
    expect(upgraded).toMatchObject({ state: 'cleanup-pending', stableTarget: { tag: CURRENT_RELEASE_TAG } })
    expect(completed).toMatchObject({
      version: 4,
      state: 'completed',
      conflictScopes: [],
      stableTarget: { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) },
    })
    expect(proofEvents).toEqual(['candidate:1', 'candidate:2', 'completed'])
    env.readText = (path) => path === receiptPath ? completedText : setupReadText(path)
    env.readTextState = (path) => path === receiptPath
      ? { state: 'ok', text: completedText }
      : { state: 'missing' }
    expect(readHostPluginConvergenceReceipt(env, 'codex')).toMatchObject({
      state: 'receipt',
      receipt: { state: 'completed', stableTarget: { tag: CURRENT_RELEASE_TAG } },
    })
  })

  test('legacy plugin already absent supersedes a stale pending receipt with current completed identity', () => {
    const deps = makeDeps()
    const oldReleaseId = `sha256-${'c'.repeat(64)}`
    const newReleaseId = `sha256-${'a'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const oldReceipt = `${JSON.stringify({
      version: 4,
      transactionId: 'old-transaction',
      state: 'cleanup-pending',
      host: 'codex',
      conflictPluginId: 'pipeline-lite@pipeline-lite',
      conflictScopes: ['user'],
      releaseId: oldReleaseId,
      releaseRoot: `/runtime/releases/${oldReleaseId}/payload`,
      candidateRoot: '/legacy/v101',
      stableTarget: { version: '1.0.1', tag: 'v1.0.1', commit: 'c'.repeat(40) },
      createdAtEpoch: 1_700_000_000,
      updatedAt: '2026-07-26T00:00:00Z',
    })}\n`
    const { env, calls } = spyEnv({
      pathExists: (path) => path === receiptPath,
      readText: (path) => path === receiptPath ? oldReceipt : undefined,
    })
    const inventory = parseHostPluginInventory('codex', JSON.stringify({
      installed: [{
        pluginId: 'tenon@tenon',
        name: 'tenon',
        marketplaceName: 'tenon',
        enabled: true,
        version: TENON_RELEASE_VERSION,
        source: { path: '/installed/tenon' },
      }],
    }))
    expect(inventory).not.toBeNull()
    const activation = {
      release: {
        version: 1 as const,
        releaseId: newReleaseId,
        payloadDigest: 'a'.repeat(64),
        createdAt: '2026-08-08T00:00:00Z',
        source: { host: 'codex' as const, pluginVersion: TENON_RELEASE_VERSION },
      },
      selection: {
        version: 1 as const,
        revision: 2,
        activeRelease: newReleaseId,
        previousRelease: oldReleaseId,
        updatedAt: '2026-08-08T00:00:00Z',
      },
      releaseRoot: `/runtime/releases/${newReleaseId}`,
    }

    expect(recordPendingHostPluginConflict(
      deps,
      env,
      'codex',
      inventory!,
      activation,
      '/installed/tenon',
      'new-transaction',
      { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) },
    )).toBe(true)
    const written = calls.writeText
      .filter(([path]) => path === receiptPath)
      .map(([, text]) => JSON.parse(text))
    expect(written.at(-1)).toMatchObject({
      version: 4,
      transactionId: 'new-transaction',
      state: 'completed',
      conflictScopes: [],
      releaseId: newReleaseId,
      candidateRoot: '/installed/tenon',
      stableTarget: { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG },
    })
  })

  test.each([
    ['the same transaction and release', 'current-transaction', true],
    ['a previous transaction for the same release', 'completed-transaction', true],
    ['the same transaction but a different release', 'current-transaction', false],
  ] as const)(
    'completed receipt handling remains fail-closed for %s',
    (_label, completedTransactionId, shouldReopen) => {
      const deps = makeDeps()
      const releaseId = `sha256-${'a'.repeat(64)}`
      const completedReleaseId = shouldReopen ? releaseId : `sha256-${'b'.repeat(64)}`
      const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
      const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
      const stableTarget = {
        version: TENON_RELEASE_VERSION,
        tag: CURRENT_RELEASE_TAG,
        commit: 'a'.repeat(40),
      }
      const completed = JSON.stringify({
        version: 4,
        transactionId: completedTransactionId,
        state: 'completed',
        host: 'codex',
        conflictPluginId: 'pipeline-lite@pipeline-lite',
        conflictScopes: [],
        releaseId: completedReleaseId,
        releaseRoot: `/runtime/releases/${completedReleaseId}/payload`,
        candidateRoot: '/installed/tenon',
        stableTarget,
        createdAtEpoch: 1_700_000_000,
        updatedAt: '2026-08-08T00:00:00Z',
      })
      const { env, calls } = spyEnv({
        pathExists: (path) => path === receiptPath,
        readText: (path) => path === receiptPath ? completed : setupReadText(path),
      })
      const inventory = parseHostPluginInventory('codex', JSON.stringify({
        installed: [
          {
            pluginId: 'tenon@tenon',
            name: 'tenon',
            marketplaceName: 'tenon',
            enabled: true,
            scope: 'user',
            version: stableTarget.version,
            source: { path: '/installed/tenon' },
          },
          {
            pluginId: 'pipeline-lite@pipeline-lite',
            enabled: true,
            scope: 'user',
            source: { path: '/legacy/re-enabled' },
          },
        ],
      }))
      expect(inventory).not.toBeNull()
      const activation = {
        release: {
          version: 2 as const,
          releaseId,
          payloadDigest: 'a'.repeat(64),
          createdAt: '2026-08-08T00:00:00Z',
          source: { host: 'codex' as const, pluginVersion: stableTarget.version },
          stableTarget,
        },
        selection: {
          version: 1 as const,
          revision: 2,
          activeRelease: releaseId,
          previousRelease: null,
          updatedAt: '2026-08-08T00:00:00Z',
        },
        releaseRoot: `/runtime/releases/${releaseId}`,
      }

      expect(recordPendingHostPluginConflict(
        deps,
        env,
        'codex',
        inventory!,
        activation,
        '/installed/tenon',
        'current-transaction',
        stableTarget,
      )).toBe(shouldReopen)

      const written = calls.writeText
        .filter(([path]) => path === receiptPath)
        .map(([, text]) => JSON.parse(text))
      if (!shouldReopen) {
        expect(written).toEqual([])
        expect(deps.errLines.join('\n')).toContain('同一 transaction id')
        return
      }
      expect(written.at(-1)).toMatchObject({
        version: 4,
        transactionId: 'current-transaction',
        state: 'cleanup-pending',
        conflictScopes: ['user'],
        releaseId,
        stableTarget,
      })
    },
  )

  test('初始宿主 inventory 命令失败时 fail closed，不继续 marketplace 或 runtime mutation', async () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv(
      { pathExists: setupPathExists, readText: setupReadText },
      (cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
        ? { code: 9, stdout: '', stderr: 'inventory unavailable' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    expect(calls.exec.filter(([cmd]) => cmd === 'codex')).toEqual([
      ['codex', ['plugin', 'list', '--json']],
    ])
    expect(calls.exec.filter(([cmd]) => cmd === 'git').every(([, args]) =>
      args[0] === 'ls-remote'
      || args[0] === 'init'
      || (args[0] === '-C' && args[1]?.includes('/tenon-stable-tag-') === true))).toBe(true)
    expect(runtime.calls.activations).toEqual([])
    expect(deps.errLines.join('\n')).toContain('inventory')
  })

  test('receipt 路径存在但不可读时 fail closed，不继续宿主或 runtime mutation', async () => {
    const deps = makeDeps()
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env, calls } = spyEnv({
      pathExists: (path) => path === receiptPath || setupPathExists(path),
      readText: (path) => path === receiptPath ? undefined : setupReadText(path),
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    expect(calls.exec).toEqual([])
    expect(runtime.calls.activations).toEqual([])
    expect(deps.errLines.join('\n')).toContain('receipt')
  })

  // 降级到旧 tenon 后仍然拒绝解释更新版 receipt 是对的，但不能变成砖头：必须说明这是版本问题、
  // 可以删哪个文件、删了会失去什么。
  test('receipt 版本高于当前 tenon 时给出文件路径、删除后果与宿主检查命令', async () => {
    const deps = makeDeps()
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env, calls } = spyEnv({
      pathExists: (path) => path === receiptPath || setupPathExists(path),
      readText: (path) => path === receiptPath
        ? JSON.stringify({
            version: 5,
            transactionId: 'future-transaction',
            state: 'cleanup-pending',
            host: 'codex',
            conflictPluginId: 'pipeline-lite@pipeline-lite',
            conflictScopes: ['user'],
            releaseId: `sha256-${'a'.repeat(64)}`,
            releaseRoot: '/runtime/releases/payload',
            candidateRoot: '/installed/tenon',
            createdAtEpoch: 1_770_000_000,
            updatedAt: '2026-09-05T00:00:00Z',
          })
        : setupReadText(path),
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    expect(calls.exec).toEqual([])
    expect(runtime.calls.activations).toEqual([])
    const err = deps.errLines.join('\n')
    expect(err).toContain('迁移 receipt 版本 5 高于当前 tenon 支持的最高版本 4')
    expect(err).toContain(receiptPath)
    expect(err).toContain(`rm ${receiptPath}`)
    expect(err).toContain('codex plugin list')
    expect(err).toContain('不会再被自动完成')
  })

  test('receipt 结构非法时同样给出可删除的文件路径，而不是只说非法', async () => {
    const deps = makeDeps()
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env } = spyEnv({
      pathExists: (path) => path === receiptPath || setupPathExists(path),
      readText: (path) => path === receiptPath ? '{"version":4}' : setupReadText(path),
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    const err = deps.errLines.join('\n')
    expect(err).toContain(`迁移 receipt 非法：${receiptPath}`)
    expect(err).toContain(`rm ${receiptPath}`)
  })

  test('Codex 冲突登记先发布并验证 Tenon，再写 cleanup-pending；同一会话绝不提前删除旧入口', async () => {
    const deps = makeDeps()
    const exec: ExecStub = (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'pipeline-lite@pipeline-lite',
                name: 'pipeline-lite',
                marketplaceName: 'pipeline-lite',
                enabled: true,
                source: { path: '/old/workflow' },
              },
              {
                pluginId: 'tenon@tenon',
                name: 'tenon',
                marketplaceName: 'tenon',
                enabled: true,
                version: TENON_RELEASE_VERSION,
                source: { path: '/installed/tenon' },
              },
            ],
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const { env, calls } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
    }, exec)
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(0)
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json')).toBe(false)
    expect(calls.exec.some(([cmd, args]) => cmd === 'bash'
      && args.join(' ') === `/installed/tenon/tools/verify-skills.sh --quiet --root /installed/tenon --node ${process.execPath}`)).toBe(true)
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    const receiptPath = join(
      resolveRuntimePaths({ homeDir: '/home/test', env: {} }).migrationsRoot,
      'host-plugin-convergence',
      'codex.json',
    )
    const receiptWrite = calls.writeText.find(([path]) => path === receiptPath)
    expect(receiptWrite).toBeDefined()
    expect(JSON.parse(receiptWrite?.[1] ?? '{}')).toMatchObject({
      version: 4,
      transactionId: 'setup-test-transaction',
      state: 'cleanup-pending',
      host: 'codex',
      releaseId: `sha256-${'a'.repeat(64)}`,
      stableTarget: {
        version: TENON_RELEASE_VERSION,
        tag: CURRENT_RELEASE_TAG,
        commit: 'a'.repeat(40),
      },
    })
    expect(deps.outLines.join('\n')).toContain('新宿主会话')
  })

  test('cleanup-pending 的官方 remove 失败时先失败关闭，不安装候选也不发布新 runtime', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const receipt = JSON.stringify({
      version: 2,
      state: 'cleanup-pending',
      host: 'codex',
      conflictPluginId: 'pipeline-lite@pipeline-lite',
      conflictScopes: ['user'],
      releaseId,
      releaseRoot: `/runtime/releases/${releaseId}/payload`,
      candidateRoot: '/installed/tenon',
      createdAtEpoch: 1_700_000_000,
      updatedAt: '2026-07-26T00:00:00Z',
    })
    const inventory = JSON.stringify({
      installed: [
        { pluginId: 'pipeline-lite@pipeline-lite', enabled: true, source: { path: '/old/workflow' } },
        {
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          enabled: true,
          version: TENON_RELEASE_VERSION,
          source: { path: '/installed/tenon' },
        },
      ],
    })
    const { env, calls } = spyEnv({
      pathExists: () => true,
      readText: (path) => {
        if (path === receiptPath) return receipt
        if (path === proofPath) {
          return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
        }
        return setupReadText(path)
      },
    }, (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: inventory, stderr: '' }
      }
      if (cmd === 'codex' && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json') {
        return { code: 9, stdout: '', stderr: 'permission denied' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller(false, null, releaseId, null, undefined, TENON_RELEASE_VERSION)

    const dashboard = fakeDashboardStarter(false, releaseId)
    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      true,
      async () => ({ pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }),
    )).toBe(1)
    expect(runtime.calls.activations).toEqual([])
    const commands = calls.exec.map(([cmd, args]) => `${cmd} ${args.join(' ')}`)
    const removeIndex = commands.indexOf('codex plugin remove pipeline-lite@pipeline-lite --json')
    expect(removeIndex).toBeGreaterThan(commands.indexOf('codex plugin list --json'))
    expect(commands.slice(0, removeIndex)).toContain('git -C /installed/tenon rev-parse HEAD')
    expect(deps.errLines.join('\n')).toContain('permission denied')
  })

  test('cleanup-pending 在冻结 Node 漂移时保留 receipt，且零 legacy host mutation', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const receipt = JSON.stringify({
      version: 4,
      transactionId: 'trusted-node-drift',
      state: 'cleanup-pending',
      host: 'codex',
      conflictPluginId: 'pipeline-lite@pipeline-lite',
      conflictScopes: ['user'],
      releaseId,
      releaseRoot: `/runtime/releases/${releaseId}/payload`,
      candidateRoot: '/installed/tenon',
      stableTarget: { version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) },
      createdAtEpoch: 1_700_000_000,
      updatedAt: '2026-07-26T00:00:00Z',
    })
    const inventory = JSON.stringify({
      installed: [
        { pluginId: 'pipeline-lite@pipeline-lite', enabled: true, source: { path: '/old/workflow' } },
        {
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          enabled: true,
          version: TENON_RELEASE_VERSION,
          source: { path: '/installed/tenon' },
        },
      ],
    })
    const { env, calls } = spyEnv({
      pathExists: (path) => path === receiptPath || path === proofPath || setupPathExists(path),
      readText: (path) => {
        if (path === receiptPath) return receipt
        if (path === proofPath) {
          return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
        }
        return setupReadText(path)
      },
      resolveTrustedCommandBinding: (name) => ({
        executable: `/trusted/${name}`,
        requestedPath: `/trusted/${name}`,
        verify: () => name !== 'node',
        assert: () => {
          if (name === 'node') throw new Error('trusted Node identity drifted')
        },
      }),
    }, (cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: inventory, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    const runtime = fakeRuntimeInstaller(false, null, releaseId, null, undefined, TENON_RELEASE_VERSION)
    const guardedInstaller: RuntimeInstaller = {
      ...runtime.installer,
      inspect: async (scope) => {
        scope.verifyTrustedNode?.()
        return runtime.installer.inspect(scope)
      },
      withManagedTransaction: async (scope, operation) => {
        scope.verifyTrustedNode?.()
        return runtime.installer.withManagedTransaction(scope, operation)
      },
    }

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      guardedInstaller,
      fakeDashboardStarter(false, releaseId).starter,
      true,
      async () => ({ pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }),
    )).toBe(1)
    expect(calls.exec.some(([, args]) =>
      args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json')).toBe(false)
    expect(calls.writeText.filter(([path]) => path === receiptPath)).toEqual([])
    expect(deps.errLines.join('\n')).toContain('trusted Node identity drifted')
  })

  test('同 release 的旧 session proof 不得冒用为本次 receipt 之后的新会话', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const receipt = JSON.stringify({
      version: 2,
      state: 'cleanup-pending',
      host: 'codex',
      conflictPluginId: 'pipeline-lite@pipeline-lite',
      conflictScopes: ['user'],
      releaseId,
      releaseRoot: `/runtime/releases/${releaseId}/payload`,
      candidateRoot: '/installed/tenon',
      createdAtEpoch: 1_800_000_000,
      updatedAt: '2027-01-15T08:00:00Z',
    })
    const { env, calls } = spyEnv({
      pathExists: (path) => path === receiptPath || path === proofPath || setupPathExists(path),
      readText: (path) => {
        if (path === receiptPath) return receipt
        if (path === proofPath) {
          return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
        }
        return setupReadText(path)
      },
    }, codexInstallExec)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, null, undefined, TENON_RELEASE_VERSION)
    const dashboard = fakeDashboardStarter(false, releaseId)

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      true,
      async () => ({ pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }),
    )).toBe(0)
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
    expect(runtime.calls.activations).toEqual([])
    expect(deps.outLines.join('\n')).toContain('等待新宿主会话')
    expect(deps.outLines.join('\n')).toContain('http://127.0.0.1:18765/')
  })

  test('Claude 仅 user scope Tenon 时拒绝清理 project/local 旧登记', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'a'.repeat(64)}`
    const legacyId = String.fromCharCode(
      112, 105, 112, 101, 108, 105, 110, 101, 45, 108, 105, 116, 101,
      64,
      112, 105, 112, 101, 108, 105, 110, 101, 45, 108, 105, 116, 101,
    )
    const paths = resolveRuntimePaths({ homeDir: '/home/test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'claude.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const receipt = JSON.stringify({
      version: 2,
      state: 'cleanup-pending',
      host: 'claude',
      conflictPluginId: legacyId,
      conflictScopes: ['project', 'local'],
      releaseId,
      releaseRoot: `/runtime/releases/${releaseId}/payload`,
      candidateRoot: '/installed/tenon',
      createdAtEpoch: 1_700_000_000,
      updatedAt: '2026-07-26T00:00:00Z',
    })
    let removedScopes = 0
    const { env, calls } = spyEnv({
      pathExists: () => true,
      readText: (path) => {
        if (path === receiptPath) return receipt
        if (path === proofPath) {
          return `version=2\nloaded_at_epoch=1800000000\nhost=claude\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
        }
        return setupReadText(path)
      },
    }, (cmd, args) => {
      if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
        return {
          code: 0,
          stdout: JSON.stringify([
            ...(removedScopes < 2
              ? [
                  { id: legacyId, enabled: true, scope: 'project' },
                  { id: legacyId, enabled: true, scope: 'local' },
                ]
              : []),
            { id: 'tenon@tenon', enabled: true, scope: 'user', version: TENON_RELEASE_VERSION, installPath: '/installed/tenon' },
          ]),
          stderr: '',
        }
      }
      if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'uninstall') {
        removedScopes += 1
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller(false, null, releaseId, null, undefined, TENON_RELEASE_VERSION, 'claude')
    const dashboard = fakeDashboardStarter(false, releaseId)

    expect(await cmdSetupHost(
      deps,
      'claude',
      { claude: true },
      env,
      runtime.installer,
      dashboard.starter,
      true,
      async () => ({ pluginVersion: TENON_RELEASE_VERSION, payloadDigest: 'a'.repeat(64) }),
    )).toBe(1)
    expect(calls.exec.some(([cmd, args]) => cmd === 'claude'
      && args[0] === 'plugin' && args[1] === 'uninstall')).toBe(false)
    expect(deps.errLines.join('\n')).toContain('project scope')
  })

  test('activation 后 receipt 原子写失败会在同一 managed transaction 精确回滚', async () => {
    const deps = makeDeps()
    const legacyId = String.fromCharCode(
      112, 105, 112, 101, 108, 105, 110, 101, 45, 108, 105, 116, 101,
      64,
      112, 105, 112, 101, 108, 105, 110, 101, 45, 108, 105, 116, 101,
    )
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      writeTextAtomic: () => { throw new Error('disk full') },
    }, (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: [
              { pluginId: legacyId, enabled: true, source: { path: '/old/workflow' } },
              {
                pluginId: 'tenon@tenon',
                name: 'tenon',
                marketplaceName: 'tenon',
                enabled: true,
                version: TENON_RELEASE_VERSION,
                source: { path: '/installed/tenon' },
              },
            ],
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    expect(runtime.calls.reverts).toEqual([['/home/test', `sha256-${'a'.repeat(64)}`]])
    expect(deps.errLines.join('\n')).toContain('disk full')
  })

  test('Codex 已登记但缺 runtime bootstrap 时拒绝复用，并回到正式安装计划', async () => {
    const deps = makeDeps()
    let inventoryReads = 0
    const exec: ExecStub = (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        inventoryReads += 1
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: [{
              pluginId: 'tenon@tenon', name: 'tenon', marketplaceName: 'tenon', version: TENON_RELEASE_VERSION,
              source: { path: inventoryReads === 1 ? '/stale/tenon' : '/installed/tenon' },
            }],
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const { env, calls } = spyEnv({
      pathExists: (path) =>
        setupPathExists(path) && path !== '/stale/tenon/runtime/tenon-bootstrap.mjs',
      readText: setupReadText,
    }, exec)
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(0)
    expect(calls.exec.filter(([cmd, args]) => cmd === 'codex'
      && args[0] === 'plugin'
      && (args[1] === 'remove'
        || args[1] === 'add'
        || (args[1] === 'marketplace' && (args[2] === 'remove' || args[2] === 'add'))))
      .map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([
      ['codex', 'plugin remove tenon@tenon --json'],
      ['codex', 'plugin marketplace remove tenon --json'],
      ['codex', `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`],
      ['codex', 'plugin add tenon@tenon --json'],
    ])
    expect(deps.outLines.join('\n')).toContain('不完整或未通过校验')
  })

  test('adapter 不能借 --auto-update 伪装成有自己的发布通道', () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv()

    expect(cmdSetupHost(deps, 'cursor', { cursor: true, autoUpdate: true }, env)).toBe(1)
    expect(calls.exec).toEqual([])
    expect(calls.writeText).toEqual([])
    expect(deps.errLines.join('\n')).toContain('由承载它的 Codex 或 Claude 插件负责')
  })
})

describe('①b Codex 旧 hook 迁移 —— 插件是唯一 hook 所有者', () => {
  test('只剥离旧 adapter 的四个精确脚本，保留同组和其他事件中的用户 hooks', () => {
    const legacy = JSON.stringify({
      retained_setting: 'keep',
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [
            { type: 'command', command: 'bash "/old/pipeline/adapters/codex/hooks/inject.sh" SessionStart' },
            { type: 'command', command: 'bash "/user/hooks/session-context.sh"' },
          ],
        }],
        UserPromptSubmit: [{
          hooks: [{ type: 'command', command: 'bash "/old/pipeline/adapters/codex/hooks/prompt.sh" UserPromptSubmit' }],
        }],
        PostToolUse: [{
          hooks: [{ type: 'command', command: 'bash "/user/hooks/audit.sh"' }],
        }],
      },
    })

    const migrated = scrubLegacyCodexAdapterHooks(legacy)
    expect(migrated.removed).toBe(2)
    const parsed = JSON.parse(migrated.content) as {
      retained_setting: string
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(parsed.retained_setting).toBe('keep')
    expect(parsed.hooks.SessionStart?.[0]?.hooks.map((hook) => hook.command)).toEqual([
      'bash "/user/hooks/session-context.sh"',
    ])
    expect(parsed.hooks.UserPromptSubmit).toBeUndefined()
    expect(parsed.hooks.PostToolUse?.[0]?.hooks.map((hook) => hook.command)).toEqual([
      'bash "/user/hooks/audit.sh"',
    ])
  })

  test('malformed or unrelated global config is not reformatted or overwritten', () => {
    expect(scrubLegacyCodexAdapterHooks('{not json')).toEqual({ content: '{not json', removed: 0 })
    const unrelated = '{\n  "hooks": {"SessionStart": [{"hooks": [{"command": "bash /user/adapter.sh"}]}]}\n}\n'
    expect(scrubLegacyCodexAdapterHooks(unrelated)).toEqual({ content: unrelated, removed: 0 })
  })

  test('setup migrates old global registration before publishing the native runtime', async () => {
    const codexHooks = '/home/test/.codex/hooks.json'
    const legacy = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'bash "/old/pipeline/adapters/codex/hooks/inject.sh" SessionStart' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'bash "/user/hooks/preflight.sh"' }] }],
      },
    })
    const deps = makeDeps()
    const { env, calls } = spyEnv({
      pathExists: (path) => setupPathExists(path),
      readText: (path) => path === codexHooks ? legacy : setupReadText(path),
    }, codexInstallExec)
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(0)
    expect(calls.writeText).toHaveLength(1)
    expect(calls.writeText[0]?.[0]).toBe(codexHooks)
    const migrated = JSON.parse(calls.writeText[0]?.[1] ?? '{}') as { hooks?: Record<string, unknown> }
    expect(migrated.hooks?.SessionStart).toBeUndefined()
    expect(migrated.hooks?.PreToolUse).toBeDefined()
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    expect(deps.outLines.join('\n')).toContain('已迁移 1 个旧版 Codex hook')
  })
})

describe('upstream skills in native setup', () => {
  test('fetches into the host root after candidate resolution and re-verifies assets even for a reused verified root', async () => {
    const deps = makeDeps()
    const exactExec: ExecStub = (cmd, args) => {
      const text = `${cmd} ${args.join(' ')}`
      if (text === 'git -C /installed/tenon rev-parse HEAD') return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (text === 'git -C /installed/tenon remote get-url origin') {
        return { code: 0, stdout: 'https://github.com/jefferysha/tenon.git\n', stderr: '' }
      }
      return codexInstallExec(cmd, args)
    }
    const { env, calls } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, exactExec)
    const marks: number[] = []
    const inputs: UpstreamSkillInstallInput[] = []
    env.installUpstreamSkills = async (input) => {
      marks.push(calls.exec.length)
      inputs.push(input)
      return { report: { version: 1, at: '2026-09-15T08:00:00.000Z', host: 'codex', results: [] }, lockWritten: false }
    }
    const runtime = fakeRuntimeInstaller(true)

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    expect(deps.outLines.join('\n')).toContain('复用宿主登记的安装')
    expect(inputs.map((input) => [input.pluginRoot, input.previousRoot, input.host])).toEqual([['/installed/tenon', null, 'codex']])
    const mark = marks[0] ?? -1
    const indexes = (match: (cmd: string, args: readonly string[]) => boolean): number[] =>
      calls.exec.flatMap(([cmd, args], index) => (match(cmd, args) ? [index] : []))
    const verifications = indexes((cmd, args) => cmd === 'bash' && args[0] === '/installed/tenon/tools/verify-skills.sh')
    const inventories = indexes((cmd, args) => cmd.endsWith('codex') && args.join(' ') === 'plugin list --json')
    expect(inventories.some((index) => index < mark)).toBe(true)
    expect(verifications.some((index) => index < mark)).toBe(true)
    expect(verifications.some((index) => index >= mark)).toBe(true)
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
  })
})

describe('②managed runtime 发布边界', () => {
  test('候选 release 校验/发布失败时，不把宿主 checkout 伪装为可运行入口', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const runtime = fakeRuntimeInstaller(true)

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer)).toBe(1)
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    expect(deps.errLines.join('\n')).toContain('当前已验证 runtime 保持不变')
    expect(deps.errLines.join('\n')).toContain('宿主插件登记由宿主 CLI 独立管理')
    expect(deps.errLines.join('\n')).toContain('仅补偿自己的 managed transaction')
    expect(deps.outLines.join('\n')).not.toContain('已把 pipeline 软链')
  })

  test('Dashboard starter 抛错时仍补偿精确 activation 并恢复 previous 服务', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const previousRelease = `sha256-${'c'.repeat(64)}`
    const runtime = fakeRuntimeInstaller(false, previousRelease)
    const starts: string[] = []
    let running: Awaited<ReturnType<ReleasedDashboardStarter['inspect']>> = null
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async () => null,
      start: async (_deps, payloadRoot, opts) => {
        starts.push(payloadRoot)
        if (starts.length === 1) return { state: 'failed', detail: 'spawn failed' }
        running = {
          version: 1,
          port: opts.port ?? 18_765,
          pid: 654,
          releaseId: previousRelease,
          stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
          ...(opts.transactionId === undefined ? {} : { transactionId: opts.transactionId }),
        }
        return {
          state: 'ready',
          session: {
            ownership: running,
            stop: async () => ({ state: 'stopped' as const }),
          },
        }
      },
    }

    expect(await cmdSetupHost(deps, 'codex', { codex: true }, env, runtime.installer, dashboard)).toBe(1)
    expect(runtime.calls.reverts).toEqual([[
      '/home/test',
      `sha256-${'a'.repeat(64)}`,
    ]])
    expect(starts).toEqual([
      `/runtime/releases/sha256-${'a'.repeat(64)}/payload`,
      `/runtime/releases/${previousRelease}/payload`,
    ])
    expect(deps.errLines.join('\n')).toContain('宿主插件登记由宿主 CLI 独立管理')
    expect(deps.errLines.join('\n')).toContain('仅补偿自己的 managed transaction')
    expect(deps.errLines.join('\n')).toContain('previous Dashboard')
  })
})

describe('③skills/runtime 分派 —— skills 真实装派(dry-run 安全) / runtime 占位 / 未知 sub', () => {
  test('setup skills --dry-run → 打印技能计划 + exit 0 + 零 exec 零 mutation', () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv() // 默认真 registry;dry-run 只出计划,不 exec
    expect(cmdSetup(deps, 'skills', { dryRun: true }, env)).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('技能安装计划')
    expect(out).toContain('--dry-run')
    expect(calls.exec).toHaveLength(0)
    expect(calls.mkdirp).toHaveLength(0)
  })

  test('setup runtime 分派（注入 fake docker）→ 到达 cmdSetupRuntime，出就绪清单 + exit 0，零 runtime 发布', async () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv()
    const code = await cmdSetup(deps, 'runtime', {}, env, fakeRt())
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toContain('就绪清单')
    expect(calls.exec).toHaveLength(0) // runtime 段不走宿主 marketplace/候选发布
  })

  test('未知 sub → stderr + exit 1', () => {
    const deps = makeDeps()
    expect(cmdSetup(deps, 'frobnicate', {}, spyEnv().env)).toBe(1)
    expect(deps.errLines.join('\n')).toContain('未知 setup 子命令')
  })
})

describe('⑨空 sub 全流程 —— 技能段后接运行时就绪清单（dry-run 只提示不真探测,R1 concern#1）', () => {
  test('adapter 计划步骤与真实 setup 编排保持同序', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText })
    const runtime = fakeRuntimeInstaller()
    const rt = fakeRt({ hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'a', OPENAI_API_KEY: 'b' } })
    const dashboard = fakeDashboardStarter()

    const code = await cmdSetup(
      deps,
      undefined,
      { cursor: true, yes: true },
      env,
      rt,
      runtime.installer,
      dashboard.starter,
    )

    expect(code).toBe(0)
    expect(createHostTargetPlan('cursor', 'setup').steps.map((step) => step.id)).toEqual([
      'package-assets',
      'managed-runtime',
      'dashboard-readiness',
      'adapter-deploy',
      'bundled-skills',
      'runtime-readiness',
    ])

    const output = deps.outLines
    const actualStepIndexes = [
      output.findIndex((line) => line.includes('插件资产校验')),
      output.findIndex((line) => line.includes('已发布已验证 runtime')),
      output.findIndex((line) => line.includes('/adapters/install.sh --cursor')),
      output.findIndex((line) => line.includes('[setup skills] 技能安装计划')),
      output.findIndex((line) => line.includes('[setup runtime] AFK 运行时就绪清单')),
    ]
    expect(actualStepIndexes.every((index) => index >= 0)).toBe(true)
    expect(actualStepIndexes).toEqual([...actualStepIndexes].sort((left, right) => left - right))
  })

  test('adapter update 计划在真实 update 重新部署后结束，不包含 setup-only 步骤', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText })
    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()

    const code = await cmdUpdate(
      deps,
      { cursor: true, target: '/workspace' },
      env,
      runtime.installer,
      dashboard.starter,
    )

    expect(code).toBe(0)
    expect(createHostTargetPlan('cursor', 'update').steps.map((step) => step.id)).toEqual([
      'package-assets',
      'managed-runtime',
      'dashboard-readiness',
      'adapter-deploy',
    ])
    expect(deps.outLines.some((line) => line.includes('/adapters/install.sh --cursor'))).toBe(true)
    expect(deps.outLines.join('\n')).not.toContain('[setup skills] 技能安装计划')
    expect(deps.outLines.join('\n')).not.toContain('[setup runtime] AFK 运行时就绪清单')
  })

  test('native update 计划在真实 managed runtime 发布后结束，不调用 setup skills/runtime', async () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv(
      { pathExists: setupPathExists, readText: setupReadText },
      codexInstallExec,
    )
    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()

    const code = await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      { resolve: async () => ({ version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) }) },
    )

    expect(code).toBe(0)
    expect(createHostTargetPlan('codex', 'update').steps.map((step) => step.id)).toEqual([
      'stable-release-resolve',
      'plugin-remove',
      'marketplace-remove',
      'marketplace-register',
      'plugin-install',
      'plugin-inventory',
      'candidate-validation',
      'managed-runtime',
      'dashboard-readiness',
      'codex-auth-status',
    ])
    // The fixture already proves the exact versioned host. Update publishes the missing managed
    // runtime without churning marketplace/plugin registration.
    expect(calls.exec.filter(([cmd, args]) => cmd === 'codex'
      && args[0] === 'plugin'
      && !(args[1] === 'list' || (args[1] === 'marketplace' && args[2] === 'list')))
      .map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([])
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    const runtimeIndex = deps.outLines.findIndex((line) => line.includes('已原子切换至已验证 runtime'))
    const authIndex = deps.outLines.findIndex((line) => line.includes('[Codex 认证] 已登录'))
    expect(runtimeIndex).toBeGreaterThanOrEqual(0)
    expect(authIndex).toBeGreaterThan(runtimeIndex)
    expect(deps.outLines.join('\n')).not.toContain('[setup skills] 技能安装计划')
    expect(deps.outLines.join('\n')).not.toContain('[setup runtime] AFK 运行时就绪清单')
  })

  test.each(['setup', 'update'] as const)(
    'native %s 把 disabled Tenon 登记经官方 remove/add 收敛为 enabled，而不是在观察阶段失败',
    async (operation) => {
      const deps = makeDeps()
      let marketplacePresent = true
      let pluginPresent = true
      let pluginEnabled = false
      const hostMutations: string[] = []
      const { env } = spyEnv({
        pathExists: setupPathExists,
        readText: setupReadText,
        // Exercise the real authoritative observation/postcondition path.
        managedHostReconciliation: undefined,
      }, (cmd, args) => {
        const text = `${cmd} ${args.join(' ')}`
        if (text === 'codex plugin marketplace list --json') {
          return {
            code: 0,
            stdout: JSON.stringify({ marketplaces: marketplacePresent
              ? [{
                  name: 'tenon',
                  root: '/installed/tenon',
                  marketplaceSource: { sourceType: 'git', source: 'jefferysha/tenon' },
                }]
              : [] }),
            stderr: '',
          }
        }
        if (text === 'codex plugin list --json') {
          return {
            code: 0,
            stdout: JSON.stringify({ installed: pluginPresent
              ? [{
                  pluginId: 'tenon@tenon',
                  name: 'tenon',
                  marketplaceName: 'tenon',
                  enabled: pluginEnabled,
                  version: TENON_RELEASE_VERSION,
                  source: { path: '/installed/tenon' },
                }]
              : [] }),
            stderr: '',
          }
        }
        if (text === 'codex plugin remove tenon@tenon --json') {
          pluginPresent = false
          pluginEnabled = false
          hostMutations.push(text)
        } else if (text === 'codex plugin marketplace remove tenon --json') {
          marketplacePresent = false
          hostMutations.push(text)
        } else if (text.startsWith('codex plugin marketplace add ')) {
          marketplacePresent = true
          hostMutations.push(text)
        } else if (text === 'codex plugin add tenon@tenon --json') {
          pluginPresent = true
          pluginEnabled = true
          hostMutations.push(text)
        }
        return { code: 0, stdout: '', stderr: '' }
      })
      const runtime = fakeRuntimeInstaller()
      const dashboard = fakeDashboardStarter()

      const code = operation === 'setup'
        ? await cmdSetupHost(
            deps,
            'codex',
            { codex: true, yes: true },
            env,
            runtime.installer,
            dashboard.starter,
          )
        : await cmdUpdate(
            deps,
            { codex: true },
            env,
            runtime.installer,
            dashboard.starter,
            { resolve: async () => ({ version: TENON_RELEASE_VERSION, tag: CURRENT_RELEASE_TAG, commit: 'a'.repeat(40) }) },
          )

      expect(code, `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)
      expect(hostMutations).toEqual([
        'codex plugin remove tenon@tenon --json',
        'codex plugin marketplace remove tenon --json',
        `codex plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
        'codex plugin add tenon@tenon --json',
      ])
      expect(pluginPresent).toBe(true)
      expect(pluginEnabled).toBe(true)
      expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    },
  )

  // ── 「先删后加」裸露窗口回归 ───────────────────────────────────────────────
  // 宿主里有一份 tenon 登记；升级需要 remove/add 收敛。第 3 步（marketplace 重登记）依赖网络，
  // 一旦它在两次删除之后失败，用户的宿主就会彻底没有 tenon。下面两条覆盖：
  // ①删除前先向远端证明替换品可获取，证明失败时零删除；②真的中断时报告状态并给出可执行恢复命令。
  function statefulCodexHost(options: { failMarketplaceAdd?: boolean } = {}): {
    readonly exec: ExecStub
    readonly mutations: string[]
    state(): { marketplacePresent: boolean; pluginPresent: boolean }
    inventoryReads(): number
    allowMarketplaceAdd(): void
  } {
    let marketplacePresent = true
    let pluginPresent = true
    let pluginEnabled = false
    let failMarketplaceAdd = options.failMarketplaceAdd === true
    let reads = 0
    const mutations: string[] = []
    const exec: ExecStub = (cmd, args) => {
      const text = `${cmd} ${args.join(' ')}`
      if (text === 'codex plugin marketplace list --json') {
        return {
          code: 0,
          stdout: JSON.stringify({ marketplaces: marketplacePresent
            ? [{
                name: 'tenon',
                root: '/installed/tenon',
                marketplaceSource: { sourceType: 'git', source: 'jefferysha/tenon' },
              }]
            : [] }),
          stderr: '',
        }
      }
      if (text === 'codex plugin list --json') {
        reads += 1
        return {
          code: 0,
          stdout: JSON.stringify({ installed: pluginPresent
            ? [{
                pluginId: 'tenon@tenon',
                name: 'tenon',
                marketplaceName: 'tenon',
                enabled: pluginEnabled,
                version: TENON_RELEASE_VERSION,
                source: { path: '/installed/tenon' },
              }]
            : [] }),
          stderr: '',
        }
      }
      if (text === 'codex plugin remove tenon@tenon --json') {
        mutations.push(text)
        pluginPresent = false
        pluginEnabled = false
      } else if (text === 'codex plugin marketplace remove tenon --json') {
        mutations.push(text)
        marketplacePresent = false
      } else if (text.startsWith('codex plugin marketplace add ')) {
        mutations.push(text)
        if (failMarketplaceAdd) {
          return { code: 1, stdout: '', stderr: 'fatal: unable to access github.com: network unreachable' }
        }
        marketplacePresent = true
      } else if (text === 'codex plugin add tenon@tenon --json') {
        mutations.push(text)
        pluginPresent = true
        pluginEnabled = true
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    return {
      exec,
      mutations,
      state: () => ({ marketplacePresent, pluginPresent }),
      inventoryReads: () => reads,
      allowMarketplaceAdd: () => { failMarketplaceAdd = false },
    }
  }

  test('删除宿主登记前无法向远端证明目标 release 时，一个宿主登记都不删', async () => {
    const deps = makeDeps()
    const host = statefulCodexHost()
    const { env: baseEnv } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      managedHostReconciliation: undefined,
    }, host.exec)
    let tagProofs = 0
    const env: SetupEnv = {
      ...baseEnv,
      runCommand: (cmd, args, options) => {
        // 冻结目标时远端可达；读完宿主 inventory、真正要动手删除之前远端已不可达（断网 / 限流）。
        if (cmd === 'git'
          && args[0] === 'ls-remote'
          && args[1]?.endsWith('/tenon.git') === true
          && host.inventoryReads() > 0) {
          tagProofs += 1
          return { code: 128, stdout: '', stderr: 'fatal: unable to access github.com' }
        }
        return baseEnv.runCommand(cmd, args, options)
      },
    }
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true, yes: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
    )).toBe(1)
    expect(tagProofs).toBeGreaterThan(0)
    expect(host.mutations).toEqual([])
    expect(host.state()).toEqual({ marketplacePresent: true, pluginPresent: true })
    expect(runtime.calls.activations).toEqual([])
    const err = deps.errLines.join('\n')
    expect(err).toContain('未执行任何宿主删除或安装')
    expect(err).toContain('tenon setup --codex')
  })

  test('marketplace 重登记失败时报告宿主已空，并给出真的能恢复宿主的命令', async () => {
    const deps = makeDeps()
    const host = statefulCodexHost({ failMarketplaceAdd: true })
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      managedHostReconciliation: undefined,
    }, host.exec)
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetupHost(
      deps,
      'codex',
      { codex: true, yes: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
    )).toBe(1)
    expect(host.mutations).toEqual([
      'codex plugin remove tenon@tenon --json',
      'codex plugin marketplace remove tenon --json',
      `codex plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
    ])
    expect(host.state()).toEqual({ marketplacePresent: false, pluginPresent: false })
    expect(runtime.calls.activations).toEqual([])

    const err = deps.errLines.join('\n')
    expect(err).toContain('宿主收敛在 marketplace-register 中断')
    expect(err).toContain('已被移除且未重新登记')
    expect(err).toContain('这次收敛移除的是宿主原有的 tenon 登记')
    expect(err).toContain('重新运行 `tenon setup --codex`')

    // 报告里的手工恢复命令不是装饰：它必须真的把宿主带回可加载 Tenon 的状态。
    const prefix = '[setup]   $ '
    const restore = deps.errLines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
    expect(restore).toEqual([
      `codex plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
      'codex plugin add tenon@tenon --json',
    ])
    host.allowMarketplaceAdd()
    for (const command of restore) {
      const [cmd, ...args] = command.split(' ')
      host.exec(cmd ?? '', args)
    }
    expect(host.state()).toEqual({ marketplacePresent: true, pluginPresent: true })
  })

  test('Codex CLI 缺失时在 host/journal mutation 前失败并给出安装与版本检查命令', async () => {
    const deps = makeDeps()
    let authCalls = 0
    const { env, calls } = spyEnv({
      commandExists: () => false,
      codexAuthStatus: async () => {
        authCalls += 1
        return { state: 'unavailable', reason: 'cli-missing' }
      },
    }, codexInstallExec)
    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()

    const code = await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      runtime.installer,
      dashboard.starter,
    )

    expect(code).toBe(1)
    const output = [...deps.outLines, ...deps.errLines].join('\n')
    expect(output).toContain('npm install -g @openai/codex')
    expect(output).toContain('codex --version')
    expect(calls.exec).toHaveLength(0)
    expect(calls.mkdirp).toHaveLength(0)
    expect(calls.writeText).toHaveLength(0)
    expect(runtime.calls.activations).toHaveLength(0)
    expect(dashboard.calls.starts).toHaveLength(0)
    expect(authCalls).toBe(0)
  })

  test('Codex preflight, inventory, mutation, observation, and auth reuse one trusted absolute executable', async () => {
    const deps = makeDeps()
    const trustedCodex = '/trusted/bin/codex'
    const authExecutables: Array<string | undefined> = []
    const { env, calls } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      resolveHostCommand: () => nativeHostCommandBinding(trustedCodex, 'darwin', {}),
      codexAuthStatus: async (executable) => {
        authExecutables.push(executable)
        return { state: 'authenticated' }
      },
    }, (_cmd, args) => codexInstallExec('codex', args))

    expect(await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      fakeRuntimeInstaller().installer,
      fakeDashboardStarter().starter,
    )).toBe(0)

    const hostCalls = calls.exec.filter(([, args]) => args[0] === 'plugin')
    expect(hostCalls.length).toBeGreaterThan(0)
    expect(hostCalls.every(([command]) => command === trustedCodex)).toBe(true)
    expect(calls.exec.some(([command]) => command === 'codex')).toBe(false)
    expect(authExecutables).toEqual([trustedCodex])
  })

  test('Windows Codex setup reuses one batch binding for the complete host lifecycle', async () => {
    const deps = makeDeps()
    const executable = 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd'
    const binding = nativeHostCommandBinding(executable, 'win32', {
      SystemRoot: 'C:\\Windows',
    })
    expect(binding).toBeDefined()
    const authExecutables: Array<string | undefined> = []
    const { env, calls } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      resolveHostCommand: () => binding,
      codexAuthStatus: async (candidate) => {
        authExecutables.push(candidate)
        return { state: 'authenticated' }
      },
    }, (_cmd, args) => {
      if (args.at(-1)?.includes('plugin list --json') === true) {
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: [{ pluginId: 'tenon@tenon', name: 'tenon', marketplaceName: 'tenon', version: TENON_RELEASE_VERSION, source: { path: '/installed/tenon' } }],
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    expect(await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      fakeRuntimeInstaller().installer,
      fakeDashboardStarter().starter,
    )).toBe(0)

    const hostCalls = calls.exec.filter(([command]) => command.endsWith('\\cmd.exe'))
    expect(hostCalls.length).toBeGreaterThan(0)
    expect(hostCalls.every(([, args]) =>
      args.slice(0, 3).join(' ') === '/d /s /c'
      && args.at(-1)?.startsWith(`""${executable}" plugin `) === true)).toBe(true)
    expect(authExecutables).toEqual([executable])
  })

  test('Codex 登录状态只在 host/runtime 成功后读取，并用成功后的新快照渲染', async () => {
    const deps = makeDeps()
    const order: string[] = []
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      codexAuthStatus: async () => {
        order.push('auth')
        return { state: 'unauthenticated' }
      },
    }, (cmd, args) => {
      order.push(`host:${cmd} ${args.join(' ')}`)
      return codexInstallExec(cmd, args)
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      runtime.installer,
      fakeDashboardStarter().starter,
    )).toBe(0)

    expect(order).toContain('auth')
    expect(order.some((entry) => entry.startsWith('host:'))).toBe(true)
    expect(order.indexOf('auth')).toBeGreaterThan(
      Math.max(...order.map((entry, index) => entry.startsWith('host:') ? index : -1)),
    )
    expect(createHostTargetPlan('codex', 'setup').steps.map((step) => step.id)).toEqual([
      'stable-release-target',
      'plugin-remove',
      'marketplace-remove',
      'marketplace-register',
      'plugin-install',
      'plugin-inventory',
      'candidate-validation',
      'managed-runtime',
      'dashboard-readiness',
      'codex-auth-status',
      'bundled-skills',
      'runtime-readiness',
    ])
    const outputOrder = [
      deps.outLines.findIndex((line) => line.includes('已发布已验证 runtime')),
      deps.outLines.findIndex((line) => line.includes('[Codex 认证] 尚未登录')),
      deps.outLines.findIndex((line) => line.includes('[setup skills] 技能安装计划')),
      deps.outLines.findIndex((line) => line.includes('[setup runtime] AFK 运行时就绪清单')),
    ]
    expect(outputOrder.every((index) => index >= 0)).toBe(true)
    expect(outputOrder).toEqual([...outputOrder].sort((left, right) => left - right))
    expect(deps.outLines.join('\n')).toContain('[Codex 认证] 尚未登录')
  })

  test('非 dry-run:技能段之后真跑运行时就绪清单（注入 fakeRt,零真 docker）→ 出清单 + exit 0', async () => {
    const deps = makeDeps()
    // 全部已装 → 技能段几乎空跑；fake installer 只记录已校验候选发布，聚焦「运行时段确实被接上」。
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const runtime = fakeRuntimeInstaller()
    const rt = fakeRt({ hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'a', OPENAI_API_KEY: 'b' } })
    const dashboard = fakeDashboardStarter()
    const code = await cmdSetup(deps, undefined, { codex: true, yes: true }, env, rt, runtime.installer, dashboard.starter)
    expect(code).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('技能安装计划') // 技能段跑了
    expect(out).toContain('就绪清单') // 运行时段也跑了（一屏）
    expect(out).toContain('docker daemon 可用')
    expect(out).toContain('[Codex 认证] 已登录')
    expect(runtime.calls.activations).toEqual([['/installed/tenon', 'codex', '/home/test']])
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'a'.repeat(64)}/payload`,
      { openBrowser: true, port: 18_765, transactionId: 'setup-test-transaction', expectedServerVersion: TENON_RELEASE_VERSION },
    ]])
  })

  test('已有有效 managed runtime 的重复交互 setup 不再次抢占浏览器', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({ pathExists: setupPathExists, readText: setupReadText }, codexInstallExec)
    const activeRelease = `sha256-${'c'.repeat(64)}`
    const runtime = fakeRuntimeInstaller(false, null, activeRelease)
    const dashboard = fakeDashboardStarter()

    expect(await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      runtime.installer,
      dashboard.starter,
    )).toBe(0)
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'a'.repeat(64)}/payload`,
      { openBrowser: false, port: 18_765, transactionId: 'setup-test-transaction', expectedServerVersion: TENON_RELEASE_VERSION },
    ]])
  })

  test('curl/CI 非交互 setup 启动并验证 Dashboard，但不抢占浏览器且打印恢复命令', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      isInteractive: () => false,
    }, codexInstallExec)
    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()

    expect(await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      runtime.installer,
      dashboard.starter,
    )).toBe(0)
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'a'.repeat(64)}/payload`,
      { openBrowser: false, port: 18_765, transactionId: 'setup-test-transaction', expectedServerVersion: TENON_RELEASE_VERSION },
    ]])
    expect(deps.outLines.join('\n')).toContain('http://127.0.0.1:18765/')
    expect(deps.outLines.join('\n')).toContain('tenon dashboard --open')
  })

  test('Codex 未登录时一次给全 ChatGPT 订阅、设备登录、API Key 与复核命令', async () => {
    const deps = makeDeps()
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      codexAuthStatus: async () => ({ state: 'unauthenticated' }),
    }, codexInstallExec)
    const code = await cmdSetup(
      deps,
      undefined,
      { codex: true, yes: true },
      env,
      fakeRt(),
      fakeRuntimeInstaller().installer,
      fakeDashboardStarter().starter,
    )
    expect(code).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('codex login')
    expect(out).toContain('codex login --device-auth')
    expect(out).toContain('platform.openai.com/api-keys')
    expect(out).toContain('codex login --with-api-key')
    expect(out).toContain('codex login status')
  })

  test('--dry-run:运行时段只提示见 tenon setup runtime,绝不真探测 docker（同步返 number,不碰 rt）', () => {
    const deps = makeDeps()
    let authCalls = 0
    const { env, calls } = spyEnv({
      codexAuthStatus: async () => {
        authCalls += 1
        return { state: 'unauthenticated' }
      },
    })
    // 关键:不传 rt（用真实 REAL_RUNTIME_ENV 缺省）——dry-run 仍绝不起真 docker;同步返 number 即证未 await 探测。
    const code = cmdSetup(deps, undefined, { codex: true, dryRun: true }, env)
    expect(code).toBe(0) // 同步 number（非 Promise）——dry-run 不进异步运行时探测
    const out = deps.outLines.join('\n')
    expect(out).toContain('运行时就绪检查')
    expect(out).toContain('tenon setup runtime') // 指引去独立子命令看真清单
    expect(out).toContain('--dry-run')
    expect(calls.exec).toHaveLength(0) // 零 exec（技能段 dry-run 零执行 + 运行时段未探测）
    expect(authCalls).toBe(0)
  })

  test('Claude setup 不探测 Codex 登录态', async () => {
    const deps = makeDeps()
    let authCalls = 0
    const { env } = spyEnv({
      pathExists: setupPathExists,
      readText: setupReadText,
      codexAuthStatus: async () => {
        authCalls += 1
        return { state: 'unauthenticated' }
      },
    }, (cmd, args) => {
      if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: 'tenon@tenon', version: TENON_RELEASE_VERSION, installPath: '/installed/tenon' }]),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    expect(await cmdSetup(
      deps,
      undefined,
      { claude: true, yes: true },
      env,
      fakeRt(),
      fakeRuntimeInstaller().installer,
      fakeDashboardStarter().starter,
    )).toBe(0)
    expect(authCalls).toBe(0)
    expect(deps.outLines.join('\n')).not.toContain('Codex 认证')
    expect(deps.outLines.join('\n')).not.toContain('Codex 安装会检查')
  })

  test('宿主 marketplace 安装失败时立即退出，不会把未验证的插件伪装成可运行环境', async () => {
    const deps = makeDeps()
    let authCalls = 0
    // 无已装 + 全 exec 失败 → 真 registry 的 mandatory 命令全败 → 技能段 exit 1。
    const exec: ExecStub = () => ({ code: 1, stdout: '', stderr: 'boom' })
    const { env } = spyEnv({
      codexAuthStatus: async () => {
        authCalls += 1
        return { state: 'unauthenticated' }
      },
    }, exec)
    const code = await cmdSetup(deps, undefined, { codex: true, yes: true }, env, fakeRt())
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain('失败')
    expect(deps.outLines.join('\n')).not.toContain('就绪清单')
    expect(authCalls).toBe(0)
  })
})

describe('⑧运行时检查段 R1 —— AFK 就绪清单（docker/镜像/两 runner 凭证对称;缺镜像 build_hint;缺凭证去配 X）', () => {
  test('全就绪:docker 可用 + 镜像在位 + 两 runner 凭证已配（宿主 env）→ 清单全就绪 + exit 0', async () => {
    const deps = makeDeps()
    const rt = fakeRt({
      hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'a', OPENAI_API_KEY: 'b', CODEX_HOME: '/c' },
      canReadFile: (path) => path === '/c/auth.json',
    })
    expect(await cmdSetupRuntime(deps, {}, rt)).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('就绪清单')
    expect(out).toContain('docker daemon 可用')
    expect(out).toContain('sandcastle:local 在位')
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN 已配（宿主 env）')
    expect(out).toContain('OPENAI_API_KEY 已配（宿主 env）')
    expect(out).not.toContain('[缺失]')
  })

  test('真实 runtime 探针拒绝把 auth.json 同名目录报告为 Codex 凭证就绪', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-setup-runtime-codex-directory-'))
    try {
      mkdirSync(join(root, 'auth.json'))
      const deps = makeDeps()
      expect(await cmdSetupRuntime(deps, {}, {
        ...REAL_RUNTIME_ENV,
        exec: fakeRt().exec,
        hostEnv: { CODEX_HOME: root },
        defaultCodexHome: undefined,
        resolveImage: () => 'sandcastle:local',
      })).toBe(0)
      const output = deps.outLines.join('\n')
      expect(output).toContain('[缺失] codex 凭证 OPENAI_API_KEY 未配')
      expect(output).toContain('[缺失] codex CODEX_HOME 未配')
      expect(output).not.toContain('[就绪] codex 凭证 已配')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('docker 不可用 → 降级标缺失（不抛不阻断,exit 0）;镜像未能核给 build_hint;附「怎么拿」docker 安装引导', async () => {
    const deps = makeDeps()
    expect(await cmdSetupRuntime(deps, {}, fakeRt({ exec: dockerDownExec }))).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('docker 不可用')
    expect(out).toContain('bash tools/sandcastle/build.sh') // build_hint 单一真相源
    // FI·G1:不光报缺,还引导怎么获取——装 OrbStack / Docker Desktop,且明示不自动装
    expect(out).toContain('OrbStack')
    expect(out).toContain('Docker Desktop')
    expect(out).toContain('不自动装')
  })

  test('docker 在但镜像缺（inspect 非零）→ [缺失] + 构建:build_hint 一键', async () => {
    const deps = makeDeps()
    const exec: ExecDockerFn = async (args) =>
      args[0] === 'info' ? { stdout: 'ok', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'no image', exitCode: 1 }
    expect(await cmdSetupRuntime(deps, {}, fakeRt({ exec }))).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('docker daemon 可用')
    expect(out).toContain('构建:bash tools/sandcastle/build.sh')
  })

  test('凭证缺 → 去配 X;凭证值永不回显（secrets 明文不进输出）;codex 缺附「怎么拿」两条路,claude 已配则无 claude 引导', async () => {
    const deps = makeDeps()
    // secrets 供 claude-code token（明文），codex OPENAI_API_KEY 两源皆缺
    deps.readSecretsEnv = async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'super-secret-xyz' })
    const out0 = await cmdSetupRuntime(deps, {}, fakeRt({ hostEnv: {} }))
    expect(out0).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).not.toContain('super-secret-xyz') // 值永不回显
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN 已配（secrets 文件）') // 只报 set+source
    expect(out).toContain('去配 OPENAI_API_KEY') // 缺 → 去配硬指引
    // FI·G1:codex 缺 → 引导两条路（codex login / openai api-keys）;claude 已配 → 不出 claude 引导（只对缺项引导）
    expect(out).toContain('codex login')
    expect(out).toContain('platform.openai.com/api-keys')
    expect(out).not.toContain('claude setup-token')
  })

  test('Codex-first：默认 ~/.codex/auth.json 可读 → 不再要求 OPENAI_API_KEY', async () => {
    const deps = makeDeps()
    const rt = Object.assign(fakeRt({ hostEnv: {} }), {
      defaultCodexHome: '/users/codex-owner/.codex',
      canReadFile: (path: string) => path === '/users/codex-owner/.codex/auth.json',
    })
    expect(await cmdSetupRuntime(deps, {}, rt)).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('默认 ~/.codex 登录')
    expect(out).not.toContain('去配 OPENAI_API_KEY')
  })

  test('claude-code 凭证缺 → 附「怎么拿」claude setup-token 引导（值永不回显）', async () => {
    const deps = makeDeps()
    // 两 runner 凭证两源皆缺（hostEnv 空 + 无 secrets）
    deps.readSecretsEnv = async () => ({})
    expect(await cmdSetupRuntime(deps, {}, fakeRt({ hostEnv: {} }))).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('去配 CLAUDE_CODE_OAUTH_TOKEN')
    expect(out).toContain('claude setup-token') // claude-code 缺 → 生成长期 OAuth token
    expect(out).toContain('codex login') // codex 也缺 → 两条路引导
  })

  test('两 runner 凭证对称:claude-code 已配、codex 全缺时,codex 的 OPENAI_API_KEY 与 CODEX_HOME 仍双双在清单（不缺席）', async () => {
    const deps = makeDeps()
    const rt = fakeRt({ hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'only-claude' } })
    expect(await cmdSetupRuntime(deps, {}, rt)).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('codex 凭证 OPENAI_API_KEY')
    expect(out).toContain('codex CODEX_HOME') // codex 对等:两键都呈现
    expect(out).not.toContain('only-claude') // 值永不回显
  })

  test('--dry-run:出清单 + dry-run 说明,且零写（store.write 零调用）', async () => {
    const deps = makeDeps()
    expect(await cmdSetupRuntime(deps, { dryRun: true }, fakeRt({ exec: dockerDownExec }))).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('就绪清单')
    expect(out).toContain('--dry-run')
    expect(deps.store.write.calls).toHaveLength(0) // 运行时段只探测只打印,零写
  })
})

describe('④program 装配 —— flag 解析 --dry-run/--yes 透传', () => {
  async function runProgram(deps: ReturnType<typeof makeDeps>, args: string[]): Promise<number> {
    try {
      await buildProgram(deps).parseAsync(args, { from: 'user' })
      return 0
    } catch (e) {
      if (e instanceof CliExit) return e.code
      throw e
    }
  }

  test('setup --codex --dry-run:commander 解析为 host + dry-run（打印骨架、零副作用安全）', async () => {
    const deps = makeDeps()
    expect(await runProgram(deps, ['setup', '--codex', '--dry-run'])).toBe(0)
    expect(deps.outLines.join('\n')).toContain('--dry-run')
  })

  test('setup --dry-run 未指定宿主 → exit 1', async () => {
    const deps = makeDeps()
    expect(await runProgram(deps, ['setup', '--dry-run'])).toBe(1)
    expect(deps.errLines.join('\n')).toContain('必须指定一个宿主')
  })

  test('setup skills --dry-run:commander 解析,出技能计划零全局写（真装留最终门,不入 CI）', async () => {
    const deps = makeDeps()
    expect(await runProgram(deps, ['setup', 'skills', '--dry-run'])).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('技能安装计划')
    expect(out).toContain('--dry-run')
  })
})

describe('⑤技能安装段 S2 —— 命令生成 / 标注 / 幂等 / dry-run 零执行 / 失败容错 / engine / 禁整装', () => {
  test('① ECC 15 token 聚合成一条 --skill×15,无裸 npx skills add affaan-m/ECC', () => {
    const plan = buildSkillsPlan(eccSources, spyEnv().env)
    const ecc = plan.commands.find((c) => c.source === 'affaan-m/ECC' && c.group === 'skills-cli')
    expect(ecc).toBeDefined()
    expect(ecc!.names).toHaveLength(15)
    expect(ecc!.args.filter((a) => a === '--skill')).toHaveLength(15)
    expect(ecc!.args).toEqual(expect.arrayContaining(['-g', '-y']))
    expect(ecc!.bareAdd).toBe(false)
    expect(cmdText(ecc!)).toContain('npx skills add affaan-m/ECC --skill browser-qa')
    // 禁整装:绝无 args 恰为 skills add affaan-m/ECC（缺 --skill）的整仓命令
    expect(plan.commands.some((c) => c.cmd === 'npx' && c.args.join(' ') === 'skills add affaan-m/ECC')).toBe(false)
  })

  test('真实 registry：default workflow 全部 bundled，不生成第三方 skills-cli/npm/marketplace 安装命令', () => {
    const plan = buildSkillsPlan(readSkillSources(), spyEnv().env)
    expect(plan.commands).toEqual([])
    expect(plan.noInstall.length).toBeGreaterThan(30)
    expect(plan.noInstall).toContainEqual({ token: 'brainstorming', tool: 'bundled' })
    expect(plan.noInstall).toContainEqual({ token: 'openspec-propose', tool: 'bundled' })
    expect(plan.noInstall).toContainEqual({ token: 'deployment-patterns', tool: 'bundled' })
  })

  test('① agents-inc marketplace-add 在逐 id install 之前，Codex 优先且保留 Claude 兼容；npm 一条；builtin/bundled 无命令', () => {
    const src: SkillSource[] = [
      { token: 'shadcn-ui', tool: 'claude-plugin', source: 'agents-inc', skill: 'web-ui-shadcn-ui', tier: 'recommended', official: false },
      { token: 'tailwind-css-patterns', tool: 'claude-plugin', source: 'agents-inc', skill: 'web-styling-tailwind', tier: 'recommended', official: false },
      { token: 'opsx', tool: 'npm', source: '@fission-ai/openspec', tier: 'mandatory', official: false },
      { token: 'verify', tool: 'builtin', source: 'claude-code', tier: 'mandatory', official: true },
      { token: 'openspec-propose', tool: 'bundled', source: 'tenon', tier: 'mandatory', official: false },
    ]
    const plan = buildSkillsPlan(src, spyEnv().env)
    const texts = plan.commands.map(cmdText)
    const codexAddIdx = texts.indexOf('codex plugin marketplace add agents-inc/skills')
    const claudeAddIdx = texts.indexOf('claude plugin marketplace add agents-inc/skills')
    const codexShadcnIdx = texts.indexOf('codex plugin add web-ui-shadcn-ui@agents-inc')
    const codexTailwindIdx = texts.indexOf('codex plugin add web-styling-tailwind@agents-inc')
    const claudeShadcnIdx = texts.indexOf('claude plugin install web-ui-shadcn-ui@agents-inc')
    expect(codexAddIdx).toBeGreaterThanOrEqual(0)
    expect(claudeAddIdx).toBeGreaterThanOrEqual(0)
    expect(codexAddIdx).toBeLessThan(codexShadcnIdx)
    expect(codexAddIdx).toBeLessThan(codexTailwindIdx)
    expect(claudeAddIdx).toBeLessThan(claudeShadcnIdx)
    expect(texts).toContain('npm install -g @fission-ai/openspec')
    expect(texts.some((s) => s.includes('verify') || s.includes('openspec-propose'))).toBe(false)
    expect(plan.noInstall.map((n) => n.token).sort()).toEqual(['openspec-propose', 'verify'])
  })

  test('② 官方/第三方标注:anthropics/claude-plugins-official=官方,ECC/agents-inc=第三方', () => {
    const src: SkillSource[] = [
      { token: 'web-artifacts-builder', tool: 'skills-cli', source: 'anthropics/skills', skill: 'web-artifacts-builder', tier: 'optional', official: true },
      { token: 'e2e-testing', tool: 'skills-cli', source: 'affaan-m/ECC', skill: 'e2e-testing', tier: 'mandatory', official: false },
      { token: 'shadcn-ui', tool: 'claude-plugin', source: 'agents-inc', skill: 'web-ui-shadcn-ui', tier: 'recommended', official: false },
      { token: 'frontend-design', tool: 'claude-plugin', source: 'claude-plugins-official', skill: 'frontend-design', tier: 'mandatory', official: true },
    ]
    const plan = buildSkillsPlan(src, spyEnv().env)
    const byToken = (t: string): PlannedCommand => plan.commands.find((c) => c.tokens.includes(t))!
    expect(byToken('web-artifacts-builder').official).toBe(true)
    expect(byToken('e2e-testing').official).toBe(false)
    expect(byToken('shadcn-ui').official).toBe(false)
    expect(byToken('frontend-design').official).toBe(true)
  })

  test('③ 幂等:注入 ~/.agents/skills/e2e-testing 已装 → 从 ECC --skill 剔除并标跳过', () => {
    const three = eccSources.slice(0, 3) // browser-qa, e2e-testing, search-first
    const installed = join('/home/test', '.agents', 'skills', 'e2e-testing')
    const { env } = spyEnv({ pathExists: (p) => p === installed })
    const plan = buildSkillsPlan(three, env)
    const ecc = plan.commands.find((c) => c.source === 'affaan-m/ECC')!
    expect(ecc.names).not.toContain('e2e-testing')
    expect(ecc.names).toEqual(expect.arrayContaining(['browser-qa', 'search-first']))
    expect(plan.alreadyInstalled.map((a) => a.token)).toContain('e2e-testing')
  })

  test('③ 幂等:整组已装 → 整条命令剔除', () => {
    const { env } = spyEnv({ pathExists: () => true })
    const plan = buildSkillsPlan(eccSources, env)
    expect(plan.commands.filter((c) => c.source === 'affaan-m/ECC')).toHaveLength(0)
  })

  test('③ 幂等:npm registry 声明的全局 binary 已在 PATH → npm install 整条剔除', () => {
    const src = [{
      token: 'opsx', tool: 'npm', source: '@fission-ai/openspec', bin: 'openspec',
      tier: 'mandatory', official: false,
    }] as SkillSource[]
    const { env } = spyEnv({ commandExists: (name) => name === 'openspec' })
    const plan = buildSkillsPlan(src, env)
    expect(plan.commands.filter((c) => c.group === 'npm')).toHaveLength(0)
    expect(plan.alreadyInstalled).toContainEqual({ token: 'opsx', where: 'PATH:openspec' })
  })

  test('③ 幂等:registry 明示上游 unavailable → 不执行、不反复 WARN 安装失败', () => {
    const src = [{
      token: 'zoom-out', tool: 'skills-cli', source: 'mattpocock/skills', skill: 'zoom-out',
      unavailable: true, tier: 'optional', official: false,
    }] as SkillSource[]
    const plan = buildSkillsPlan(src, spyEnv().env)
    expect(plan.commands).toHaveLength(0)
    expect(plan.noInstall).toContainEqual({ token: 'zoom-out', tool: 'unavailable-upstream' })
  })

  test('③ 幂等：Codex 与 Claude 双 cache 都命中才算 plugin 全就绪，不每次重装', () => {
    const src: SkillSource[] = [
      { token: 'frontend-design', tool: 'claude-plugin', source: 'claude-plugins-official', skill: 'frontend-design', tier: 'mandatory', official: true },
    ]
    const claudeCache = join('/home/test', '.claude', 'plugins', 'cache')
    const codexCache = join('/home/test', '.codex', 'plugins', 'cache')
    const { env } = spyEnv({
      listDir: () => [],
      pathExists: (p) => p === join(claudeCache, 'claude-plugins-official', 'frontend-design')
        || p === join(codexCache, 'claude-plugins-official', 'frontend-design'),
    })
    const plan = buildSkillsPlan(src, env)
    expect(plan.commands.filter((c) => c.group === 'claude-plugin' || c.group === 'codex-plugin')).toHaveLength(0)
    expect(plan.alreadyInstalled.map((a) => a.token)).toContain('frontend-design')
  })

  test('Codex-first：Claude plugin 已装但 Codex cache 缺失，仍计划 codex plugin add，绝不误判全就绪', () => {
    const src: SkillSource[] = [
      { token: 'tailwind-css-patterns', tool: 'claude-plugin', source: 'agents-inc', skill: 'web-styling-tailwind', tier: 'recommended', official: false },
    ]
    const claudePlugin = join('/home/test', '.claude', 'plugins', 'cache', 'agents-inc', 'web-styling-tailwind')
    const codexMarketplace = join('/home/test', '.codex', '.tmp', 'marketplaces', 'agents-inc')
    const { env } = spyEnv({ pathExists: (p) => p === claudePlugin || p === codexMarketplace })

    const plan = buildSkillsPlan(src, env)

    expect(plan.commands.map(cmdText)).toContain('codex plugin add web-styling-tailwind@agents-inc')
    expect(plan.commands.map(cmdText)).not.toContain('claude plugin install web-styling-tailwind@agents-inc')
    expect(plan.alreadyInstalled.map((row) => row.token)).not.toContain('tailwind-css-patterns')
  })

  test('④ cmdSetupSkills --dry-run:spy exec/mutation 调用数 0,计划仍列 ECC 15 个', () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv()
    expect(cmdSetupSkills(deps, { dryRun: true }, env, eccSources)).toBe(0)
    expect(calls.exec).toHaveLength(0)
    expect(calls.mkdirp).toHaveLength(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('--dry-run')
    expect(out).toContain('技能(15)')
  })

  test('⑤ 失败容错:mattpocock 装失败 → 其余仍跑,汇总红字,强制失败 exit 1', () => {
    const src: SkillSource[] = [
      { token: 'grill-with-docs', tool: 'skills-cli', source: 'mattpocock/skills', skill: 'grill-with-docs', tier: 'mandatory', official: false },
      { token: 'hallmark', tool: 'skills-cli', source: 'nutlope/hallmark', tier: 'recommended', official: false },
      { token: 'opsx', tool: 'npm', source: '@fission-ai/openspec', tier: 'mandatory', official: false },
    ]
    const execCalls: Array<[string, string[]]> = []
    const exec: ExecStub = (cmd, args) => {
      execCalls.push([cmd, args])
      if (args.includes('--list')) return { code: 0, stdout: 'grill-with-docs', stderr: '' } // --list 回显名,不制造漂移
      if (args.includes('mattpocock/skills')) return { code: 1, stdout: '', stderr: 'network unreachable' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const deps = makeDeps()
    const { env } = spyEnv({}, exec)
    expect(cmdSetupSkills(deps, { yes: true }, env, src)).toBe(1) // 强制级失败 → 非零
    // 其余仍跑:hallmark + openspec 都被 exec（不 abort）
    expect(execCalls.some(([, a]) => a.includes('nutlope/hallmark'))).toBe(true)
    expect(execCalls.some(([, a]) => a.join(' ').includes('@fission-ai/openspec'))).toBe(true)
    const err = deps.errLines.join('\n')
    expect(err).toContain('mattpocock/skills')
    expect(err).toContain('强制')
  })

  test('⑤ 非强制失败不改退出码:hallmark 失败 → exit 0', () => {
    const src: SkillSource[] = [
      { token: 'hallmark', tool: 'skills-cli', source: 'nutlope/hallmark', tier: 'recommended', official: false },
    ]
    const exec: ExecStub = () => ({ code: 1, stdout: '', stderr: 'boom' })
    const deps = makeDeps()
    const { env } = spyEnv({}, exec)
    expect(cmdSetupSkills(deps, { yes: true }, env, src)).toBe(0)
    expect(deps.errLines.join('\n')).toContain('nutlope/hallmark')
  })

  test('安装命令 exit 0 但请求技能未真正出现在用户级目录 → 不计成功并按真实 tier 失败', () => {
    const src: SkillSource[] = [
      { token: 'browser-qa', tool: 'skills-cli', source: 'affaan-m/ECC', skill: 'browser-qa', tier: 'mandatory', official: false },
    ]
    const exec: ExecStub = (_cmd, args) => args.includes('--list')
      ? { code: 0, stdout: 'browser-qa\n', stderr: '' }
      : { code: 0, stdout: 'installer claimed success', stderr: '' }
    const deps = makeDeps()
    const { env } = spyEnv({}, exec)
    expect(cmdSetupSkills(deps, { yes: true }, env, src)).toBe(1)
    expect(deps.outLines.join('\n')).toContain('成功 0')
    expect(deps.errLines.join('\n')).toContain('命令 exit 0')
    expect(deps.errLines.join('\n')).toContain('browser-qa')
  })

  test('⑥ browser-qa 的 engine → Codex 优先并附加 Claude 兼容的 playwright plugin（官方）', () => {
    const src: SkillSource[] = [
      { token: 'browser-qa', tool: 'skills-cli', source: 'affaan-m/ECC', skill: 'browser-qa', tier: 'mandatory', official: false, engine: 'playwright@claude-plugins-official' },
    ]
    const plan = buildSkillsPlan(src, spyEnv().env)
    expect(plan.commands.map(cmdText)).toContain('claude plugin install playwright@claude-plugins-official')
    expect(plan.commands.map(cmdText)).toContain('codex plugin add playwright@claude-plugins-official')
    const pw = plan.commands.find((c) => c.group === 'claude-plugin' && c.args.includes('playwright@claude-plugins-official'))!
    expect(pw.group).toBe('claude-plugin')
    expect(pw.official).toBe(true)
  })

  test('⑦ 真 registry 全量：不再有任何外部安装命令，所有 token 都由随包 skill 提供', () => {
    const all = readSkillSources()
    expect(all.length).toBeGreaterThan(0) // registry 加载成功
    const plan = buildSkillsPlan(all, spyEnv().env)
    expect(plan.commands).toEqual([])
    expect(plan.noInstall).toHaveLength(all.length)
    expect(plan.noInstall.every((entry) => entry.tool === 'bundled')).toBe(true)
  })
})

describe('⑩ registry 就绪门 —— 坏/缺 registry fail-loud（不空计划假成功），真空 registry 才走无待装', () => {
  const failLoader = (): SkillSourcesResult => ({ ok: false, error: '解析失败: token x tool 非法' })
  const emptyLoader = (): SkillSourcesResult => ({ ok: true, sources: [] })

  test('坏 registry（loader 报失败）→ 非零退出 + 明示 registry 未就绪，不打印「无待装」假成功', () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv()
    const code = cmdSetupSkills(deps, { yes: true }, env, undefined, failLoader)
    expect(code).not.toBe(0) // 非零退出（不假成功）
    const err = deps.errLines.join('\n')
    expect(err).toContain('registry 未就绪')
    expect(err).toContain('解析失败') // 携具体原因
    expect(deps.outLines.join('\n')).not.toContain('无待装') // 绝不当空计划走假成功
    expect(calls.exec).toHaveLength(0) // 未执行任何安装命令
  })

  test('坏 registry + --dry-run 也 fail-loud（零执行，仍非零，不假成功）', () => {
    const deps = makeDeps()
    const { env, calls } = spyEnv()
    const code = cmdSetupSkills(deps, { dryRun: true }, env, undefined, failLoader)
    expect(code).not.toBe(0)
    expect(deps.errLines.join('\n')).toContain('registry 未就绪')
    expect(calls.exec).toHaveLength(0)
  })

  test('真空 registry（合法但无条目）→ 走「无待装」+ exit 0（与坏 registry 区分）', () => {
    const deps = makeDeps()
    const { env } = spyEnv()
    const code = cmdSetupSkills(deps, { yes: true }, env, undefined, emptyLoader)
    expect(code).toBe(0)
    expect(deps.outLines.join('\n')).toContain('无待装')
    expect(deps.errLines.join('\n')).not.toContain('registry 未就绪')
  })
})

describe('caller-level provenance replay', () => {
  test('verifyPackagedAssets replays frozen Bash and Node before the verifier spawn', () => {
    const deps = makeDeps()
    const root = '/plugin'
    const events: string[] = []
    const frozenBash = fakeTrustedExecutable('/trusted/runtime/bash', () => {
      events.push('bash-proof')
      return true
    })
    const frozenNode = fakeTrustedExecutable('/trusted/runtime/node', () => {
      events.push('node-proof')
      return true
    })
    const { env, calls } = spyEnv({
      pathExists: (path) => path === join(root, 'runtime', 'tenon-bootstrap.mjs'),
    })
    env.resolveTrustedCommandBinding = (name) => name === 'bash' ? frozenBash : frozenNode
    env.runTrustedLifecycleCommand = (command, args) => {
      events.push('spawn')
      expect(command).toBe('bash')
      expect(args).toEqual([
        join(root, 'tools', 'verify-skills.sh'),
        '--quiet',
        '--root',
        root,
        '--node',
        frozenNode.executable,
      ])
      return { code: 0, stdout: '', stderr: '' }
    }

    expect(verifyPackagedAssets(deps, env, root, false)).toBe(0)
    expect(events).toEqual(['bash-proof', 'node-proof', 'spawn'])
    expect(calls.exec).toEqual([])
  })

  test('verifyPackagedAssets fails closed on Node drift without starting a runner', () => {
    const deps = makeDeps()
    const root = '/plugin'
    const events: string[] = []
    const frozenBash = fakeTrustedExecutable('/trusted/runtime/bash', () => {
      events.push('bash-proof')
      return true
    })
    const frozenNode = fakeTrustedExecutable('/trusted/runtime/node', () => {
      events.push('node-proof')
      return false
    })
    const { env, calls } = spyEnv({
      pathExists: (path) => path === join(root, 'runtime', 'tenon-bootstrap.mjs'),
    })
    env.resolveTrustedCommandBinding = (name) => name === 'bash' ? frozenBash : frozenNode
    let runnerCalls = 0
    env.runTrustedLifecycleCommand = () => {
      runnerCalls += 1
      events.push('spawn')
      return { code: 0, stdout: '', stderr: '' }
    }

    expect(verifyPackagedAssets(deps, env, root, false)).toBe(1)
    expect(events).toEqual(['bash-proof', 'node-proof'])
    expect(runnerCalls).toBe(0)
    expect(calls.exec).toEqual([])
  })
})

describe('canonical provenance setup gate', () => {
  test('bundled setup replays frozen Bash and Node before a dry-run plan', () => {
    const deps = makeDeps()
    const root = process.cwd()
    const events: string[] = []
    const frozenBash = fakeTrustedExecutable('/trusted/runtime/bash', () => {
      events.push('bash-proof')
      return true
    })
    const frozenNode = fakeTrustedExecutable('/trusted/runtime/node', () => {
      events.push('node-proof')
      return true
    })
    const { env, calls } = spyEnv({
      pluginRoot: () => root,
      selfPath: () => join(root, 'packages', 'cli', 'dist', 'tenon.mjs'),
    })
    env.resolveTrustedCommandBinding = (name) => name === 'bash' ? frozenBash : frozenNode
    env.runTrustedLifecycleCommand = (command, args) => {
      events.push('spawn')
      expect(command).toBe('bash')
      expect(args).toEqual([
        join(root, 'tools', 'verify-skills.sh'),
        '--quiet',
        '--root',
        root,
        '--node',
        frozenNode.executable,
      ])
      return { code: 0, stdout: '', stderr: '' }
    }

    expect(cmdSetupSkills(deps, { dryRun: true }, env)).toBe(0)
    expect(events).toEqual(['bash-proof', 'node-proof', 'spawn'])
    expect(calls.exec).toEqual([])
    expect(deps.outLines.join('\n')).toContain('[setup skills] --dry-run')
  })

  test('bundled setup stops on Node drift before verifier runner or skill plan/install child', () => {
    const deps = makeDeps()
    const root = process.cwd()
    const events: string[] = []
    const frozenBash = fakeTrustedExecutable('/trusted/runtime/bash', () => {
      events.push('bash-proof')
      return true
    })
    const frozenNode = fakeTrustedExecutable('/trusted/runtime/node', () => {
      events.push('node-proof')
      return false
    })
    const { env, calls } = spyEnv({
      pluginRoot: () => root,
      selfPath: () => join(root, 'packages', 'cli', 'dist', 'tenon.mjs'),
    })
    env.resolveTrustedCommandBinding = (name) => name === 'bash' ? frozenBash : frozenNode
    let runnerCalls = 0
    env.runTrustedLifecycleCommand = () => {
      runnerCalls += 1
      events.push('spawn')
      return { code: 0, stdout: '', stderr: '' }
    }

    expect(cmdSetupSkills(deps, { dryRun: true }, env)).toBe(1)
    expect(events).toEqual(['bash-proof', 'node-proof'])
    expect(runnerCalls).toBe(0)
    expect(calls.exec).toEqual([])
    expect(calls.mkdirp).toEqual([])
    expect(calls.writeText).toEqual([])
    expect(deps.outLines.join('\n')).not.toContain('[setup skills] 技能安装计划')
    expect(deps.errLines.join('\n')).toContain('canonical Skill provenance 校验失败')
  })

  test('real bundled setup rejects Skill content drift before producing a plan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-setup-provenance-'))
    try {
      const trustedNode = await createTrustedNode(root)
      const frozenNode = freezeTrustedExecutable(trustedNode.executable)
      expect(frozenNode).toBeDefined()
      await cp(join(process.cwd(), 'templates'), join(root, 'templates'), { recursive: true })
      await cp(join(process.cwd(), 'skills'), join(root, 'skills'), { recursive: true })
      for (const rel of ['.claude-plugin', '.codex-plugin', '.agents', 'hooks', 'runtime', 'tools']) {
        await cp(join(process.cwd(), rel), join(root, rel), { recursive: true })
      }
      mkdirSync(join(root, 'packages', 'cli', 'dist'), { recursive: true })
      await cp(
        join(process.cwd(), 'packages', 'cli', 'dist', 'tenon.mjs'),
        join(root, 'packages', 'cli', 'dist', 'tenon.mjs'),
      )
      mkdirSync(join(root, 'packages', 'server', 'dist'), { recursive: true })
      await cp(
        join(process.cwd(), 'packages', 'server', 'dist', 'dashboard.mjs'),
        join(root, 'packages', 'server', 'dist', 'dashboard.mjs'),
      )
      mkdirSync(join(root, 'packages', 'dashboard-app', 'dist'), { recursive: true })
      await cp(
        join(process.cwd(), 'packages', 'dashboard-app', 'dist'),
        join(root, 'packages', 'dashboard-app', 'dist'),
        { recursive: true },
      )
      const skillPath = join(root, 'skills', 'tenon', 'SKILL.md')
      await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\n# drift\n`, 'utf8')

      let status = 0
      let output = ''
      try {
        execFileSync(process.execPath, [
          join(root, 'packages', 'cli', 'dist', 'tenon.mjs'),
          'setup', 'skills', '--yes',
        ], {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, PATH: hermeticProvenancePath(trustedNode.bin) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string }
        status = e.status ?? 1
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`
      }

      expect(status).not.toBe(0)
      expect(output).toContain('content-hash-mismatch')
      expect(output).not.toContain('[setup skills] 技能安装计划')
      expect(output).not.toContain('无待装技能')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
