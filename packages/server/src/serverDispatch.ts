/**
 * The method router behind the access gate: a request that passed `serverAccess` is handed to the handler of its
 * HTTP method, and a write drops the snapshot cache entries it may have touched (see snapshotWriteScope.ts) before it
 * runs and again once it settled.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dropWrittenProjects } from './snapshotWriteScope.js'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>

export interface DispatchDeps {
  /** One handler per routed method; any other method answers 405. */
  readonly routes: ReadonlyMap<string, RouteHandler>
  readonly snapshotCache: { invalidate(roots?: readonly string[]): void }
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly errMsg: (error: unknown) => string
}

export function createDispatcher(deps: DispatchDeps): (req: IncomingMessage, res: ServerResponse, path: string, method: string) => void {
  const { routes, snapshotCache, sendJson, errMsg } = deps
  return (req, res, path, method) => {
    // A write drops only the projects it names (query or body root), everything when it names none.
    if (method !== 'GET') dropWrittenProjects(snapshotCache, req, path, 'before')
    const route = routes.get(method)
    const handler = route === undefined
      ? Promise.resolve(sendJson(res, 405, { ok: false, error: 'method not allowed' }))
      : route(req, res, path)
    if (method !== 'GET') void handler.finally(() => dropWrittenProjects(snapshotCache, req, path, 'after')).catch(() => undefined)
    handler.catch((e) => {
      // 未预期的失败进 server 日志（只记方法、路径与消息，不记查询串：登录码在查询里）。
      process.stderr.write(`[dashboard-server] 500 ${method} ${path}: ${errMsg(e)}\n`)
      try { sendJson(res, 500, { ok: false, error: errMsg(e) }) } catch { /* 已写头 */ }
    })
  }
}
