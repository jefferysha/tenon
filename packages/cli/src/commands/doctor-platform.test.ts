/**
 * doctor env:platform（P0-6）：原生 Windows 红灯并指向 WSL；WSL、Linux、macOS 绿灯；没验证过的平台黄灯；
 * 探针缺席或抛错折算红灯。WSL 的识别是纯函数，两条信号各自可证。
 */
import { describe, expect, test } from 'vitest'
import { cmdDoctor, type DoctorCheck } from './doctor.js'
import { detectPlatform } from './doctor-platform.js'
import { makeDeps, type TestDeps } from '../test-support.js'

interface DoctorJson {
  checks: DoctorCheck[]
  summary: { green: number; yellow: number; red: number }
}

async function run(deps: TestDeps): Promise<{ code: number; payload: DoctorJson; platform: DoctorCheck }> {
  const code = await cmdDoctor(deps, { json: true })
  const payload = JSON.parse(deps.outLines.join('\n')) as DoctorJson
  const platform = payload.checks.find((check) => check.id === 'env:platform')
  if (platform === undefined) throw new Error('env:platform 缺失')
  return { code, payload, platform }
}

describe('doctor env:platform', () => {
  test('原生 Windows：红灯、exit 1，指向 WSL 与安装文档，且不影响别的检查', async () => {
    const { code, payload, platform } = await run(makeDeps({ doctor: { platform: () => ({ os: 'win32', wsl: false }) } }))
    expect(platform.status).toBe('red')
    expect(platform.detail).toContain('原生 Windows 不受支持')
    expect(platform.hint).toContain('WSL 2')
    expect(platform.hint).toContain('wsl --install')
    expect(platform.hint).toContain('docs/usage/installation.md')
    expect(code).toBe(1)
    expect(payload.summary.red).toBe(1)
  })

  test.each([
    ['darwin', false, 'macOS'],
    ['linux', false, 'Linux：受支持'],
    ['linux', true, 'WSL'],
  ] as const)('%s（wsl=%s）：绿灯，exit 0', async (os, wsl, expected) => {
    const { code, platform } = await run(makeDeps({ doctor: { platform: () => ({ os, wsl }) } }))
    expect(platform).toMatchObject({ status: 'green', hint: '' })
    expect(platform.detail).toContain(expected)
    expect(code).toBe(0)
  })

  test('没验证过的类 Unix 平台：黄灯，不拦（exit 0）', async () => {
    const { code, platform } = await run(makeDeps({ doctor: { platform: () => ({ os: 'freebsd', wsl: false }) } }))
    expect(platform.status).toBe('yellow')
    expect(platform.detail).toContain('freebsd')
    expect(platform.hint).toContain('docs/usage/installation.md')
    expect(code).toBe(0)
  })

  test('探针没有装配或抛错：红灯，不静默放行', async () => {
    const missing = await run(makeDeps({ doctor: { platform: undefined } }))
    expect(missing.platform).toMatchObject({ status: 'red' })
    expect(missing.platform.detail).toContain('平台探针未装配')
    expect(missing.code).toBe(1)
    const throwing = await run(makeDeps({ doctor: { platform: () => { throw new Error('boom') } } }))
    expect(throwing.platform).toMatchObject({ status: 'red' })
    expect(throwing.platform.detail).toContain('boom')
  })

  test('人读输出：Windows 红灯带 fix 行', async () => {
    const deps = makeDeps({ doctor: { platform: () => ({ os: 'win32', wsl: false }) } })
    expect(await cmdDoctor(deps, {})).toBe(1)
    const text = deps.outLines.join('\n')
    expect(text).toMatch(/\[FAIL\] env:platform\s+原生 Windows 不受支持/u)
    expect(text).toContain('fix: 改在 WSL 2 里安装并运行 Tenon')
  })
})

describe('detectPlatform', () => {
  const noProc = (): undefined => undefined
  const proc = (text: string) => (): string => text

  test('只有 linux 才可能是 WSL', () => {
    expect(detectPlatform({ platform: 'darwin', env: { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion: proc('microsoft') })).toEqual({ os: 'darwin', wsl: false })
    expect(detectPlatform({ platform: 'win32', env: {}, procVersion: noProc })).toEqual({ os: 'win32', wsl: false })
  })

  test('WSL_DISTRO_NAME 被设置即 WSL；空串不算', () => {
    expect(detectPlatform({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, procVersion: noProc })).toEqual({ os: 'linux', wsl: true })
    expect(detectPlatform({ platform: 'linux', env: { WSL_DISTRO_NAME: '' }, procVersion: noProc })).toEqual({ os: 'linux', wsl: false })
  })

  test('/proc/version 带 microsoft（WSL 1/2 的内核版本串）即 WSL，大小写不论', () => {
    expect(detectPlatform({ platform: 'linux', env: {}, procVersion: proc('Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x) (gcc)') })).toEqual({ os: 'linux', wsl: true })
    expect(detectPlatform({ platform: 'linux', env: {}, procVersion: proc('Linux version 4.4.0-19041-Microsoft') })).toEqual({ os: 'linux', wsl: true })
  })

  test('普通 Linux 与读不到 /proc/version：不是 WSL', () => {
    expect(detectPlatform({ platform: 'linux', env: {}, procVersion: proc('Linux version 6.8.0-1015-azure (buildd@lcy02)') })).toEqual({ os: 'linux', wsl: false })
    expect(detectPlatform({ platform: 'linux', env: {}, procVersion: noProc })).toEqual({ os: 'linux', wsl: false })
  })
})
