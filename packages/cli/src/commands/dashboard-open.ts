/**
 * Asks the running Dashboard server to open the user's browser, already signed in.
 *
 * The one-time login URL is minted and delivered by the server itself; this command never sees it,
 * so a process that merely runs `tenon dashboard --open` (or calls the same endpoint) cannot turn
 * that into a session of its own.  `false` means "nothing was opened" (no desktop opener, refused,
 * or the server is unreachable) and the caller falls back to the foreground guidance.
 * `attachToRunningDashboard` applies it to the normal case where the dashboard already runs.
 */
import { request } from 'node:http'
import type { CliDeps } from '../deps.js'
import type { DashboardHealthIdentity } from './dashboard-health.js'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 4 * 1_024

export function requestDashboardBrowserOpen(url: string): Promise<boolean> {
  let port: number
  try {
    port = Number(new URL(url).port)
  } catch {
    return Promise.resolve(false)
  }
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false)
  return new Promise((resolveOpened) => {
    let settled = false
    const finish = (opened: boolean): void => {
      if (settled) return
      settled = true
      resolveOpened(opened)
    }
    const body = '{}'
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/api/session/open',
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        if (text.length > MAX_RESPONSE_BYTES) {
          res.destroy()
          finish(false)
        }
      })
      res.once('error', () => finish(false))
      res.once('end', () => {
        if (res.statusCode !== 200) return finish(false)
        try {
          const parsed: unknown = JSON.parse(text)
          finish(typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'opened') === true)
        } catch {
          finish(false)
        }
      })
    })
    req.once('timeout', () => { req.destroy(); finish(false) })
    req.once('error', () => finish(false))
    req.end(body)
  })
}

/** The slice of the dashboard runtime that attaching to a running server needs. */
export interface AttachRuntime {
  resolveStateScopeId(): string
  probeHealthyServer(
    port: number,
    expectedReleaseId: string | undefined,
    expectedStateScopeId: string,
    expectedTransactionId?: string | '*',
  ): Promise<DashboardHealthIdentity | null>
  openBrowser(url: string): Promise<boolean>
}

export const OPEN_FAILED_GUIDANCE =
  '[dashboard] 无法自动打开浏览器。有桌面环境时重试 tenon dashboard --open；'
  + '无桌面环境时在终端前台运行 tenon dashboard --port <空闲端口>（例如 19765），终端会打印一次性登录链接，'
  + '在能访问该端口的浏览器里打开即可。'

/**
 * `tenon dashboard --open` on a machine where the dashboard already runs (the normal case after setup)
 * must not spawn a second server: it asks the running one to open the browser, signed in.  Returns the
 * exit code, or null when no healthy dashboard of this state scope answers and the normal start applies.
 */
export async function attachToRunningDashboard(
  deps: CliDeps,
  port: number,
  open: boolean,
  runtime: AttachRuntime,
): Promise<number | null> {
  let running: Awaited<ReturnType<AttachRuntime['probeHealthyServer']>>
  try {
    running = await runtime.probeHealthyServer(port, undefined, runtime.resolveStateScopeId(), '*')
  } catch {
    return null
  }
  if (running === null) return null
  const url = `http://127.0.0.1:${port}/`
  deps.io.out(`[dashboard] 已在运行：${url}（pid ${running.pid}）`)
  if (!open) {
    deps.io.out('[dashboard] 页面需要登录：运行 tenon dashboard --open，浏览器会自动打开并登录。')
    return 0
  }
  let opened = false
  try {
    opened = await runtime.openBrowser(url)
  } catch {
    opened = false
  }
  if (opened) {
    deps.io.out('[dashboard] 已请求服务替你打开浏览器（一次性登录链接只交给浏览器）。')
    return 0
  }
  deps.io.err(OPEN_FAILED_GUIDANCE)
  return 1
}
