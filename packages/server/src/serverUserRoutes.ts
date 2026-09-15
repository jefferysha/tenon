/**
 * `GET /api/user`, `POST /api/user` and `POST /api/change/:name/owner` (接手). The server attributes writes to the
 * identity resolved on its own machine for the requested root; the bearer token stays a route credential, never a
 * person. Hand-over to another person is CLI-only (`tenon owner set`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  actorOf, isTenonUser, ownerRequiredMessage, resolveTenonUser, stateStorageExistsSync, transferOwner, USER_MISSING_HINT,
  userResolutionView, validateUserId, writeUserConfig,
  type HistoryWriter, type StateStore, type TenonUserResolution,
} from '@tenon/kernel'

export type ResolveUser = (root: string) => TenonUserResolution

export function defaultResolveUser(root: string): TenonUserResolution {
  return root === '' ? resolveTenonUser(undefined, process.env) : resolveTenonUser(root, process.env)
}

interface UserRouteDeps {
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly resolveUser: ResolveUser
}

interface PostUserRouteDeps extends UserRouteDeps {
  readonly readJsonBody: (req: IncomingMessage) => Promise<unknown>
  readonly paths: { readonly userConfigPath: string }
  readonly isRegisteredRoot: (root: string) => boolean
  readonly store: StateStore
  readonly history: HistoryWriter
  readonly clock: () => string
}

const OWNER_ROUTE = /^\/api\/change\/([^/]+)\/owner$/

/** Called after the Host check. A non-empty root must be registered. */
export function handleGetUserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: UserRouteDeps & { readonly isRegisteredRoot: (root: string) => boolean },
): boolean {
  if (path !== '/api/user') return false
  const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
  if (root !== '' && !deps.isRegisteredRoot(root)) {
    deps.sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
    return true
  }
  deps.sendJson(res, 200, { ok: true, ...userResolutionView(deps.resolveUser(root)) })
  return true
}

function exactKeys(body: unknown, keys: readonly string[]): body is Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const actual = Object.keys(body).sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

async function saveUser(req: IncomingMessage, res: ServerResponse, deps: PostUserRouteDeps): Promise<void> {
  const body = await deps.readJsonBody(req)
  if (!exactKeys(body, ['id', 'name']) || typeof body.id !== 'string' || typeof body.name !== 'string') {
    return deps.sendJson(res, 400, { ok: false, code: 'invalid-user', error: '请求体必须是 {"id","name"}' })
  }
  if (validateUserId(body.id) === null) {
    return deps.sendJson(res, 400, { ok: false, code: 'invalid-user', error: `用户邮箱非法: ${body.id}` })
  }
  try {
    await writeUserConfig(deps.paths.userConfigPath, { id: body.id, name: body.name })
  } catch {
    return deps.sendJson(res, 500, { ok: false, error: 'user.json 写入失败' })
  }
  deps.sendJson(res, 200, { ok: true, ...userResolutionView(deps.resolveUser('')) })
}

async function takeOwner(req: IncomingMessage, res: ServerResponse, segment: string, deps: PostUserRouteDeps): Promise<void> {
  const body = await deps.readJsonBody(req)
  if (!exactKeys(body, ['root']) || typeof body.root !== 'string') {
    return deps.sendJson(res, 400, { ok: false, error: '请求体必须是 {"root"}' })
  }
  const root = body.root
  if (!deps.isRegisteredRoot(root)) return deps.sendJson(res, 404, { ok: false, error: 'root 非已知 Project（未注册或不可信）' })
  let name: string
  try {
    name = decodeURIComponent(segment)
  } catch {
    return deps.sendJson(res, 400, { ok: false, error: '非法 change 名' })
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return deps.sendJson(res, 400, { ok: false, error: '非法 change 名' })
  const dir = join(root, 'openspec', 'changes', name)
  if (!stateStorageExistsSync(dir)) return deps.sendJson(res, 404, { ok: false, error: '找不到该 change' })
  const user = deps.resolveUser(root)
  if (!isTenonUser(user)) return deps.sendJson(res, 412, { ok: false, code: 'user-missing', error: USER_MISSING_HINT })
  try {
    const result = await transferOwner(
      { store: deps.store, history: deps.history, clock: deps.clock },
      { changeDir: dir, change: name, actor: actorOf(user) },
    )
    if (result.kind === 'owner-required') {
      return deps.sendJson(res, 403, {
        ok: false, code: 'owner-required', owner: result.owner, error: ownerRequiredMessage(name, result.owner),
      })
    }
    if (result.kind === 'changed' && result.historyError !== undefined) {
      process.stderr.write(`WARN: history 写入失败: ${result.historyError instanceof Error ? result.historyError.message : String(result.historyError)}\n`)
    }
    deps.sendJson(res, 200, { ok: true, owner: result.to, changed: result.kind === 'changed' })
  } catch {
    deps.sendJson(res, 500, { ok: false, error: '负责人更新失败' })
  }
}

/** Called after the Host, token and JSON guards of the POST router. */
export async function handlePostUserRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PostUserRouteDeps,
): Promise<void> {
  if (path === '/api/user') return saveUser(req, res, deps)
  const owner = OWNER_ROUTE.exec(path)
  if (owner !== null) return takeOwner(req, res, owner[1] ?? '', deps)
}
