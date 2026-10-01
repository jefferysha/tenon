import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProductPaths } from '@tenon/kernel'
import { realDeps } from './integration-harness.js'
import { buildProgram, CliExit } from './program.js'
import { productionSupportRuntime, type SupportRuntime } from './commands/support.js'
import { SUPPORT_BUNDLE_MAX_BYTES } from './support/bundle.js'
import { textOf, unpackTarGz } from './support/test-support.js'

const OPENAI_KEY = 'sk-proj-SECRETSECRETSECRETSECRET1234'
const LOGIN_CODE = 'Zm9vYmFyMTIzNDU2Nzg5'
const SESSION = '0123456789abcdef0123456789abcdef'
const BEARER = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'

let root = ''
let cwd = ''
let runtimeHome = ''
let paths: ReturnType<typeof resolveProductPaths>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tenon-support-'))
  cwd = join(root, 'project')
  runtimeHome = join(root, 'runtime')
  mkdirSync(cwd, { recursive: true })
  paths = resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: join(root, 'home') })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 假 doctor / runtime：canned JSON；其余（home、用户名、环境）按测试需要给，不碰真实机器。 */
function fakeRuntime(overrides: Partial<SupportRuntime> = {}): SupportRuntime {
  const canned = (payload: unknown) => async () => ({ exit: 0, out: JSON.stringify(payload), err: '' })
  return {
    doctor: canned({ checks: [{ id: 'env:node', status: 'green', detail: `node ok at /Users/zhangsan/.nvm token=hunter2doctor` }], summary: { green: 1, yellow: 0, red: 0 } }),
    runtimeStatus: canned({ selection: { activeRelease: null, revision: 0 }, activeValid: false }),
    homeDirs: () => ['/Users/zhangsan'],
    userNames: () => ['zhangsan'],
    env: () => ({ TENON_LANG: 'zh', TENON_USER: 'zhangsan@example.com', TENON_RUNTIME_HOME: runtimeHome, PATH: '/usr/bin' }),
    host: () => ({ node: 'v22.0.0', platform: 'darwin', arch: 'arm64', release: '24.0.0' }),
    ...overrides,
  }
}

async function run(args: string[], runtime: SupportRuntime, env: Record<string, string> = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const deps = realDeps(cwd, out, err, { ...process.env, TENON_RUNTIME_HOME: runtimeHome, ...env })
  try {
    await buildProgram(deps, { support: runtime }).parseAsync(args, { from: 'user' })
    return { code: 0, out, err }
  } catch (error) {
    if (error instanceof CliExit) return { code: error.code, out, err }
    throw error
  }
}

function seedRuntimeState(): void {
  mkdirSync(paths.logsRoot, { recursive: true })
  mkdirSync(paths.configRoot, { recursive: true })
  writeFileSync(paths.dashboardLogPath, [
    `2026-10-01T10:00:00.000Z out   [dashboard-server] 登录链接（一次性，2 分钟内有效）：http://127.0.0.1:18765/session/start?code=${LOGIN_CODE}`,
    `2026-10-01T10:00:01.000Z err   Set-Cookie: tenon_session_18765=${SESSION}; Max-Age=604800; Path=/; HttpOnly`,
    `2026-10-01T10:00:02.000Z err   WARN: github said Authorization: Bearer ${BEARER}`,
    '2026-10-01T10:00:03.000Z err   WARN: history 写入失败: EACCES /Users/zhangsan/work/app/.pipeline-history.jsonl (owner zhangsan@example.com)',
    '',
  ].join('\n'))
  writeFileSync(`${paths.dashboardLogPath}.1`, '2026-09-30T23:59:59.000Z out   older line /Users/zhangsan/old\n')
  writeFileSync(paths.secretsPath, JSON.stringify({ version: 1, keys: { OPENAI_API_KEY: OPENAI_KEY } }), { mode: 0o600 })
  writeFileSync(paths.registryPath, JSON.stringify(['/Users/zhangsan/work/app', '/Users/zhangsan/work/other'], null, 2))
  writeFileSync(paths.dashboardPidfilePath, JSON.stringify({ pid: 4242, port: 18765, version: '0.3.0', started: 1_760_000_000_000 }))
}

describe('tenon support bundle', () => {
  it('生成 0600 的 .tar.gz，逐项打印包含了什么与抹了什么，并说明没有包含什么', async () => {
    seedRuntimeState()
    const out = join(root, 'out', 'bundle.tar.gz')
    const result = await run(['support', 'bundle', '--out', out], fakeRuntime())
    expect(result.code).toBe(0)
    expect(existsSync(out)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600)

    const entries = unpackTarGz(readFileSync(out))
    expect(entries.map((entry) => entry.name)).toEqual([
      'manifest.json', 'version.json', 'doctor.json', 'runtime-status.json', 'config-summary.json',
      'logs/dashboard.log', 'logs/dashboard.log.1',
    ])
    const printed = result.out.join('\n')
    expect(printed).toContain(`支持包已生成: ${out}`)
    expect(printed).toContain('包含：')
    for (const name of ['version.json', 'doctor.json', 'runtime-status.json', 'config-summary.json', 'logs/dashboard.log', 'logs/dashboard.log.1']) {
      expect(printed).toContain(name)
    }
    expect(printed).toContain('hook-timings.jsonl')
    expect(printed).toContain('不可用：no hook timing records')
    expect(printed).toMatch(/已脱敏：.*个凭证/u)
    expect(printed).toContain('未包含：')
    expect(result.err).toEqual([])
  })

  it('脱敏被证明：凭证、cookie、登录码、secrets 的值、邮箱、home 路径、用户名在整个包里一个都没有', async () => {
    seedRuntimeState()
    const out = join(root, 'bundle.tar.gz')
    const result = await run(['support', 'bundle', '--out', out], fakeRuntime())
    expect(result.code).toBe(0)
    const everything = textOf(unpackTarGz(readFileSync(out)))
    for (const secret of [OPENAI_KEY, LOGIN_CODE, SESSION, BEARER, 'hunter2doctor', 'zhangsan', 'example.com', '/Users/']) {
      expect(everything, secret).not.toContain(secret)
    }
    // 诊断价值还在：形状、键名、计数、波浪号路径。
    expect(everything).toContain('/session/start?code=[REDACTED:token]')
    expect(everything).toContain('~/work/app/.pipeline-history.jsonl')
    expect(everything).toContain('"OPENAI_API_KEY"')
    expect(everything).toMatch(/"registered": 2/u)
    expect(everything).toContain('"pid": 4242')
    expect(everything).toContain('"TENON_USER": "<set>"')
    expect(everything).toContain('"TENON_LANG": "zh"')
  })

  it('日志太大：总大小不超过 5 MiB，只留最近的部分，打印里写明原大小', async () => {
    seedRuntimeState()
    const huge = randomBytes(24 * 1024 * 1024).toString('base64').replace(/(.{100})/gu, '2026-10-01T10:00:00.000Z out   $1\n')
    writeFileSync(paths.dashboardLogPath, `${huge}\nTHE-NEWEST-LINE\n`)
    const out = join(root, 'big.tar.gz')
    const result = await run(['support', 'bundle', '--out', out], fakeRuntime())
    expect(result.code).toBe(0)
    expect(statSync(out).size).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES)
    const log = unpackTarGz(readFileSync(out)).find((entry) => entry.name === 'logs/dashboard.log')?.content.toString() ?? ''
    expect(log).toContain('THE-NEWEST-LINE')
    expect(log.startsWith('[tenon] truncated: kept the last')).toBe(true)
    expect(result.out.join('\n')).toMatch(/logs\/dashboard\.log\s+[\d.]+ [KM]B（只留最近 [\d.]+ [KM]B，原 [\d.]+ MB）/u)
  })

  it('英文输出：TENON_LANG=en 时提示全是英文，--json 给出机器可读的清单', async () => {
    seedRuntimeState()
    const out = join(root, 'en.tar.gz')
    const english = await run(['support', 'bundle', '--out', out], fakeRuntime(), { TENON_LANG: 'en' })
    const printed = english.out.join('\n')
    expect(printed).toContain(`Support bundle written: ${out}`)
    expect(printed).toContain('Included:')
    expect(printed).toContain('Not included:')
    expect(printed).toMatch(/Redacted: .*token\(s\)/u)
    expect(printed).toContain('(unavailable: no hook timing records)')
    expect(printed).not.toMatch(/[一-鿿]/u)

    const json = await run(['support', 'bundle', '--out', join(root, 'j.tar.gz'), '--json'], fakeRuntime())
    const parsed: unknown = JSON.parse(json.out.join('\n'))
    expect(parsed).toMatchObject({
      path: join(root, 'j.tar.gz'),
      entries: expect.arrayContaining([expect.objectContaining({ name: 'doctor.json', truncated: false })]),
      redactions: expect.objectContaining({ token: expect.any(Number), email: expect.any(Number) }),
    })
  })

  it('doctor 或 runtime 探针出错：对应项标为不可用，包照常生成', async () => {
    const failing = fakeRuntime({
      doctor: async () => ({ exit: 1, out: '', err: 'ERROR: doctor probes are not wired at /Users/zhangsan' }),
      runtimeStatus: async () => ({ exit: 1, out: '', err: '' }),
    })
    const out = join(root, 'degraded.tar.gz')
    const result = await run(['support', 'bundle', '--out', out], failing)
    expect(result.code).toBe(0)
    const names = unpackTarGz(readFileSync(out)).map((entry) => entry.name)
    expect(names).not.toContain('doctor.json')
    expect(names).not.toContain('runtime-status.json')
    const printed = result.out.join('\n')
    expect(printed).toContain('doctor.json')
    expect(printed).toContain('不可用：ERROR: doctor probes are not wired at ~')
    expect(printed).toContain('no output (exit 1)')
    expect(printed).not.toContain('zhangsan')
  })

  it('--out 是已存在的目录：拒绝并退出 1；没有日志时也能生成', async () => {
    const refused = await run(['support', 'bundle', '--out', root], fakeRuntime())
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('--out 必须是一个文件路径')
    const out = join(root, 'empty.tar.gz')
    const ok = await run(['support', 'bundle', '--out', out], fakeRuntime())
    expect(ok.code).toBe(0)
    expect(ok.out.join('\n')).toContain('logs/dashboard.log')
    expect(ok.out.join('\n')).toContain('no Dashboard server log yet')
  })

  it('缺省输出在用户 home（不在项目里，不会改动工作区指纹）', async () => {
    if (process.platform === 'win32') return
    const fakeHome = join(root, 'fake-home')
    mkdirSync(fakeHome)
    const savedHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const result = await run(['support', 'bundle'], fakeRuntime(), { HOME: fakeHome })
      expect(result.code).toBe(0)
      const printed = result.out[0] ?? ''
      expect(printed).toMatch(/支持包已生成: .*tenon-support-\d{8}T\d{6}Z\.tar\.gz/u)
      expect(printed).not.toContain(cwd)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })

  it('生产运行时：真实 doctor、runtime status、真实 home 与用户名都被处理，包里没有本机 home 路径', async () => {
    seedRuntimeState()
    const out = join(root, 'real.tar.gz')
    const result = await run(['support', 'bundle', '--out', out], productionSupportRuntime())
    expect(result.code).toBe(0)
    const entries = unpackTarGz(readFileSync(out))
    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['manifest.json', 'version.json', 'config-summary.json']))
    const everything = textOf(entries)
    expect(everything).not.toContain(homedir())
    const version: unknown = JSON.parse(entries.find((entry) => entry.name === 'version.json')?.content.toString() ?? '{}')
    expect(version).toMatchObject({ node: process.version, platform: process.platform })
  }, 120_000)
})
