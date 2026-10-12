/**
 * Tenon 的候选版本指纹把 test-results/ 下没有被声明为套件输出的文件算进候选。
 * Dashboard e2e 的被测服务把状态与日志写进 test-results/dashboard-e2e-server/，
 * 所以测试目录必须声明这个目录，否则每跑一次 e2e，冻结的构建版本就失效一次。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declaredTestOutputs } from '@tenon/kernel'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SERVER_DIR = 'test-results/dashboard-e2e-server'
const SERVER_DIR_JOIN = "join(REPO_ROOT, 'test-results', 'dashboard-e2e-server')"

/** 与 fingerprint.ts 的 isDeclaredOutput 同一口径：路径等于声明项，或落在声明项目录之下。 */
function isCovered(declared: readonly string[], path: string): boolean {
  return declared.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

describe('dashboard e2e 服务目录的测试输出声明', () => {
  test('测试目录把 e2e 服务的状态与日志目录声明为套件输出', async () => {
    const declared = await declaredTestOutputs(REPO_ROOT)
    expect(isCovered(declared, SERVER_DIR), `${SERVER_DIR} 不在声明输出里：${declared.join(', ')}`).toBe(true)
  })

  test('服务脚本与服务状态模块仍把状态写进被声明的目录', async () => {
    const [serve, serverState] = await Promise.all([
      readFile(join(REPO_ROOT, 'e2e', 'dashboard', 'support', 'serve.mjs'), 'utf8'),
      readFile(join(REPO_ROOT, 'e2e', 'dashboard', 'support', 'server-state.ts'), 'utf8'),
    ])
    expect(serve).toContain(`const STATE_DIR = ${SERVER_DIR_JOIN}`)
    expect(serverState).toContain(`export const SERVER_DIR = ${SERVER_DIR_JOIN}`)
  })

  test('声明口径本身：目录项覆盖其子路径，不覆盖同名前缀的兄弟目录', () => {
    expect(isCovered(['test-results'], SERVER_DIR)).toBe(true)
    expect(isCovered([SERVER_DIR], SERVER_DIR)).toBe(true)
    expect(isCovered(['test-results/dashboard-e2e'], SERVER_DIR)).toBe(false)
    expect(isCovered([], SERVER_DIR)).toBe(false)
  })
})
