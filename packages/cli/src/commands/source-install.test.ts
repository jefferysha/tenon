import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { installChannelPath, parseInstallChannel } from '../runtime/dev-install-marker.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import type { RuntimeActivation, RuntimeDevSource } from '../runtime/types.js'
import { makeDeps } from '../test-support.js'
import type { ManagedReleaseRequest } from './release-coordinator.js'
import {
  cmdSetupFromSource, describeSourceInstallPlan, validateFromSourceOptions,
  type SourceInstallPorts,
} from './source-install.js'
import type { SetupEnv } from './setupEnvironment.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REPO = '/work/tenon'
const RELEASE_ID = `sha256-${'e'.repeat(64)}`
const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: REPO, commit: 'a'.repeat(40), dirty: true,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}
const ACTIVATION: RuntimeActivation = {
  selection: { version: 1, revision: 1, activeRelease: RELEASE_ID, previousRelease: null, updatedAt: '2026-10-07T00:00:00Z' },
  release: {
    version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
    source: { host: 'claude', pluginVersion: '0.3.2' }, devSource: DEV,
  },
  releaseRoot: `/runtime/releases/${RELEASE_ID}`,
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tenon-source-install-'))
  roots.push(root)
  return root
}

function fakeEnv(root: string, overrides: Partial<SetupEnv> = {}): SetupEnv {
  return {
    homeDir: () => root,
    runtimeEnv: () => ({ TENON_RUNTIME_HOME: join(root, 'runtime') }),
    readTextState: () => ({ state: 'missing' }),
    readText: (path: string) => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    pathExists: (path: string) => existsSync(path),
    mkdirp: (dir: string) => { mkdirSync(dir, { recursive: true }) },
    writeText: (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) },
    runCommand: () => ({ code: 127, stdout: '', stderr: 'no host commands expected in this test' }),
    ...overrides,
  } as unknown as SetupEnv
}

function fakePorts(overrides: Partial<SourceInstallPorts> = {}) {
  const events: string[] = []
  const captured: { request?: ManagedReleaseRequest } = {}
  const ports: SourceInstallPorts = {
    resolveRepo: (input) => { events.push('resolve'); return { ok: true, repo: input } },
    ensureSkills: async () => { events.push('ensure'); return { state: 'present' } },
    build: () => { events.push('build'); return { code: 0, detail: '' } },
    identity: () => { events.push('identity'); return DEV },
    pluginVersion: async () => '0.3.2',
    publish: async (request) => {
      events.push('publish')
      captured.request = request
      return { ok: true, state: 'ready', activation: ACTIVATION }
    },
    ...overrides,
  }
  return { ports, events, captured }
}

function input(root: string, deps = makeDeps(), extra: { skipBuild?: boolean; env?: SetupEnv } = {}) {
  return {
    deps,
    host: 'claude' as const,
    repoInput: REPO,
    skipBuild: extra.skipBuild ?? false,
    env: extra.env ?? fakeEnv(root),
    runtimeScope: { homeDir: root, env: {} },
    openBrowser: false,
  }
}

describe('cmdSetupFromSource', () => {
  test('resolves, ensures skills, builds, freezes the identity, then publishes a dev release request', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events, captured } = fakePorts()
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(0)
    expect(events).toEqual(['resolve', 'ensure', 'build', 'identity', 'publish'])
    expect(captured.request).toMatchObject({
      operation: 'setup', source: 'claude', expectedPluginVersion: '0.3.2', devSource: DEV, openBrowser: false,
    })
    expect(captured.request).not.toHaveProperty('requiresStableTarget')
    expect(captured.request).not.toHaveProperty('resolveStableTargetBeforeRecovery')
    expect(deps.outLines.join('\n')).toContain('0.3.2+dev.aaaaaaa')
    expect(deps.outLines.join('\n')).toContain('--to-stable')
  })

  test('--skip-build skips only the build', async () => {
    const root = tempRoot()
    const { ports, events } = fakePorts()
    expect(await cmdSetupFromSource(input(root, makeDeps(), { skipBuild: true }), ports)).toBe(0)
    expect(events).toEqual(['resolve', 'ensure', 'identity', 'publish'])
  })

  test('an unusable repository stops everything', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events } = fakePorts({ resolveRepo: () => ({ ok: false, reason: '不是 Tenon 源码仓库' }) })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(events).toEqual([])
    expect(deps.errLines.join('\n')).toContain('不是 Tenon 源码仓库')
  })

  test('a failed upstream skill fetch aborts before the build, the transaction and any host command', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events } = fakePorts({
      ensureSkills: async () => ({ state: 'failed', detail: '上游技能获取失败：alpha（unreachable）' }),
    })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(events).not.toContain('build')
    expect(events).not.toContain('publish')
    expect(deps.errLines.join('\n')).toContain('alpha')
    expect(deps.errLines.join('\n')).toContain('未创建事务')
  })

  test('a failed build aborts before the transaction', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events } = fakePorts({ build: () => ({ code: 2, detail: '' }) })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(events).not.toContain('publish')
    expect(deps.errLines.join('\n')).toContain('构建失败')
  })

  test('an identity that cannot be frozen aborts before the transaction', async () => {
    const root = tempRoot()
    const { ports, events } = fakePorts({ identity: () => { throw new Error('还没有任何提交') } })
    expect(await cmdSetupFromSource(input(root), ports)).toBe(1)
    expect(events).not.toContain('publish')
  })

  test('an unreadable convergence receipt refuses before any work', async () => {
    const root = tempRoot()
    const env = fakeEnv(root, { readTextState: () => ({ state: 'ok', text: 'not json' }) })
    const { ports, events } = fakePorts()
    expect(await cmdSetupFromSource(input(root, makeDeps(), { env }), ports)).toBe(1)
    expect(events).toEqual(['resolve'])
  })

  test('a failed managed transaction is reported with the resume command', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports } = fakePorts({
      publish: async () => ({ ok: false, state: 'unchanged', detail: '宿主候选准备失败' }),
    })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(deps.errLines.join('\n')).toContain('宿主候选准备失败')
    expect(deps.errLines.join('\n')).toContain('--from-source')
  })

  test('revalidation refuses a candidate whose workspace changed after the identity was frozen', async () => {
    const root = tempRoot()
    const changed = { ...DEV, worktreeDigest: 'f'.repeat(40) }
    let calls = 0
    // 第一次调用冻结身份；之后的调用代表激活前重算——工作区已经变了。
    const { ports, captured } = fakePorts({ identity: () => (calls++ === 0 ? DEV : changed) })
    await cmdSetupFromSource(input(root), ports)
    const request = captured.request
    if (request?.revalidateCandidate === undefined) throw new Error('request has no revalidateCandidate')
    await expect(Promise.resolve().then(() => request.revalidateCandidate?.(
      { candidateRoot: REPO }, { transactionId: 't1' },
    ))).rejects.toThrow('工作区在安装期间发生变化')
  })

  test('revalidation refuses a candidate root that is not the frozen repository', async () => {
    const root = tempRoot()
    const { ports, captured } = fakePorts()
    await cmdSetupFromSource(input(root), ports)
    const request = captured.request
    if (request?.revalidateCandidate === undefined) throw new Error('request has no revalidateCandidate')
    await expect(Promise.resolve().then(() => request.revalidateCandidate?.(
      { candidateRoot: '/somewhere/else' }, { transactionId: 't1' },
    ))).rejects.toThrow('不是冻结的源码仓库')
  })

  test('ready evidence writes the install-channel marker and turns an existing auto-update preference off', async () => {
    const root = tempRoot()
    const env = fakeEnv(root)
    const paths = resolveRuntimePaths({ homeDir: root, env: env.runtimeEnv() })
    mkdirSync(paths.configRoot, { recursive: true })
    writeFileSync(join(paths.configRoot, 'auto-update.conf'), 'host=claude\nenabled=true\n')
    const { ports, captured } = fakePorts()
    await cmdSetupFromSource(input(root, makeDeps(), { env }), ports)
    const request = captured.request
    if (request?.commitReadyEvidence === undefined) throw new Error('request has no commitReadyEvidence')
    await request.commitReadyEvidence(ACTIVATION, { candidateRoot: REPO }, 't1', {})
    const marker = parseInstallChannel(readFileSync(installChannelPath(paths.configRoot), 'utf8'))
    expect(marker).toMatchObject({ host: 'claude', releaseId: RELEASE_ID, devSource: DEV })
    expect(readFileSync(join(paths.configRoot, 'auto-update.conf'), 'utf8')).toBe('host=claude\nenabled=false\n')
  })

  test('ready evidence refuses a release that does not carry the frozen development source', async () => {
    const root = tempRoot()
    const { ports, captured } = fakePorts()
    await cmdSetupFromSource(input(root), ports)
    const request = captured.request
    if (request?.commitReadyEvidence === undefined) throw new Error('request has no commitReadyEvidence')
    const withoutDev: RuntimeActivation = {
      ...ACTIVATION,
      release: { version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z', source: { host: 'claude', pluginVersion: '0.3.2' } },
    }
    await expect(Promise.resolve().then(() => request.commitReadyEvidence?.(withoutDev, { candidateRoot: REPO }, 't1', {})))
      .rejects.toThrow('devSource')
  })
})

describe('validateFromSourceOptions', () => {
  test('accepts a native host with a repository path', () => {
    expect(validateFromSourceOptions('claude', { fromSource: '.' })).toBeNull()
    expect(validateFromSourceOptions('codex', { fromSource: '/work/tenon', skipBuild: true })).toBeNull()
  })

  test.each([
    ['an adapter host', 'cursor' as const, { fromSource: '.' }, 'adapter'],
    ['--auto-update', 'claude' as const, { fromSource: '.', autoUpdate: true }, '--auto-update'],
    ['an empty path', 'claude' as const, { fromSource: '  ' }, '源码仓库路径'],
    ['--skip-build alone', 'claude' as const, { skipBuild: true }, '--from-source'],
  ])('rejects %s', (_label, host, opts, fragment) => {
    expect(validateFromSourceOptions(host, opts)).toContain(fragment)
  })

  test('no source options means nothing to validate', () => {
    expect(validateFromSourceOptions('claude', {})).toBeNull()
  })
})

describe('describeSourceInstallPlan', () => {
  test('prints the dry-run plan with the exact host commands and changes nothing', () => {
    const deps = makeDeps()
    const { ports, events } = fakePorts()
    expect(describeSourceInstallPlan(deps, 'claude', REPO, false, ports)).toBe(0)
    const text = deps.outLines.join('\n')
    expect(text).toContain('claude plugin marketplace add /work/tenon')
    expect(text).toContain('npm --prefix /work/tenon run build')
    expect(text).toContain('--dry-run')
    expect(events).toEqual(['resolve', 'identity'])
  })

  test('--skip-build is reflected, and an invalid repository exits 1', () => {
    const deps = makeDeps()
    expect(describeSourceInstallPlan(deps, 'codex', REPO, true, fakePorts().ports)).toBe(0)
    expect(deps.outLines.join('\n')).toContain('--skip-build')
    const bad = makeDeps()
    expect(describeSourceInstallPlan(bad, 'codex', REPO, false, fakePorts({ resolveRepo: () => ({ ok: false, reason: 'nope' }) }).ports)).toBe(1)
  })
})
