import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { makeDeps } from '../test-support.js'
import {
  enabledHostPluginIds,
  installedPipelineRoot,
  nativeInstallPlan,
  nativePluginRemovalPlan,
  parseHostPluginInventory,
} from './plugin-host.js'
import { type SetupEnv } from './setup.js'
import { nativeHostCommandBinding } from './native-host-command-binding.js'
import { cmdUpdate, nativeUpdatePlan } from './update.js'
import { verifyUpdatedRoot } from './update-candidate-verification.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { expectedStableLaunchers } from '../runtime/launchers.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import type { TrustedExecutable } from './trusted-executable.js'
import type { StableReleaseTarget } from './stable-release.js'

interface Calls {
  readonly exec: Array<readonly [string, readonly string[]]>
  readonly writes: Array<readonly [string, string]>
}

interface RuntimeCalls {
  readonly activations: Array<readonly [string, string, string]>
  readonly failures: Array<readonly [string, string]>
  readonly reverts: Array<readonly [string, string]>
}

interface DashboardCalls {
  readonly starts: Array<readonly [string, {
    readonly openBrowser?: boolean
    readonly port?: number
    readonly transactionId?: string
    readonly expectedServerVersion?: string
  }]>
}

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

function fakeRuntimeInstaller(
  fail = false,
  previousRelease: string | null = null,
  activeRelease: string | null = null,
  activePluginVersion = '1.0.1',
  activeStableTarget?: typeof STABLE_TARGET,
  proveExistingActivation = true,
  activeManifestVersion?: 1 | 2,
): { installer: RuntimeInstaller; calls: RuntimeCalls } {
  const calls: RuntimeCalls = { activations: [], failures: [], reverts: [] }
  const releaseId = `sha256-${'b'.repeat(64)}`
  let journal: import('../runtime/installer.js').ManagedReleaseJournalRecord | null = null
  const installer: RuntimeInstaller = {
    peekManagedJournal: async () => journal,
    withManagedTransaction: async (scope, operation) => operation({
      checkpointActivation: async () => ({
        selection: {
          version: 1,
          revision: 0,
          activeRelease: previousRelease,
          previousRelease: null,
          updatedAt: activeRelease === null
            ? '2026-07-23T00:00:00Z'
            : '1970-01-01T00:00:00Z',
        },
        launchers: activeRelease !== null && proveExistingActivation
          ? expectedStableLaunchers(
              resolveRuntimePaths({ homeDir: '/home/update-test', env: {} }),
              '/home/update-test',
            )
          : {
              tenon: { path: '/home/update-test/.local/bin/tenon', state: { kind: 'missing' } },
              hook: { path: '/home/update-test/.local/bin/tenon-hook', state: { kind: 'missing' } },
            },
      }),
      activate: async (candidateRoot, host, expectedPluginVersion, stableTarget) => {
        calls.activations.push([candidateRoot, host, scope.homeDir])
        if (fail) throw new Error('candidate rejected')
        return {
          release: {
            version: 2,
            releaseId,
            payloadDigest: 'b'.repeat(64),
            createdAt: '2026-07-24T00:00:00Z',
            source: { host, pluginVersion: expectedPluginVersion ?? '1.0.0' },
            ...(stableTarget === undefined ? {} : { stableTarget }),
          },
          selection: { version: 1, revision: 2, activeRelease: releaseId, previousRelease, updatedAt: '2026-07-24T00:00:00Z' },
          releaseRoot: `/runtime/releases/${releaseId}`,
        }
      },
      recoverActivation: async () => ({ state: 'not-started' as const }),
      revertActivation: async (activation) => {
        calls.reverts.push([scope.homeDir, activation.release.releaseId])
      },
      proveActivation: async (activation) => activation.release.releaseId === activeRelease
        ? proveExistingActivation
        : activation.selection.activeRelease === activation.release.releaseId,
      journal: {
        create: (operationName, source, now) => ({
          version: 1,
          transactionId: 'update-test-transaction',
          operation: operationName,
          source,
          phase: 'preparing-host',
          startedAt: now,
          updatedAt: now,
        }),
        read: async () => journal,
        write: async (record) => { journal = record },
        clear: async () => { journal = null },
      },
    }),
    inspect: async () => ({
      selection: { version: 1, revision: 0, activeRelease, previousRelease: null, updatedAt: '1970-01-01T00:00:00Z' },
      active: activeRelease === null ? null : {
        ...((activeManifestVersion ?? (activeStableTarget === undefined ? 1 : 2)) === 1
          ? { version: 1 as const }
          : {
              version: 2 as const,
              ...(activeStableTarget === undefined ? {} : { stableTarget: activeStableTarget }),
            }),
        releaseId: activeRelease,
        payloadDigest: activeRelease.replace(/^sha256-/, ''),
        createdAt: '2026-07-24T00:00:00Z',
        source: { host: 'codex', pluginVersion: activePluginVersion },
      },
      previous: null,
      activeValid: activeRelease !== null,
      previousValid: false,
      lastAudit: null,
    }),
    rollback: async () => { throw new Error('not used') },
    recordUpdateFailure: async (scope, detail) => {
      calls.failures.push([scope.homeDir, detail])
    },
  }
  return { installer, calls }
}

function fakeDashboardStarter(
  failures: readonly boolean[] = [],
  initialRelease: string | null = null,
  initialServerVersion = '1.2.3',
  initialTransactionId?: string,
  startedServerVersion = '1.2.3',
): { starter: ReleasedDashboardStarter; calls: DashboardCalls } {
  const calls: DashboardCalls = { starts: [] }
  let running: Awaited<ReturnType<ReleasedDashboardStarter['inspect']>> = initialRelease === null
    ? null
    : {
        version: 1,
        serverVersion: initialServerVersion,
        port: 18_765,
        pid: 320,
        releaseId: initialRelease,
        stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
        ...(initialTransactionId === undefined ? {} : { transactionId: initialTransactionId }),
      }
  return {
    starter: {
      inspect: async () => running,
      adopt: async () => null,
      start: async (_deps, payloadRoot, opts) => {
        calls.starts.push([payloadRoot, opts])
        const releaseId = payloadRoot.split('/').at(-2) ?? ''
        if (failures[calls.starts.length - 1] === true) {
          return { state: 'failed', detail: 'injected readiness failure' }
        }
        running = {
          version: 1,
          serverVersion: startedServerVersion,
          port: opts.port ?? 18_765,
          pid: 321,
          releaseId,
          stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
          ...(opts.transactionId === undefined ? {} : { transactionId: opts.transactionId }),
        }
        return {
          state: 'ready',
          session: {
            ownership: running,
            stop: async () => {
              running = null
              return { state: 'stopped' as const }
            },
          },
        }
      },
    },
    calls,
  }
}

function updateEnv(
  run: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string },
  runtimeEnv: NodeJS.ProcessEnv = {},
  target: StableReleaseTarget = STABLE_TARGET,
): { env: SetupEnv; calls: Calls } {
  const calls: Calls = { exec: [], writes: [] }
  const mutationBaselines = new Map<string, number>()
  const env: SetupEnv = {
    homeDir: () => '/home/update-test',
    runtimeEnv: () => runtimeEnv,
    pluginRoot: () => '/old/tenon',
    selfPath: () => '/old/tenon/packages/cli/dist/tenon.mjs',
    mkdirp: () => undefined,
    pathExists: () => false,
    readText: (path) => {
      if (path === '/new/marketplace/.codex-marketplace-install.json'
        || path === '/new/tenon/.codex-marketplace-install.json') {
        return JSON.stringify({ ref_name: target.tag })
      }
      if (path === '/new/tenon/.codex-plugin/plugin.json'
        || path === '/new/tenon/.claude-plugin/plugin.json') {
        return JSON.stringify({ version: target.version })
      }
      return undefined
    },
    readTextState: (path) => {
      const text = env.readText(path)
      return text === undefined ? { state: 'missing' } : { state: 'ok', text }
    },
    commandExists: () => false,
    resolveHostCommand: (host) => nativeHostCommandBinding(host, 'darwin', {}),
    codexAuthStatus: async () => ({ state: 'unauthenticated' }),
    listDir: () => [],
    writeText: (path, text) => { calls.writes.push([path, text]) },
    writeTextAtomic: (path, text) => { calls.writes.push([path, text]) },
    inspectCandidatePayload: async () => ({
      pluginVersion: target.version,
      payloadDigest: 'b'.repeat(64),
    }),
    runCommand: (cmd, args) => {
      calls.exec.push([cmd, args])
      if (cmd === 'git' && args.join(' ') === [
        'ls-remote',
        'https://github.com/jefferysha/tenon.git',
        `refs/tags/${target.tag}`,
        `refs/tags/${target.tag}^{}`,
      ].join(' ')) {
        return {
          code: 0,
          stdout: `${target.commit}\trefs/tags/${target.tag}\n`,
          stderr: '',
        }
      }
      if (cmd === 'git' && args[0] === 'init') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[2] === 'fetch') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[2] === 'rev-parse' && args[3] === 'FETCH_HEAD^{commit}') {
        return { code: 0, stdout: `${target.commit}\n`, stderr: '' }
      }
      if (cmd === 'git' && args[2] === 'cat-file') {
        return { code: 0, stdout: 'commit\n', stderr: '' }
      }
      const result = run(cmd, args)
      const text = `${cmd} ${args.join(' ')}`
      if (result.stdout.trim() !== '' || result.code !== 0) {
        if (!(text.includes(' symbolic-ref --quiet --short HEAD') && result.code !== 0)) return result
      }
      if (text.endsWith('plugin marketplace list --json')) {
        return cmd.endsWith('claude')
          ? {
              code: 0,
              stdout: JSON.stringify([{
                name: 'tenon',
                installLocation: '/new/marketplace',
                repo: 'jefferysha/tenon',
                source: 'github',
              }]),
              stderr: '',
            }
          : {
              code: 0,
              stdout: JSON.stringify({ marketplaces: [{
                name: 'tenon',
                root: '/new/marketplace',
                marketplaceSource: { sourceType: 'git', source: 'jefferysha/tenon' },
              }] }),
              stderr: '',
            }
      }
      if (/git -C \/new\/(?:marketplace|tenon) rev-parse HEAD$/.test(text)) {
        return { code: 0, stdout: `${target.commit}\n`, stderr: '' }
      }
      if (/git -C \/new\/(?:marketplace|tenon) remote get-url origin$/.test(text)) {
        return { code: 0, stdout: 'https://github.com/jefferysha/tenon.git\n', stderr: '' }
      }
      if (/git -C \/new\/(?:marketplace|tenon) diff --quiet HEAD --$/.test(text)
        || /git -C \/new\/(?:marketplace|tenon) ls-files --others --exclude-standard$/.test(text)
        || text.startsWith('git diff --no-index --quiet -- ')) {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (text === 'git -C /new/marketplace describe --tags --exact-match HEAD') {
        return { code: 0, stdout: `${target.tag}\n`, stderr: '' }
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
    confirm: () => true,
  }
  return { env, calls }
}

const CODEX_INVENTORY = JSON.stringify({
  installed: [{
    pluginId: 'tenon@tenon',
    name: 'tenon',
    marketplaceName: 'tenon',
    version: '1.2.3',
    source: { path: '/new/tenon' },
  }],
})

const STABLE_TARGET = { version: '1.2.3', tag: 'v1.2.3', commit: 'a'.repeat(40) }
const STABLE_RESOLVER = { resolve: async () => STABLE_TARGET }

function exactStableHostEnv(inventory = CODEX_INVENTORY) {
  return updateEnv((cmd, args) => {
    const text = `${cmd} ${args.join(' ')}`
    if (text === 'codex plugin list --json') return { code: 0, stdout: inventory, stderr: '' }
    if (text === 'codex plugin marketplace list --json') {
      return {
        code: 0,
        stdout: JSON.stringify({ marketplaces: [{
          name: 'tenon',
          root: '/new/tenon',
          marketplaceSource: { sourceType: 'git', source: 'jefferysha/tenon' },
        }] }),
        stderr: '',
      }
    }
    if (/^git -C \/new\/(?:marketplace|tenon) rev-parse HEAD$/.test(text)) {
      return { code: 0, stdout: `${STABLE_TARGET.commit}\n`, stderr: '' }
    }
    if (text === 'git -C /new/tenon remote get-url origin') {
      return { code: 0, stdout: 'https://github.com/jefferysha/tenon.git\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}

function requireVersionedHostRebind(
  env: SetupEnv,
  calls: Calls,
  host: 'codex' | 'claude',
  target: StableReleaseTarget = STABLE_TARGET,
): void {
  const registered = () => calls.exec.some(([, args]) => args[0] === 'plugin'
    && args[1] === 'marketplace'
    && args[2] === 'add')
  const readText = env.readText
  env.readText = (path) => host === 'codex'
    && path.endsWith('/.codex-marketplace-install.json')
    ? JSON.stringify({ ref_name: registered() ? target.tag : 'main' })
    : readText(path)
  const runCommand = env.runCommand
  env.runCommand = (command, args) => {
    const result = runCommand(command, args)
    if (host === 'claude'
      && command === 'git'
      && args.includes('symbolic-ref')
      && !registered()) {
      return { code: 0, stdout: 'main\n', stderr: '' }
    }
    return result
  }
}

function hostMutationCommands(calls: Calls, host: 'codex' | 'claude'): string[] {
  return calls.exec
    .filter(([command, args]) => command.endsWith(host)
      && args[0] === 'plugin'
      && !(args[1] === 'list' || (args[1] === 'marketplace' && args[2] === 'list')))
    .map(([command, args]) => `${command.split('/').at(-1)} ${args.join(' ')}`)
}

describe('native plugin update plans', () => {
  test('Codex and Claude plans use each host marketplace and finish with a host-owned inventory', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'a'.repeat(40) }
    expect(nativeUpdatePlan('codex', target)).toEqual([
      { cmd: 'codex', args: ['plugin', 'remove', 'tenon@tenon', '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'tenon', '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'add', 'jefferysha/tenon', '--ref', 'v1.2.3', '--json'] },
      { cmd: 'codex', args: ['plugin', 'add', 'tenon@tenon', '--json'] },
      { cmd: 'codex', args: ['plugin', 'list', '--json'] },
    ])
    expect(nativeUpdatePlan('claude', target)).toEqual([
      { cmd: 'claude', args: ['plugin', 'uninstall', 'tenon@tenon', '--scope', 'user'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', 'tenon'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'add', 'jefferysha/tenon@v1.2.3'] },
      { cmd: 'claude', args: ['plugin', 'install', 'tenon@tenon'] },
      { cmd: 'claude', args: ['plugin', 'list', '--json'] },
    ])
    expect(nativeInstallPlan('codex', '1.2.3')).toEqual([
      { cmd: 'codex', args: ['plugin', 'marketplace', 'add', 'jefferysha/tenon', '--ref', 'v1.2.3', '--json'] },
      { cmd: 'codex', args: ['plugin', 'add', 'tenon@tenon', '--json'] },
      { cmd: 'codex', args: ['plugin', 'list', '--json'] },
    ])
    expect(nativeInstallPlan('claude', '1.2.3')[0]).toEqual({
      cmd: 'claude',
      args: ['plugin', 'marketplace', 'add', 'jefferysha/tenon@v1.2.3'],
    })
  })

  test('parses only the matching host inventory entry; no cache layout is inferred', () => {
    expect(installedPipelineRoot('codex', CODEX_INVENTORY)).toBe('/new/tenon')
    expect(installedPipelineRoot('claude', JSON.stringify([
      { id: 'tenon@tenon', installPath: '/new/claude-tenon' },
    ]))).toBe('/new/claude-tenon')
    expect(installedPipelineRoot('codex', JSON.stringify({ installed: [] }))).toBeNull()
    expect(installedPipelineRoot('claude', 'not json')).toBeNull()
  })

  test('parses only enabled plugin ids from host inventory', () => {
    const ids = enabledHostPluginIds('codex', JSON.stringify({
      installed: [
        { pluginId: 'tenon@tenon', enabled: true },
        { pluginId: 'disabled@source', enabled: false },
      ],
    }))
    expect(ids === null ? null : [...ids]).toEqual(['tenon@tenon'])
    expect(enabledHostPluginIds('codex', 'not json')).toBeNull()
    expect(enabledHostPluginIds('codex', JSON.stringify({ installed: 'not-an-array' }))).toBeNull()
    expect(enabledHostPluginIds('codex', JSON.stringify({ installed: [] }))).toEqual(new Set())
  })

  test('Claude inventory preserves managed scope for administrator-required convergence', () => {
    const parsed = parseHostPluginInventory('claude', JSON.stringify([
      { id: 'pipeline-lite@pipeline-lite', enabled: true, scope: 'managed' },
      { id: 'tenon@tenon', enabled: true, scope: 'user', installPath: '/installed/tenon' },
    ]))
    expect(parsed?.enabledScopes.get('pipeline-lite@pipeline-lite')).toEqual(new Set(['managed']))
  })

  test('Claude inventory 保留 Tenon 自身的加载错误，其它插件的错误不混入', () => {
    const loadError = 'Hook load failed: Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file'
    const broken = parseHostPluginInventory('claude', JSON.stringify([
      { id: 'other@market', enabled: true, errors: ['other plugin error'] },
      {
        id: 'tenon@tenon',
        version: '1.1.0',
        scope: 'user',
        enabled: true,
        installPath: '/installed/tenon',
        errors: [loadError],
        errorDetails: [{ type: 'hook-load-failed', plugin: 'tenon', path: '/installed/tenon/hooks/hooks.json' }],
      },
    ]))
    expect(broken?.enabledIds.has('tenon@tenon')).toBe(true)
    expect(broken?.tenonLoadErrors).toEqual([loadError])
    const healthy = parseHostPluginInventory('claude', JSON.stringify([
      { id: 'tenon@tenon', enabled: true, installPath: '/installed/tenon', errors: [] },
    ]))
    expect(healthy?.tenonLoadErrors).toEqual([])
  })

  test('inventory decoder 对禁用根、畸形 enabled、重复登记和非绝对路径全部失败关闭', () => {
    expect(parseHostPluginInventory('codex', JSON.stringify({
      installed: [{
        pluginId: 'tenon@tenon',
        name: 'tenon',
        marketplaceName: 'tenon',
        enabled: false,
        source: { path: '/disabled/tenon' },
      }],
    }))).toMatchObject({ enabledIds: new Set(), tenonRoot: null })
    expect(parseHostPluginInventory('codex', JSON.stringify({
      installed: [{ pluginId: 'tenon@tenon', enabled: 'false' }],
    }))).toBeNull()
    expect(parseHostPluginInventory('codex', JSON.stringify({
      installed: [
        { pluginId: 'tenon@tenon', enabled: true },
        { pluginId: 'tenon@tenon', enabled: true },
      ],
    }))).toBeNull()
    expect(parseHostPluginInventory('codex', JSON.stringify({
      installed: [{
        pluginId: 'tenon@tenon',
        name: 'tenon',
        marketplaceName: 'tenon',
        enabled: true,
        source: { path: 'relative/tenon' },
      }],
    }))).toBeNull()
  })

  test('Claude 清理计划保留 inventory 报告的精确 scope', () => {
    expect(nativePluginRemovalPlan('claude', 'conflict@source', 'project')).toEqual([{
      cmd: 'claude',
      args: ['plugin', 'uninstall', 'conflict@source', '--scope', 'project'],
    }])
    const inventory = parseHostPluginInventory('claude', JSON.stringify([
      { id: 'conflict@source', enabled: true, scope: 'project' },
      { id: 'conflict@source', enabled: true, scope: 'local' },
      { id: 'tenon@tenon', enabled: true, scope: 'user', installPath: '/installed/tenon' },
    ]))
    expect([...(inventory?.enabledScopes.get('conflict@source') ?? [])]).toEqual(['project', 'local'])
  })
})

describe('caller-level update provenance replay', () => {
  test('verifyUpdatedRoot replays frozen Bash and Node before the verifier spawn', () => {
    const deps = makeDeps()
    const root = '/new/tenon'
    const events: string[] = []
    const frozenBash = fakeTrustedExecutable('/trusted/runtime/bash', () => {
      events.push('bash-proof')
      return true
    })
    const frozenNode = fakeTrustedExecutable('/trusted/runtime/node', () => {
      events.push('node-proof')
      return true
    })
    const { env, calls } = updateEnv(() => ({ code: 0, stdout: '', stderr: '' }))
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

    expect(verifyUpdatedRoot(deps, env, root, STABLE_TARGET.version)).toBe(true)
    expect(events).toEqual(['bash-proof', 'node-proof', 'spawn'])
    expect(calls.exec).toEqual([])
    expect(calls.writes).toEqual([])
  })

  test('verifyUpdatedRoot fails closed on Node drift without a verifier runner', () => {
    const deps = makeDeps()
    const root = '/new/tenon'
    const events: string[] = []
    const frozenBash = fakeTrustedExecutable('/trusted/runtime/bash', () => {
      events.push('bash-proof')
      return true
    })
    const frozenNode = fakeTrustedExecutable('/trusted/runtime/node', () => {
      events.push('node-proof')
      return false
    })
    const { env, calls } = updateEnv(() => ({ code: 0, stdout: '', stderr: '' }))
    env.resolveTrustedCommandBinding = (name) => name === 'bash' ? frozenBash : frozenNode
    let runnerCalls = 0
    env.runTrustedLifecycleCommand = () => {
      runnerCalls += 1
      events.push('spawn')
      return { code: 0, stdout: '', stderr: '' }
    }

    expect(verifyUpdatedRoot(deps, env, root, STABLE_TARGET.version)).toBe(false)
    expect(events).toEqual(['bash-proof', 'node-proof'])
    expect(runnerCalls).toBe(0)
    expect(calls.exec).toEqual([])
    expect(calls.writes).toEqual([])
    expect(deps.errLines.join('\n')).toContain('新插件资产校验失败')
  })
})

describe('tenon update', () => {
  test('requires exactly one host selector', () => {
    const deps = makeDeps()
    const { env } = updateEnv(() => ({ code: 0, stdout: '', stderr: '' }))
    expect(cmdUpdate(deps, {}, env)).toBe(1)
    expect(deps.errLines.join('\n')).toContain('必须指定一个宿主')

    const both = makeDeps()
    expect(cmdUpdate(both, { codex: true, claude: true }, env)).toBe(1)
    expect(both.errLines.join('\n')).toContain('一次只能指定一个宿主')
  })

  test('--dry-run is read-only: it prints the exact refresh plan without marketplace calls or runtime publication', () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    expect(cmdUpdate(deps, { codex: true, dryRun: true }, env)).toBe(0)
    expect(deps.outLines.join('\n')).toContain('codex plugin marketplace add jefferysha/tenon --ref <latest-stable> --json')
    expect(deps.outLines.join('\n')).toContain('dry-run 不联网')
    expect(calls.exec).toEqual([])
    expect(calls.writes).toEqual([])
  })

  test('a missing trusted Codex CLI fails before update mutation and gives an acquisition path', () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    env.resolveHostCommand = () => undefined

    expect(cmdUpdate(deps, { codex: true }, env)).toBe(1)
    const output = [...deps.outLines, ...deps.errLines].join('\n')
    expect(output).toContain('npm install -g @openai/codex')
    expect(output).toContain('codex --version')
    expect(calls.exec).toEqual([])
    expect(calls.writes).toEqual([])
  })

  test('stable Release resolution failure is zero-write before any host mutation', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv(() => ({ code: 0, stdout: '', stderr: '' }))
    const runtime = fakeRuntimeInstaller()

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      { resolve: async () => { throw new Error('injected timeout') } },
    )).toBe(1)
    expect(calls.exec).toEqual([])
    expect(calls.writes).toEqual([])
    expect(runtime.calls.activations).toEqual([])
    expect(runtime.calls.failures).toEqual([])
    expect(deps.errLines.join('\n')).toContain('injected timeout')
  })

  test('a newer installed stable version rejects downgrade without host or runtime mutation', async () => {
    const deps = makeDeps()
    const newerInventory = JSON.stringify({
      installed: [{
        pluginId: 'tenon@tenon',
        name: 'tenon',
        marketplaceName: 'tenon',
        version: '2.0.0',
        source: { path: '/new/tenon' },
      }],
    })
    const { env, calls } = updateEnv((cmd, args) =>
      cmd === 'codex' && args.join(' ') === 'plugin list --json'
        ? { code: 0, stdout: newerInventory, stderr: '' }
        : { code: 0, stdout: '', stderr: '' })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
    )).toBe(1)
    expect(calls.exec.filter(([cmd]) => cmd !== 'git').map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([
      ['codex', 'plugin list --json'],
    ])
    expect(runtime.calls.activations).toEqual([])
    expect(deps.errLines.join('\n')).toContain('拒绝从宿主 plugin 2.0.0 降级到 1.2.3')
  })

  test('a newer verified managed runtime rejects downgrade even when the host plugin is absent', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) =>
      cmd === 'codex' && args.join(' ') === 'plugin list --json'
        ? { code: 0, stdout: JSON.stringify({ installed: [] }), stderr: '' }
        : { code: 0, stdout: '', stderr: '' })
    const activeRelease = `sha256-${'d'.repeat(64)}`
    const runtime = fakeRuntimeInstaller(false, null, activeRelease, '2.0.0')

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
    )).toBe(1)
    expect(calls.exec.filter(([cmd]) => cmd !== 'git').map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([
      ['codex', 'plugin list --json'],
    ])
    expect(runtime.calls.activations).toEqual([])
    expect(deps.errLines.join('\n')).toContain('拒绝从active managed runtime 2.0.0 降级到 1.2.3')
  })

  const RESET_TARGET = { version: '0.1.0', tag: 'v0.1.0', commit: 'a'.repeat(40) }
  const codexInventory = (version: string) => JSON.stringify({
    installed: [{
      pluginId: 'tenon@tenon',
      name: 'tenon',
      marketplaceName: 'tenon',
      version,
      source: { path: '/new/tenon' },
    }],
  })

  test('a retired 1.x host plugin and runtime migrate to 0.x instead of being rejected as downgrade', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd !== 'codex' || args.join(' ') !== 'plugin list --json') return { code: 0, stdout: '', stderr: '' }
      const installed = calls.exec.some(([command, called]) => command === 'codex'
        && called.join(' ') === 'plugin add tenon@tenon --json')
      return { code: 0, stdout: codexInventory(installed ? RESET_TARGET.version : '1.1.5'), stderr: '' }
    }, {}, RESET_TARGET)
    requireVersionedHostRebind(env, calls, 'codex', RESET_TARGET)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, '1.1.5')

    const result = await cmdUpdate(
      deps,
      { codex: true, auto: true },
      env,
      runtime.installer,
      fakeDashboardStarter([], null, '1.2.3', undefined, RESET_TARGET.version).starter,
      { resolve: async () => RESET_TARGET },
      async () => ({ pluginVersion: RESET_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )
    expect(result, deps.errLines.join('\n')).toBe(0)
    expect(runtime.calls.activations).toHaveLength(1)
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && args.join(' ') === 'plugin marketplace add jefferysha/tenon --ref v0.1.0 --json')).toBe(true)
    expect(deps.outLines.join('\n')).toContain('宿主 plugin 1.1.5 属于已退役的 1.x 版本线；迁移到 0.1.0')
    expect(deps.errLines.join('\n')).not.toContain('拒绝从')
  })

  test('a newer 0.x host plugin still rejects update to an older 0.x', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) =>
      cmd === 'codex' && args.join(' ') === 'plugin list --json'
        ? { code: 0, stdout: codexInventory('0.1.1'), stderr: '' }
        : { code: 0, stdout: '', stderr: '' }, {}, RESET_TARGET)
    const runtime = fakeRuntimeInstaller()

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      { resolve: async () => RESET_TARGET },
    )).toBe(1)
    expect(calls.exec.filter(([cmd]) => cmd !== 'git').map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([
      ['codex', 'plugin list --json'],
    ])
    expect(runtime.calls.activations).toEqual([])
    expect(deps.errLines.join('\n')).toContain('拒绝从宿主 plugin 0.1.1 降级到 0.1.0')
  })

  test('cleanup-pending for a retired 1.x runtime does not block the 0.x migration', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env, calls } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: codexInventory(RESET_TARGET.version), stderr: '' }
      : { code: 0, stdout: '', stderr: '' }, {}, RESET_TARGET)
    requireVersionedHostRebind(env, calls, 'codex', RESET_TARGET)
    const baseReadText = env.readText
    env.readText = (path) => path === receiptPath
      ? JSON.stringify({
          version: 4,
          transactionId: 'retired-cleanup-transaction',
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/old/tenon',
          stableTarget: { version: '1.1.5', tag: 'v1.1.5', commit: 'c'.repeat(40) },
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-09-15T00:00:00Z',
        })
      : baseReadText(path)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, '1.1.5')

    const result = await cmdUpdate(
      deps,
      { codex: true, auto: true },
      env,
      runtime.installer,
      fakeDashboardStarter([], null, '1.2.3', undefined, RESET_TARGET.version).starter,
      { resolve: async () => RESET_TARGET },
      async () => ({ pluginVersion: RESET_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )
    expect(result, deps.errLines.join('\n')).toBe(0)
    expect(runtime.calls.activations).toHaveLength(1)
    expect(deps.outLines.join('\n')).toContain('检测到旧 1.1.5 cleanup-pending；继续发布更高 stable 0.1.0')
  })

  test('an exact stable host, managed runtime, and Dashboard is a zero-mutation no-op', async () => {
    const deps = makeDeps()
    const activeRelease = `sha256-${'c'.repeat(64)}`
    const { env, calls } = updateEnv((cmd, args) => {
      const text = `${cmd} ${args.join(' ')}`
      if (text === 'codex plugin list --json') return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      if (text === 'codex plugin marketplace list --json') {
        return {
          code: 0,
          stdout: JSON.stringify({ marketplaces: [{
            name: 'tenon',
            root: '/new/tenon',
            marketplaceSource: { sourceType: 'git', source: 'jefferysha/tenon' },
          }] }),
          stderr: '',
        }
      }
      if (/^git -C \/new\/(?:marketplace|tenon) rev-parse HEAD$/.test(text)) {
        return { code: 0, stdout: `${STABLE_TARGET.commit}\n`, stderr: '' }
      }
      if (text === 'git -C /new/tenon remote get-url origin') {
        return { code: 0, stdout: 'https://github.com/jefferysha/tenon.git\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller(
      false,
      activeRelease,
      activeRelease,
      STABLE_TARGET.version,
      STABLE_TARGET,
    )
    const dashboard = fakeDashboardStarter([], activeRelease)

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({
        pluginVersion: STABLE_TARGET.version,
        payloadDigest: 'c'.repeat(64),
      }),
    ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)
    expect(calls.exec
      .filter(([cmd, args]) => !(cmd === 'git' && (
        args[0] === 'ls-remote'
        || args[0] === 'init'
        || (args[0] === '-C' && args[1]?.includes('/tenon-stable-tag-') === true)
      )))
      .map(([cmd, args]) => [cmd, args.join(' ')])).toEqual([
      ['codex', 'plugin list --json'],
      ['codex', 'plugin marketplace list --json'],
      ['git', '-C /new/tenon rev-parse HEAD'],
      ['git', '-C /new/tenon diff --quiet HEAD --'],
      ['git', '-C /new/tenon ls-files --others --exclude-standard'],
      ['codex', 'plugin list --json'],
      ['git', '-C /new/tenon remote get-url origin'],
      ['bash', `/new/tenon/tools/verify-skills.sh --quiet --root /new/tenon --node ${process.execPath}`],
      ['codex', 'plugin marketplace list --json'],
      ['git', '-C /new/tenon rev-parse HEAD'],
      ['git', '-C /new/tenon diff --quiet HEAD --'],
      ['git', '-C /new/tenon ls-files --others --exclude-standard'],
      ['codex', 'plugin list --json'],
      ['git', '-C /new/tenon remote get-url origin'],
    ])
    expect(runtime.calls.activations).toEqual([])
    expect(dashboard.calls.starts).toEqual([])
    expect(deps.outLines.join('\n')).toContain('无需更新')
    expect(deps.outLines.join('\n')).toContain('http://127.0.0.1:18765/')
  })

  test.each([
    ['without a prior receipt', false],
    ['after a prior completed receipt', true],
  ] as const)(
    'an exact release with a re-enabled legacy plugin records cleanup instead of claiming no-op %s',
    async (_label, hasCompletedReceipt) => {
      const deps = makeDeps()
      const activeRelease = `sha256-${'c'.repeat(64)}`
      const conflictInventory = JSON.stringify({
        installed: [
          {
            pluginId: 'tenon@tenon',
            name: 'tenon',
            marketplaceName: 'tenon',
            enabled: true,
            scope: 'user',
            version: STABLE_TARGET.version,
            source: { path: '/new/tenon' },
          },
          {
            pluginId: 'pipeline-lite@pipeline-lite',
            enabled: true,
            scope: 'user',
            source: { path: '/legacy/re-enabled' },
          },
        ],
      })
      const { env, calls } = exactStableHostEnv(conflictInventory)
      const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
      const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
      if (hasCompletedReceipt) {
        const baseReadText = env.readText
        env.readText = (path) => path === receiptPath
          ? JSON.stringify({
              version: 4,
              transactionId: 'completed-transaction',
              state: 'completed',
              host: 'codex',
              conflictPluginId: 'pipeline-lite@pipeline-lite',
              conflictScopes: [],
              releaseId: activeRelease,
              releaseRoot: `/runtime/releases/${activeRelease}/payload`,
              candidateRoot: '/new/tenon',
              stableTarget: STABLE_TARGET,
              createdAtEpoch: 1_700_000_000,
              updatedAt: '2026-08-08T00:00:00Z',
            })
          : baseReadText(path)
      }
      const runtime = fakeRuntimeInstaller(
        false,
        activeRelease,
        activeRelease,
        STABLE_TARGET.version,
        STABLE_TARGET,
      )
      const dashboard = fakeDashboardStarter(
        [],
        activeRelease,
        STABLE_TARGET.version,
        'previous-dashboard-transaction',
      )

      expect(await cmdUpdate(
        deps,
        { codex: true },
        env,
        runtime.installer,
        dashboard.starter,
        STABLE_RESOLVER,
        async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'c'.repeat(64) }),
      ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)

      expect(hostMutationCommands(calls, 'codex')).toEqual([])
      expect(runtime.calls.activations).toEqual([])
      expect(dashboard.calls.starts).toEqual([])
      const receiptWrites = calls.writes
        .filter(([path]) => path === receiptPath)
        .map(([, text]) => JSON.parse(text))
      expect(receiptWrites.at(-1)).toMatchObject({
        version: 4,
        transactionId: 'update-test-transaction',
        state: 'cleanup-pending',
        conflictScopes: ['user'],
        releaseId: activeRelease,
        stableTarget: STABLE_TARGET,
      })
      expect(deps.outLines.join('\n')).toContain('请启动新宿主会话')
      expect(deps.outLines.join('\n')).not.toContain('无需更新')
    },
  )

  test('an exact host/runtime with no Dashboard repairs only the Dashboard', async () => {
    const deps = makeDeps()
    const activeRelease = `sha256-${'c'.repeat(64)}`
    const { env, calls } = exactStableHostEnv()
    const runtime = fakeRuntimeInstaller(
      false,
      activeRelease,
      activeRelease,
      STABLE_TARGET.version,
      STABLE_TARGET,
    )
    const dashboard = fakeDashboardStarter([], null)

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'c'.repeat(64) }),
    ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)

    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
    expect(runtime.calls.activations).toEqual([])
    expect(dashboard.calls.starts).toEqual([[
      join(resolveRuntimePaths({ homeDir: '/home/update-test', env: {} }).releasesRoot, activeRelease, 'payload'),
      { openBrowser: false, port: 18_765, transactionId: 'update-test-transaction', expectedServerVersion: STABLE_TARGET.version },
    ]])
  })

  test('an exact stable host with a legacy same-version runtime republishes only the managed runtime', async () => {
    const deps = makeDeps()
    const legacyRelease = `sha256-${'c'.repeat(64)}`
    const { env, calls } = exactStableHostEnv()
    const runtime = fakeRuntimeInstaller(
      false,
      legacyRelease,
      legacyRelease,
      STABLE_TARGET.version,
    )
    const dashboard = fakeDashboardStarter([], null)

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)

    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
    expect(runtime.calls.activations).toEqual([['/new/tenon', 'codex', '/home/update-test']])
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'b'.repeat(64)}/payload`,
      { openBrowser: false, port: 18_765, transactionId: 'update-test-transaction', expectedServerVersion: STABLE_TARGET.version },
    ]])
  })

  test('an exact v2 runtime with drifted launchers republishes runtime without host rebind', async () => {
    const deps = makeDeps()
    const activeRelease = `sha256-${'b'.repeat(64)}`
    const { env, calls } = exactStableHostEnv()
    const runtime = fakeRuntimeInstaller(
      false,
      activeRelease,
      activeRelease,
      STABLE_TARGET.version,
      STABLE_TARGET,
      false,
    )
    const dashboard = fakeDashboardStarter([], null)

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)

    expect(hostMutationCommands(calls, 'codex')).toEqual([])
    expect(runtime.calls.activations).toEqual([['/new/tenon', 'codex', '/home/update-test']])
  })

  test('an exact host/runtime with a wrong-version owned Dashboard restarts only the Dashboard', async () => {
    const deps = makeDeps()
    const activeRelease = `sha256-${'c'.repeat(64)}`
    const { env, calls } = exactStableHostEnv()
    const runtime = fakeRuntimeInstaller(
      false,
      activeRelease,
      activeRelease,
      STABLE_TARGET.version,
      STABLE_TARGET,
    )
    let running: Awaited<ReturnType<ReleasedDashboardStarter['inspect']>> = {
      version: 1,
      serverVersion: '9.9.9',
      port: 18_765,
      pid: 700,
      releaseId: activeRelease,
      stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
      transactionId: 'previous-dashboard',
    }
    let stops = 0
    let starts = 0
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async (_deps, identity) => running?.pid !== identity.pid
        ? null
        : {
            ownership: running,
            stop: async () => {
              stops += 1
              running = null
              return { state: 'stopped' as const }
            },
          },
      start: async (_deps, payloadRoot, opts) => {
        starts += 1
        running = {
          version: 1,
          serverVersion: STABLE_TARGET.version,
          port: opts.port ?? 18_765,
          pid: 701,
          releaseId: payloadRoot.split('/').at(-2)!,
          stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
          transactionId: opts.transactionId,
        }
        return {
          state: 'ready' as const,
          session: { ownership: running, stop: async () => ({ state: 'stopped' as const }) },
        }
      },
    }

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'c'.repeat(64) }),
    ), `${deps.errLines.join('\n')}\n${deps.outLines.join('\n')}`).toBe(0)
    expect(stops).toBe(1)
    expect(starts).toBe(1)
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
    expect(runtime.calls.activations).toEqual([])
  })

  test('a failed wrong-version Dashboard replacement remains retryable without host or runtime replay', async () => {
    const deps = makeDeps()
    const activeRelease = `sha256-${'c'.repeat(64)}`
    const { env, calls } = exactStableHostEnv()
    const runtime = fakeRuntimeInstaller(
      false,
      activeRelease,
      activeRelease,
      STABLE_TARGET.version,
      STABLE_TARGET,
    )
    let running: Awaited<ReturnType<ReleasedDashboardStarter['inspect']>> = {
      version: 1,
      serverVersion: '9.9.9',
      port: 18_765,
      pid: 710,
      releaseId: activeRelease,
      stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
      transactionId: 'previous-dashboard',
    }
    let stops = 0
    let starts = 0
    const dashboard: ReleasedDashboardStarter = {
      inspect: async () => running,
      adopt: async (_deps, identity) => running?.pid !== identity.pid
        ? null
        : {
            ownership: running,
            stop: async () => {
              stops += 1
              running = null
              return { state: 'stopped' as const }
            },
          },
      start: async (_deps, payloadRoot, opts) => {
        starts += 1
        if (starts === 1) return { state: 'failed' as const, detail: 'injected first readiness failure' }
        running = {
          version: 1,
          serverVersion: STABLE_TARGET.version,
          port: opts.port ?? 18_765,
          pid: 711,
          releaseId: payloadRoot.split('/').at(-2)!,
          stateScopeId: `sha256-v1-${'1'.repeat(64)}`,
          transactionId: opts.transactionId,
        }
        return {
          state: 'ready' as const,
          session: { ownership: running, stop: async () => ({ state: 'stopped' as const }) },
        }
      },
    }

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'c'.repeat(64) }),
    )).toBe(1)
    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'c'.repeat(64) }),
    )).toBe(0)
    expect(stops).toBe(1)
    expect(starts).toBe(2)
    expect(runtime.calls.activations).toEqual([])
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
  })

  test('a verified Codex update refreshes only the selected host and atomically publishes the managed runtime', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }, { TENON_DASHBOARD_PORT: '43210' })
    requireVersionedHostRebind(env, calls, 'codex')

    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()
    expect(await cmdUpdate(deps, { codex: true }, env, runtime.installer, dashboard.starter, STABLE_RESOLVER)).toBe(0)
    expect(hostMutationCommands(calls, 'codex')).toEqual([
      'codex plugin remove tenon@tenon --json',
      'codex plugin marketplace remove tenon --json',
      'codex plugin marketplace add jefferysha/tenon --ref v1.2.3 --json',
      'codex plugin add tenon@tenon --json',
    ])
    expect(calls.exec.some(([cmd, args]) => cmd === 'bash'
      && args.join(' ') === `/new/tenon/tools/verify-skills.sh --quiet --root /new/tenon --node ${process.execPath}`)).toBe(true)
    expect(runtime.calls.activations).toEqual([['/new/tenon', 'codex', '/home/update-test']])
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'b'.repeat(64)}/payload`,
      { openBrowser: false, port: 43_210, transactionId: 'update-test-transaction', expectedServerVersion: '1.2.3' },
    ]])
    expect(deps.outLines.join('\n')).toContain('稳定 tenon launcher 已保持不变')
    expect(deps.outLines.join('\n')).toContain('输入 /hooks')
    expect(deps.outLines.join('\n')).toContain('codex login --device-auth')
    expect(deps.outLines.join('\n')).toContain('platform.openai.com/api-keys')
  })

  test('rejects activation when the marketplace HEAD drifts after candidate verification', async () => {
    const deps = makeDeps()
    let inventoryReads = 0
    let headReads = 0
    const { env } = updateEnv((cmd, args) => {
      const text = `${cmd} ${args.join(' ')}`
      if (text === 'codex plugin list --json') {
        inventoryReads += 1
        return {
          code: 0,
          stdout: inventoryReads === 1 ? JSON.stringify({ installed: [] }) : CODEX_INVENTORY,
          stderr: '',
        }
      }
      if (/^git -C \/new\/(?:marketplace|tenon) rev-parse HEAD$/.test(text)) {
        headReads += 1
        return {
          code: 0,
          stdout: `${headReads === 1 ? STABLE_TARGET.commit : 'f'.repeat(40)}\n`,
          stderr: '',
        }
      }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
    )).toBe(1)
    expect(runtime.calls.activations).toEqual([])
    expect(deps.errLines.join('\n')).toContain('候选校验后 marketplace/tag commit 发生漂移')
  })

  test('Codex update binds inventory, mutation, observation, and auth to one trusted absolute executable', async () => {
    const deps = makeDeps()
    const trustedCodex = '/trusted/bin/codex'
    const authExecutables: Array<string | undefined> = []
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === trustedCodex && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    requireVersionedHostRebind(env, calls, 'codex')
    env.resolveHostCommand = () => nativeHostCommandBinding(trustedCodex, 'darwin', {})
    env.codexAuthStatus = async (executable) => {
      authExecutables.push(executable)
      return { state: 'authenticated' }
    }

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      fakeRuntimeInstaller().installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
    )).toBe(0)

    const hostCalls = calls.exec.filter(([, args]) => args[0] === 'plugin')
    expect(hostCalls.length).toBeGreaterThan(0)
    expect(hostCalls.every(([command]) => command === trustedCodex)).toBe(true)
    expect(calls.exec.some(([command]) => command === 'codex')).toBe(false)
    expect(authExecutables).toEqual([trustedCodex])
  })

  test('a successful Claude update never probes or prints Codex authentication', async () => {
    const deps = makeDeps()
    let authCalls = 0
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: '[{"id":"tenon@tenon","version":"1.2.3","installPath":"/new/tenon"}]', stderr: '' }
      }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    requireVersionedHostRebind(env, calls, 'claude')
    env.codexAuthStatus = async () => {
      authCalls += 1
      return { state: 'unauthenticated' }
    }
    expect(await cmdUpdate(
      deps,
      { claude: true },
      env,
      fakeRuntimeInstaller().installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
    )).toBe(0)
    expect(authCalls).toBe(0)
    expect(deps.outLines.join('\n')).not.toContain('[Codex 认证]')
    expect(hostMutationCommands(calls, 'claude')).toEqual([
      'claude plugin uninstall tenon@tenon --scope user',
      'claude plugin marketplace remove tenon',
      'claude plugin marketplace add jefferysha/tenon@v1.2.3',
      'claude plugin install tenon@tenon',
    ])
    expect(calls.exec.some(([cmd, args]) => cmd === 'bash'
      && args.join(' ') === `/new/tenon/tools/verify-skills.sh --quiet --root /new/tenon --node ${process.execPath}`)).toBe(true)
  })

  test('update 发现冲突登记时只记录 cleanup-pending，当前会话不提前删除旧入口', async () => {
    const deps = makeDeps()
    const inventory = JSON.stringify({
      installed: [
        { pluginId: 'pipeline-lite@pipeline-lite', enabled: true, source: { path: '/old/workflow' } },
        {
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          version: '1.2.3',
          enabled: true,
          source: { path: '/new/tenon' },
        },
      ],
    })
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: inventory, stderr: '' }
      }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller()

    expect(await cmdUpdate(deps, { codex: true }, env, runtime.installer, fakeDashboardStarter().starter, STABLE_RESOLVER)).toBe(0)
    expect(calls.exec.some(([cmd, args]) =>
      cmd === 'codex' && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json')).toBe(false)
    const receiptPath = join(
      resolveRuntimePaths({ homeDir: '/home/update-test', env: {} }).migrationsRoot,
      'host-plugin-convergence',
      'codex.json',
    )
    const receiptWrite = calls.writes.find(([path]) => path === receiptPath)
    expect(JSON.parse(receiptWrite?.[1] ?? '{}')).toMatchObject({
      state: 'cleanup-pending',
      releaseId: `sha256-${'b'.repeat(64)}`,
    })
    expect(deps.outLines.join('\n')).toContain('新宿主会话')
  })

  test('update 在 cleanup finalize 的官方 remove 失败时不刷新 marketplace、不发布 runtime', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const inventory = JSON.stringify({
      installed: [
        { pluginId: 'pipeline-lite@pipeline-lite', enabled: true, source: { path: '/old/workflow' } },
        {
          pluginId: 'tenon@tenon',
          name: 'tenon',
          marketplaceName: 'tenon',
          enabled: true,
          version: STABLE_TARGET.version,
          source: { path: '/new/tenon' },
        },
      ],
    })
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: inventory, stderr: '' }
      }
      if (cmd === 'codex' && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json') {
        return { code: 7, stdout: '', stderr: 'remove blocked' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const baseReadText = env.readText
    env.readText = (path) => {
      if (path === receiptPath) {
        return JSON.stringify({
          version: 2,
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/new/tenon',
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-07-26T00:00:00Z',
        })
      }
      if (path === proofPath) {
        return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
      }
      return baseReadText(path)
    }
    const runtime = fakeRuntimeInstaller(false, null, releaseId, STABLE_TARGET.version)
    const dashboard = fakeDashboardStarter([], releaseId, STABLE_TARGET.version)

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )).toBe(1)
    expect(runtime.calls.activations).toEqual([])
    const commands = calls.exec.map(([cmd, args]) => `${cmd} ${args.join(' ')}`)
    const removeIndex = commands.indexOf('codex plugin remove pipeline-lite@pipeline-lite --json')
    expect(removeIndex).toBeGreaterThan(commands.indexOf('codex plugin list --json'))
    expect(commands.slice(0, removeIndex)).toContain('git -C /new/marketplace rev-parse HEAD')
  })

  test('cleanup receipt waiting recovery re-proves runtime and Dashboard before reporting URL', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env, calls } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    const baseReadText = env.readText
    env.readText = (path) => path === receiptPath
      ? JSON.stringify({
          version: 3,
          transactionId: 'recovery-transaction',
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/new/tenon',
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-07-26T00:00:00Z',
        })
      : baseReadText(path)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, STABLE_TARGET.version)
    const dashboard = fakeDashboardStarter([], releaseId, STABLE_TARGET.version)

    expect(await cmdUpdate(
      deps,
      { codex: true, auto: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )).toBe(0)
    expect(runtime.calls.activations).toEqual([])
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
    expect(deps.outLines.join('\n')).toContain('等待新宿主会话')
    expect(deps.outLines.join('\n')).toContain('http://127.0.0.1:18765/')
    expect(deps.outLines.join('\n')).toContain('tenon dashboard --open')
  })

  test('cleanup-pending for an older runtime does not swallow a newer latest stable update', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env, calls } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    requireVersionedHostRebind(env, calls, 'codex')
    const baseReadText = env.readText
    env.readText = (path) => path === receiptPath
      ? JSON.stringify({
          version: 4,
          transactionId: 'older-cleanup-transaction',
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/old/tenon',
          stableTarget: {
            version: '1.0.0',
            tag: 'v1.0.0',
            commit: 'c'.repeat(40),
          },
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-07-26T00:00:00Z',
        })
      : baseReadText(path)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, '1.0.0')

    const result = await cmdUpdate(
      deps,
      { codex: true, auto: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )
    expect(result, deps.errLines.join('\n')).toBe(0)
    expect(runtime.calls.activations).toHaveLength(1)
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && args.join(' ') === 'plugin marketplace add jefferysha/tenon --ref v1.2.3 --json')).toBe(true)
    expect(deps.outLines.join('\n')).not.toContain('等待新宿主会话')
  })

  test('cleanup-pending with an uncomparable legacy runtime version fails closed without mutation', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env, calls } = updateEnv(() => ({ code: 0, stdout: '', stderr: '' }))
    const baseReadText = env.readText
    env.readText = (path) => path === receiptPath
      ? JSON.stringify({
          version: 3,
          transactionId: 'legacy-unknown-version',
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/old/tenon',
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-07-26T00:00:00Z',
        })
      : baseReadText(path)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, 'unknown')

    await expect(cmdUpdate(
      deps,
      { codex: true, auto: true },
      env,
      runtime.installer,
      fakeDashboardStarter().starter,
      STABLE_RESOLVER,
    )).resolves.toBe(1)
    expect(runtime.calls.activations).toEqual([])
    expect(calls.exec).toEqual([])
    expect(deps.errLines.join('\n')).toContain('无法比较')
  })

  test('cleanup receipt recovery rejects a marketplace that drifted back to main', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const proofPath = join(paths.stateRoot, 'migration', 'tenon-session-loaded')
    const { env, calls } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    const baseReadText = env.readText
    env.readText = (path) => {
      if (path === receiptPath) {
        return JSON.stringify({
          version: 3,
          transactionId: 'recovery-transaction',
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/new/tenon',
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-07-26T00:00:00Z',
        })
      }
      if (path === proofPath) {
        return `version=2\nloaded_at_epoch=1800000000\nhost=codex\nrelease_id=${releaseId}\nrelease_root=/runtime/releases/${releaseId}/payload\n`
      }
      if (path === '/new/marketplace/.codex-marketplace-install.json') {
        return JSON.stringify({ ref_name: 'main' })
      }
      return baseReadText(path)
    }
    const runtime = fakeRuntimeInstaller(false, null, releaseId, STABLE_TARGET.version)
    const dashboard = fakeDashboardStarter([], releaseId, STABLE_TARGET.version)

    expect(await cmdUpdate(
      deps,
      { codex: true, auto: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )).toBe(1)
    expect(runtime.calls.activations).toEqual([])
    expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
      && (args.includes('remove') || args.includes('add')))).toBe(false)
    expect(deps.errLines.join('\n')).toContain('收敛 cleanup 前完整 identity 无法重新证明')
  })

  test('cleanup receipt recovery rejects a Dashboard with the wrong product version', async () => {
    const deps = makeDeps()
    const releaseId = `sha256-${'b'.repeat(64)}`
    const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
    const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
    const { env } = updateEnv((cmd, args) => cmd === 'codex' && args.join(' ') === 'plugin list --json'
      ? { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    const baseReadText = env.readText
    env.readText = (path) => path === receiptPath
      ? JSON.stringify({
          version: 3,
          transactionId: 'recovery-transaction',
          state: 'cleanup-pending',
          host: 'codex',
          conflictPluginId: 'pipeline-lite@pipeline-lite',
          conflictScopes: ['user'],
          releaseId,
          releaseRoot: `/runtime/releases/${releaseId}/payload`,
          candidateRoot: '/new/tenon',
          createdAtEpoch: 1_700_000_000,
          updatedAt: '2026-07-26T00:00:00Z',
        })
      : baseReadText(path)
    const runtime = fakeRuntimeInstaller(false, null, releaseId, STABLE_TARGET.version)
    const dashboard = fakeDashboardStarter([], releaseId, '9.9.9')

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      dashboard.starter,
      STABLE_RESOLVER,
      async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
    )).toBe(1)
    expect(deps.errLines.join('\n')).toContain('Dashboard 未与 active managed runtime 精确一致')
  })

  test.each([
    ['v4 receipt versus another commit', 4, { ...STABLE_TARGET, commit: 'b'.repeat(40) }],
    ['v4 receipt versus a v2 manifest with no target', 4, undefined],
    ['legacy receipt upgrade versus another v2 commit', 3, { ...STABLE_TARGET, commit: 'b'.repeat(40) }],
  ] as const)(
    'cleanup recovery rejects active runtime stable-target mismatch: %s',
    async (_label, receiptVersion, activeStableTarget) => {
      const deps = makeDeps()
      const releaseId = `sha256-${'b'.repeat(64)}`
      const paths = resolveRuntimePaths({ homeDir: '/home/update-test', env: {} })
      const receiptPath = join(paths.migrationsRoot, 'host-plugin-convergence', 'codex.json')
      const { env, calls } = exactStableHostEnv()
      const baseReadText = env.readText
      env.readText = (path) => path === receiptPath
        ? JSON.stringify({
            version: receiptVersion,
            transactionId: 'target-mismatch-recovery',
            state: 'cleanup-pending',
            host: 'codex',
            conflictPluginId: 'pipeline-lite@pipeline-lite',
            conflictScopes: ['user'],
            releaseId,
            releaseRoot: `/runtime/releases/${releaseId}/payload`,
            candidateRoot: '/new/tenon',
            ...(receiptVersion === 4 ? { stableTarget: STABLE_TARGET } : {}),
            createdAtEpoch: 1_700_000_000,
            updatedAt: '2026-08-08T00:00:00Z',
          })
        : baseReadText(path)
      const runtime = fakeRuntimeInstaller(
        false,
        null,
        releaseId,
        STABLE_TARGET.version,
        activeStableTarget,
        true,
        2,
      )
      const dashboard = fakeDashboardStarter([], releaseId, STABLE_TARGET.version)

      expect(await cmdUpdate(
        deps,
        { codex: true },
        env,
        runtime.installer,
        dashboard.starter,
        STABLE_RESOLVER,
        async () => ({ pluginVersion: STABLE_TARGET.version, payloadDigest: 'b'.repeat(64) }),
      )).toBe(1)
      expect(runtime.calls.activations).toEqual([])
      expect(calls.exec.some(([cmd, args]) => cmd === 'codex'
        && args.join(' ') === 'plugin remove pipeline-lite@pipeline-lite --json')).toBe(false)
      expect(deps.errLines.join('\n')).toContain('active managed runtime stable target')
    },
  )

  test('dashboard readiness failure compensates the exact published activation', async () => {
    const deps = makeDeps()
    const { env } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const previousRelease = `sha256-${'a'.repeat(64)}`
    const runtime = fakeRuntimeInstaller(false, previousRelease)
    const dashboard = fakeDashboardStarter([true, false])

    expect(await cmdUpdate(deps, { codex: true }, env, runtime.installer, dashboard.starter, STABLE_RESOLVER)).toBe(1)
    expect(runtime.calls.reverts).toEqual([[
      '/home/update-test',
      `sha256-${'b'.repeat(64)}`,
    ]])
    expect(dashboard.calls.starts.map(([payload]) => payload)).toEqual([
      `/runtime/releases/sha256-${'b'.repeat(64)}/payload`,
      `/runtime/releases/${previousRelease}/payload`,
    ])
    expect(runtime.calls.failures[0]?.[1]).toContain('已恢复 managed transaction 与 previous Dashboard')
  })

  test('preserves the primary update failure and warns when runtime audit persistence also fails', async () => {
    const deps = makeDeps()
    const { env } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = fakeRuntimeInstaller(false, `sha256-${'a'.repeat(64)}`)
    runtime.installer.recordUpdateFailure = async () => { throw new Error('audit disk unavailable') }

    expect(await cmdUpdate(
      deps,
      { codex: true },
      env,
      runtime.installer,
      fakeDashboardStarter([true, false]).starter,
      STABLE_RESOLVER,
    )).toBe(1)

    expect(deps.errLines.join('\n')).toContain('injected readiness failure')
    expect(deps.errLines.join('\n')).toContain('WARNING: runtime update failure audit 写入失败')
    expect(deps.errLines.join('\n')).toContain('audit disk unavailable')
  })

  test('successful update reports registered projects that need an explicit sync without writing them', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const baseReadText = env.readText
    env.readText = (path) => {
      if (path === resolveRuntimePaths({ homeDir: '/home/update-test', env: {} }).registryPath) {
        return JSON.stringify(['/repo/current', "/repo/it's $HOME", "/repo/it's $HOME", 'relative/project'])
      }
      if (path === '/repo/current/.pipeline-version') return `${STABLE_TARGET.version}\n`
      if (path === "/repo/it's $HOME/.pipeline-version") return '0.2.0\n'
      return baseReadText(path)
    }

    expect(await cmdUpdate(deps, { codex: true }, env, fakeRuntimeInstaller().installer, fakeDashboardStarter().starter, STABLE_RESOLVER)).toBe(0)
    expect(deps.outLines.join('\n')).toContain(`cd '/repo/it'"'"'s $HOME' && tenon sync`)
    expect(deps.outLines.filter((line) => line.startsWith('  cd ') && line.includes('tenon sync'))).toHaveLength(1)
    expect(deps.outLines.join('\n')).not.toContain('relative/project')
    expect(deps.outLines.join('\n')).not.toContain('/repo/current')
    expect(calls.writes).toEqual([])
  })

  test('a local Codex marketplace is replaced by the frozen stable Git Release', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    requireVersionedHostRebind(env, calls, 'codex')
    let authCalls = 0
    env.codexAuthStatus = async () => {
      authCalls += 1
      return { state: 'unauthenticated' }
    }

    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()
    expect(await cmdUpdate(deps, { codex: true, auto: true }, env, runtime.installer, dashboard.starter, STABLE_RESOLVER)).toBe(0)
    expect(hostMutationCommands(calls, 'codex')).toEqual([
      'codex plugin remove tenon@tenon --json',
      'codex plugin marketplace remove tenon --json',
      'codex plugin marketplace add jefferysha/tenon --ref v1.2.3 --json',
      'codex plugin add tenon@tenon --json',
    ])
    expect(calls.exec.some(([cmd, args]) => cmd === 'bash'
      && args.join(' ') === `/new/tenon/tools/verify-skills.sh --quiet --root /new/tenon --node ${process.execPath}`)).toBe(true)
    expect(runtime.calls.activations).toEqual([['/new/tenon', 'codex', '/home/update-test']])
    expect(deps.outLines.join('\n')).toContain('v1.2.3')
    expect(deps.outLines.join('\n')).toContain('tenon doctor')
    expect(deps.outLines.join('\n')).not.toContain('codex login --device-auth')
    expect(authCalls).toBe(0)
    expect(dashboard.calls.starts).toEqual([[
      `/runtime/releases/sha256-${'b'.repeat(64)}/payload`,
      { openBrowser: false, port: 18_765, transactionId: 'update-test-transaction', expectedServerVersion: '1.2.3' },
    ]])
  })

  test('a failed package verification never publishes the unverified release and is runtime-audited', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      if (cmd === 'bash') return { code: 1, stdout: '', stderr: 'missing packaged skill' }
      return { code: 0, stdout: '', stderr: '' }
    })

    const runtime = fakeRuntimeInstaller()
    let authCalls = 0
    env.codexAuthStatus = async () => {
      authCalls += 1
      return { state: 'unauthenticated' }
    }
    expect(await cmdUpdate(deps, { codex: true }, env, runtime.installer, undefined, STABLE_RESOLVER)).toBe(1)
    expect(runtime.calls.activations).toEqual([])
    expect(runtime.calls.failures).toEqual([[
      '/home/update-test',
      'host=committed; managed=unchanged; 宿主候选准备失败；managed runtime 保持不变，'
      + 'journal 已保留供幂等恢复：宿主刷新后的 tenon 候选未通过打包资产校验',
    ]])
    expect(deps.errLines.join('\n')).toContain('宿主插件缓存已由 Codex 更新')
    expect(deps.errLines.join('\n')).toContain('Tenon 未回滚宿主私有缓存')
    expect(authCalls).toBe(0)
  })

  test('managed activation failure is audited without pretending to roll back the host cache', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    requireVersionedHostRebind(env, calls, 'codex')
    const runtime = fakeRuntimeInstaller(true)

    expect(await cmdUpdate(deps, { codex: true }, env, runtime.installer, fakeDashboardStarter().starter, STABLE_RESOLVER)).toBe(1)
    expect(runtime.calls.failures).toEqual([[
      '/home/update-test',
      expect.stringContaining('host=committed; managed=unchanged'),
    ]])
    expect(deps.errLines.join('\n')).toContain('宿主插件缓存已由 Codex 更新')
    expect(deps.errLines.join('\n')).toContain('当前已验证 runtime 保持不变')
  })

  test('an idempotent already-installed response still verifies the host inventory before publishing the managed runtime', async () => {
    const deps = makeDeps()
    const { env, calls } = updateEnv((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === 'plugin add tenon@tenon --json') {
        return { code: 1, stdout: '', stderr: 'plugin already installed' }
      }
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') return { code: 0, stdout: CODEX_INVENTORY, stderr: '' }
      if (cmd === 'bash') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    requireVersionedHostRebind(env, calls, 'codex')

    const runtime = fakeRuntimeInstaller()
    const dashboard = fakeDashboardStarter()
    expect(await cmdUpdate(deps, { codex: true }, env, runtime.installer, dashboard.starter, STABLE_RESOLVER)).toBe(0)
    expect(hostMutationCommands(calls, 'codex')).toEqual([
      'codex plugin remove tenon@tenon --json',
      'codex plugin marketplace remove tenon --json',
      'codex plugin marketplace add jefferysha/tenon --ref v1.2.3 --json',
      'codex plugin add tenon@tenon --json',
    ])
    expect(calls.exec.some(([cmd, args]) => cmd === 'bash'
      && args.join(' ') === `/new/tenon/tools/verify-skills.sh --quiet --root /new/tenon --node ${process.execPath}`)).toBe(true)
    expect(runtime.calls.activations).toEqual([['/new/tenon', 'codex', '/home/update-test']])
  })
})
