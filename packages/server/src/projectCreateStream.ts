/**
 * POST /api/projects/create/stream：与 POST /api/projects/create 同一请求体（dry_run 忽略，总是执行），
 * 执行过程以 text/event-stream 逐步回报，供新建项目对话框显示进度。三闸由 POST 路由表在分派前完成。
 *
 * 开始执行前的失败（请求体不合法、目录已存在、git 不可用、缺声明身份…）仍是普通 JSON 错误与原状态码；
 * 一旦开始执行，响应恒为 200，事件依次是：
 *   event: plan    data: { steps: string[] }
 *   event: step    data: { id, state: 'running' | 'done' | 'failed', error?, code? }（每步 running → done / failed）
 *   event: done    data: 与 /api/projects/create 成功体相同
 *   event: failed  data: { ok: false, status, code, error, step? }
 * 客户端中途断开不中止执行（新建目录失败会自行回滚，半途停下反而留下半成品）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { auditActor, type ResolveInstructionUser } from './instructionAudit.js'
import { prepareProjectCreate, runGitCommand, runProjectCreate, type GitRunner, type ProjectCreateDeps } from './projectCreate.js'
import { createStepIds } from './projectCreateRun.js'
import type { ServerPaths } from './types.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

export const PROJECT_CREATE_STREAM_PATH = '/api/projects/create/stream'

export interface ProjectCreateStreamDeps {
  readonly paths: ServerPaths
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  readonly workflowRootAnchors?: Map<string, WorkflowRootAnchor>
  readonly runGit?: GitRunner
  readonly resolveUser?: ResolveInstructionUser
}

function write(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export async function handleProjectCreateStream(req: IncomingMessage, res: ServerResponse, deps: ProjectCreateStreamDeps): Promise<void> {
  if (!deps.workflowRootAnchors) return deps.sendJson(res, 404, { ok: false, error: '未知端点' })
  const raw = deps.readJsonBody ? await deps.readJsonBody(req) : undefined
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw, dry_run: false } : raw
  const createDeps: ProjectCreateDeps = {
    paths: deps.paths, workflowRootAnchors: deps.workflowRootAnchors, runGit: deps.runGit ?? runGitCommand,
    actor: auditActor(deps.resolveUser, ''),
  }
  const prepared = await prepareProjectCreate(body, createDeps)
  if (!('plan' in prepared)) return deps.sendJson(res, prepared.status, prepared.body)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  write(res, 'plan', { steps: createStepIds(prepared.plan) })
  const result = await runProjectCreate(prepared.plan, createDeps, (event) => write(res, 'step', event))
  if (result.status === 200) write(res, 'done', result.body)
  else write(res, 'failed', { ...(typeof result.body === 'object' && result.body !== null ? result.body : {}), ok: false, status: result.status })
  res.end()
}
