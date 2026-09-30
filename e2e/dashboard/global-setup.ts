/**
 * 保证有一个可用的被测 dashboard：
 *   · 目录的 `dashboard-e2e` 服务（tenon test run）已经把它拉起 → 直接复用；
 *   · 本地直接 `npx playwright test -c e2e/dashboard/playwright.config.ts` → 这里拉起 serve.mjs，teardown 时收掉。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, SERVER_DIR, SERVER_STATE, isHealthy, readServerState } from './support/server-state'

const READY_TIMEOUT_MS = 120_000
export const STARTED_MARK = join(SERVER_DIR, 'started-by-playwright.pid')

async function reusable(): Promise<boolean> {
  if (!existsSync(SERVER_STATE)) return false
  try {
    return await isHealthy(readServerState().url)
  } catch {
    return false
  }
}

export default async function globalSetup(): Promise<void> {
  if (await reusable()) return
  mkdirSync(SERVER_DIR, { recursive: true })
  rmSync(SERVER_STATE, { force: true })
  const log = openSync(join(SERVER_DIR, 'serve.log'), 'w')
  const child = spawn(process.execPath, [join(REPO_ROOT, 'e2e', 'dashboard', 'support', 'serve.mjs')], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log],
  })
  child.unref()
  if (child.pid === undefined) throw new Error('serve.mjs 没有启动')
  writeFileSync(STARTED_MARK, String(child.pid))
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve.mjs 提前退出（exit ${child.exitCode}），见 ${join(SERVER_DIR, 'serve.log')}`)
    if (await reusable()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`dashboard-e2e 服务 ${READY_TIMEOUT_MS / 1000}s 内没有就绪，见 ${join(SERVER_DIR, 'serve.log')}`)
}
