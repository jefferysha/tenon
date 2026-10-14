import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerProjectAnchored } from './projects.js'
import type { PostRouteDeps } from './serverPostRoutes.js'

/**
 * POST /api/projects —— 注册项目进机器级注册表（G18）。任务一律由 agent 对话里的 `/tenon` 经路由评估后
 * `tenon init` 创建，Dashboard 没有新建任务的写接口。
 */
export async function handlePostProjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PostRouteDeps,
): Promise<void> {
  const { sendJson, readJsonBody, workflowRootAnchors, paths } = deps
  if (path === '/api/projects') {
    const body = await readJsonBody(req)
    const rawRoot = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).root : undefined
    const result = await registerProjectAnchored(paths, workflowRootAnchors, rawRoot)
    if (!result.ok) return sendJson(res, result.code, { ok: false, error: result.error })
    return sendJson(res, 200, { ok: true, root: result.root })
  }
}
