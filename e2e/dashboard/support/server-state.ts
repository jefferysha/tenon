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
  /** 挂着待批准评审的任务所在的项目（review-approval.spec.ts 会批准其中的评审；任务名见 reviewChangeName）。 */
  readonly review: string
  /** serve.mjs 用 server 打印给启动者的一次性登录链接换来的会话 cookie；每个浏览器上下文都带它。 */
  readonly session: { readonly name: string; readonly value: string }
  /** 假桌面 opener 收到的登录链接追加到这个文件（`POST /api/session/open` 的交付物）。 */
  readonly openedUrlFile: string
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

/** seed.mjs 的 seedReview 为每个浏览器项目、每种用例各建一个挂着评审的任务；两处命名必须一致。 */
export type ReviewKind = 'single' | 'approve' | 'spent' | 'stale'
export function reviewChangeName(kind: ReviewKind, browser: string): string {
  return `rv-${kind}-${browser}`
}
