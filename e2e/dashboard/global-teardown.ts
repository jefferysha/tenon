/** 只收自己拉起的服务（有 STARTED_MARK）；目录服务由 tenon test run 回收。 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { STARTED_MARK } from './global-setup'

const EXIT_TIMEOUT_MS = 15_000

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STARTED_MARK)) return
  const pid = Number(readFileSync(STARTED_MARK, 'utf8'))
  rmSync(STARTED_MARK, { force: true })
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  while (Date.now() < deadline && alive(pid)) await new Promise((resolve) => setTimeout(resolve, 100))
  if (alive(pid)) process.kill(pid, 'SIGKILL')
}
