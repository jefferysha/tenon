import { describe, expect, test } from 'vitest'
import type { SetupEnv } from './setup.js'
import {
  compareReleaseOrder,
  decodeStableReleaseMetadata,
  isRetiredReleaseVersion,
  REAL_STABLE_RELEASE_HTTP,
  resolveStableReleaseTarget,
  resolveStableTagTarget,
  stableTagForVersion,
  type StableReleaseHttp,
} from './stable-release.js'

type TimeoutCall = {
  readonly command: string
  readonly timeoutMs: number | undefined
}

function envFor(
  output: string,
  code = 0,
  objectType: 'commit' | 'tree' | 'blob' = 'commit',
  timeoutCalls?: TimeoutCall[],
): SetupEnv {
  const advertised = output.trim().split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
  const commit = advertised.find((row) => row[1] === 'refs/tags/v1.2.3^{}')?.[0]
    ?? advertised.find((row) => row[1] === 'refs/tags/v1.2.3')?.[0]
    ?? ''
  return {
    homeDir: () => '/home/test',
    runtimeEnv: () => ({}),
    pluginRoot: () => null,
    selfPath: () => '/release/packages/cli/dist/tenon.mjs',
    pathExists: () => true,
    readText: () => undefined,
    readTextState: () => ({ state: 'missing' }),
    mkdirp: () => undefined,
    commandExists: () => true,
    resolveHostCommand: () => undefined,
    codexAuthStatus: async () => ({ state: 'authenticated', method: 'chatgpt' }),
    listDir: () => [],
    writeText: () => undefined,
    writeTextAtomic: () => undefined,
    runCommand: (cmd, args, options) => {
      expect(cmd).toBe('git')
      const command = args[0] === 'ls-remote'
        ? 'ls-remote'
        : args[0] === 'init'
          ? 'init'
          : args[2] ?? 'unknown'
      timeoutCalls?.push({ command, timeoutMs: options?.timeoutMs })
      const remoteProof = command === 'ls-remote' || command === 'fetch'
      expect(options).toEqual({ timeoutMs: remoteProof ? 60_000 : 10_000 })
      if (args[0] === 'ls-remote') {
        expect(args).toEqual([
          'ls-remote',
          'https://github.com/jefferysha/tenon.git',
          'refs/tags/v1.2.3',
          'refs/tags/v1.2.3^{}',
        ])
        return { code, stdout: output, stderr: code === 0 ? '' : 'network failed' }
      }
      if (args[0] === 'init') return { code: 0, stdout: '', stderr: '' }
      if (args[2] === 'fetch') return { code: 0, stdout: '', stderr: '' }
      if (args[2] === 'rev-parse') {
        return objectType === 'commit'
          ? { code: 0, stdout: `${commit}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: `not a commit: ${objectType}` }
      }
      if (args[2] === 'cat-file') return { code: 0, stdout: `${objectType}\n`, stderr: '' }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    },
    confirm: () => false,
  }
}

const metadata = {
  tag_name: 'v1.2.3',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/jefferysha/tenon/releases/tag/v1.2.3',
}

describe('stable Release identity', () => {
  test('accepts only complete stable SemVer and compares numerically', () => {
    expect(stableTagForVersion('1.2.3')).toBe('v1.2.3')
    for (const invalid of ['v1.2.3', '1.2', '01.2.3', '1.2.3-rc.1', '1.2.3+build', 'main']) {
      expect(() => stableTagForVersion(invalid)).toThrow(/stable SemVer/i)
    }
    expect(compareReleaseOrder('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareReleaseOrder('2.0.0', '2.0.0')).toBe(0)
    expect(compareReleaseOrder('9007199254740993.0.0', '9007199254740992.999999999999999999.999999999999999999')).toBeGreaterThan(0)
  })

  test.each([
    ['0.1.0', '1.1.5', 1],
    ['1.0.0', '0.0.1', -1],
    ['1.1.5', '1.0.9', 1],
    ['0.1.1', '0.1.0', 1],
    ['0.2.0', '0.1.9', 1],
    ['0.1.0', '0.1.0', 0],
    ['1.2.0', '0.9.9', 1],
    ['2.0.0', '1.2.3', 1],
  ] as const)('release order of %s against %s is %i', (left, right, expected) => {
    expect(compareReleaseOrder(left, right)).toBe(expected)
    expect(compareReleaseOrder(right, left)).toBe(expected === 0 ? 0 : -expected)
  })

  test('the retired release line is exactly the 16 published 1.x numbers', () => {
    const published = [
      ...Array.from({ length: 10 }, (_, patch) => `1.0.${patch}`),
      ...Array.from({ length: 6 }, (_, patch) => `1.1.${patch}`),
    ]
    for (const version of published) expect(isRetiredReleaseVersion(version)).toBe(true)
    for (const version of ['1.0.10', '1.1.6', '1.2.0', '0.1.0', '0.0.1']) {
      expect(isRetiredReleaseVersion(version)).toBe(false)
    }
    for (const invalid of ['1.1', 'v1.1.5', '01.1.5']) {
      expect(() => isRetiredReleaseVersion(invalid)).toThrow(/not complete stable SemVer/u)
      expect(() => compareReleaseOrder(invalid, '0.1.0')).toThrow(/not complete stable SemVer/u)
    }
  })

  test('decodes only the official non-draft non-prerelease stable Release', () => {
    expect(decodeStableReleaseMetadata(metadata)).toEqual({ version: '1.2.3', tag: 'v1.2.3' })
    expect(() => decodeStableReleaseMetadata({ ...metadata, draft: true })).toThrow(/draft/i)
    expect(() => decodeStableReleaseMetadata({ ...metadata, prerelease: true })).toThrow(/prerelease/i)
    expect(() => decodeStableReleaseMetadata({ ...metadata, tag_name: 'v1.2.3-rc.1' })).toThrow(/stable SemVer/i)
    expect(() => decodeStableReleaseMetadata({ ...metadata, html_url: 'https://example.com/v1.2.3' })).toThrow(/official/i)
    expect(() => decodeStableReleaseMetadata({ ...metadata, unexpected: true })).toThrow(/schema/i)
  })

  test('peels an annotated tag and freezes the exact commit', async () => {
    const tagObject = 'a'.repeat(40)
    const commit = 'b'.repeat(40)
    const http: StableReleaseHttp = { getJson: async () => metadata }
    await expect(resolveStableReleaseTarget(envFor(
      `${tagObject}\trefs/tags/v1.2.3\n${commit}\trefs/tags/v1.2.3^{}\n`,
    ), http)).resolves.toEqual({ version: '1.2.3', tag: 'v1.2.3', commit })
  })

  test('remote Git proof keeps a bounded slow-link budget while HTTP and local budgets stay explicit', () => {
    const commit = 'e'.repeat(40)
    const timeoutCalls: TimeoutCall[] = []
    expect(resolveStableTagTarget(
      envFor(`${commit}\trefs/tags/v1.2.3\n`, 0, 'commit', timeoutCalls),
      '1.2.3',
    )).toEqual({ version: '1.2.3', tag: 'v1.2.3', commit })
    expect(timeoutCalls).toEqual([
      { command: 'ls-remote', timeoutMs: 60_000 },
      { command: 'init', timeoutMs: 10_000 },
      { command: 'fetch', timeoutMs: 60_000 },
      { command: 'rev-parse', timeoutMs: 10_000 },
      { command: 'cat-file', timeoutMs: 10_000 },
    ])
  })

  test('Release metadata HTTP keeps the bounded 30 second network budget', async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    let timeoutMs: number | undefined
    globalThis.fetch = async () => new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    AbortSignal.timeout = ((milliseconds: number) => {
      timeoutMs = milliseconds
      return originalTimeout.call(AbortSignal, milliseconds)
    }) as typeof AbortSignal.timeout
    try {
      await expect(REAL_STABLE_RELEASE_HTTP.getJson('https://api.github.com/test')).resolves.toEqual(metadata)
    } finally {
      globalThis.fetch = originalFetch
      AbortSignal.timeout = originalTimeout
    }
    expect(timeoutMs).toBe(30_000)
  })

  test('resolves an explicitly selected stable tag without a Release API or branch lookup', () => {
    const commit = 'e'.repeat(40)
    expect(resolveStableTagTarget(
      envFor(`${commit}\trefs/tags/v1.2.3\n`),
      '1.2.3',
    )).toEqual({ version: '1.2.3', tag: 'v1.2.3', commit })
  })

  test('accepts a lightweight tag and rejects ambiguous or unavailable tag proof', async () => {
    const commit = 'c'.repeat(40)
    const http: StableReleaseHttp = { getJson: async () => metadata }
    await expect(resolveStableReleaseTarget(
      envFor(`${commit}\trefs/tags/v1.2.3\n`),
      http,
    )).resolves.toMatchObject({ commit })
    await expect(resolveStableReleaseTarget(
      envFor(`${commit}\trefs/tags/v1.2.3\n${'d'.repeat(40)}\trefs/tags/v1.2.3\n`),
      http,
    )).rejects.toThrow(/tag proof/i)
    await expect(resolveStableReleaseTarget(envFor('', 1), http)).rejects.toThrow(/tag proof/i)
  })

  test('retries a transient GitHub transport failure and still validates the fetched commit', () => {
    const commit = 'e'.repeat(40)
    const base = envFor(`${commit}\trefs/tags/v1.2.3\n`)
    const commands: string[] = []
    let fetchFailures = 1
    const env: SetupEnv = {
      ...base,
      runCommand: (cmd, args, options) => {
        const command = args[0] === 'ls-remote' || args[0] === 'init' ? args[0] : args[2] ?? 'unknown'
        commands.push(command)
        if (command === 'fetch' && fetchFailures > 0) {
          fetchFailures -= 1
          return { code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/jefferysha/tenon.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL" }
        }
        return base.runCommand(cmd, args, options)
      },
    }
    expect(resolveStableTagTarget(env, '1.2.3')).toEqual({ version: '1.2.3', tag: 'v1.2.3', commit })
    expect(commands).toEqual(['ls-remote', 'init', 'fetch', 'fetch', 'rev-parse', 'cat-file'])
  })

  test('gives up after bounded attempts on a persistent timeout and never retries a missing ref', () => {
    const commit = 'e'.repeat(40)
    const base = envFor(`${commit}\trefs/tags/v1.2.3\n`)
    const listCalls: string[] = []
    const timingOut: SetupEnv = {
      ...base,
      runCommand: (cmd, args, options) => {
        if (args[0] === 'ls-remote') {
          listCalls.push('ls-remote')
          return { code: 1, stdout: '', stderr: 'spawnSync /usr/bin/git ETIMEDOUT' }
        }
        return base.runCommand(cmd, args, options)
      },
    }
    expect(() => resolveStableTagTarget(timingOut, '1.2.3')).toThrow(/tag proof failed after 3 attempts: spawnSync \/usr\/bin\/git ETIMEDOUT/)
    expect(listCalls).toHaveLength(3)

    const fetchCalls: string[] = []
    const missingRef: SetupEnv = {
      ...base,
      runCommand: (cmd, args, options) => {
        if (args[2] === 'fetch') {
          fetchCalls.push('fetch')
          return { code: 128, stdout: '', stderr: "fatal: couldn't find remote ref refs/tags/v1.2.3" }
        }
        return base.runCommand(cmd, args, options)
      },
    }
    expect(() => resolveStableTagTarget(missingRef, '1.2.3')).toThrow(/^stable Release object proof failed: fatal: couldn't find remote ref/)
    expect(fetchCalls).toHaveLength(1)
  })

  test.each(['tree', 'blob'] as const)('rejects a tag whose final object is %s', (objectType) => {
    const oid = 'f'.repeat(40)
    expect(() => resolveStableTagTarget(
      envFor(`${oid}\trefs/tags/v1.2.3\n`, 0, objectType),
      '1.2.3',
    )).toThrow(/commit object/i)
  })

  test('fails before Git proof when Release metadata cannot be fetched', async () => {
    const http: StableReleaseHttp = {
      getJson: async () => { throw new Error('timeout') },
    }
    await expect(resolveStableReleaseTarget(envFor(''), http)).rejects.toThrow(/timeout/)
  })
})
