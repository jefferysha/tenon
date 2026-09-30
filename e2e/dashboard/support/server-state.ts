/**
 * 被测 dashboard 的状态文件（serve.mjs 写）：地址、随机端口与种子项目的路径。
 * 路径与 serve.mjs 里的 STATE_FILE 是同一个位置：仓库根 test-results/dashboard-e2e-server/server.json。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const SERVER_DIR = join(REPO_ROOT, 'test-results', 'dashboard-e2e-server')
export const SERVER_STATE = join(SERVER_DIR, 'server.json')

export interface ServerState {
  readonly url: string
  readonly port: number
  /** serve.mjs 进程。 */
  readonly pid: number
  /** `tenon dashboard` 进程组 leader。 */
  readonly serverPid: number
  readonly scratch: string
  readonly home: string
  readonly runtime: string
  /** 带 change / 测试计划 / 一次失败运行的种子项目。 */
  readonly project: string
  /** 项目页启停客户端用的项目（改它的文件不影响 project 的测试运行记录）。 */
  readonly sandbox: string
}

export function readServerState(): ServerState {
  if (!existsSync(SERVER_STATE)) throw new Error(`没有 ${SERVER_STATE}：先启动 dashboard-e2e 服务（node e2e/dashboard/support/serve.mjs）`)
  return JSON.parse(readFileSync(SERVER_STATE, 'utf8')) as ServerState
}

export async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}
