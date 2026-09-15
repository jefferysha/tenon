/**
 * `GET /api/user` and `POST /api/user`. The server attributes writes to the identity resolved on its own machine
 * for the requested root; the bearer token stays a route credential, never a person.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  resolveTenonUser, userResolutionView, validateUserId, writeUserConfig, type TenonUserResolution,
} from '@tenon/kernel'

export type ResolveUser = (root: string) => TenonUserResolution

export function defaultResolveUser(root: string): TenonUserResolution {
  return root === '' ? resolveTenonUser(undefined, process.env) : resolveTenonUser(root, process.env)
}

interface UserRouteDeps {
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly resolveUser: ResolveUser
}

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

function decodeUserInput(body: unknown): { id: string; name: string } | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return '请求体必须是 {"id","name"}'
  const record = body as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'name') return '请求体必须是 {"id","name"}'
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return '请求体必须是 {"id","name"}'
  if (validateUserId(record.id) === null) return `用户邮箱非法: ${record.id}`
  return { id: record.id, name: record.name }
}

/** Called after the Host, token and JSON guards of the POST router. */
export async function handlePostUserRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: UserRouteDeps & {
    readonly readJsonBody: (req: IncomingMessage) => Promise<unknown>
    readonly paths: { readonly userConfigPath: string }
  },
): Promise<void> {
  if (path !== '/api/user') return
  const input = decodeUserInput(await deps.readJsonBody(req))
  if (typeof input === 'string') return deps.sendJson(res, 400, { ok: false, code: 'invalid-user', error: input })
  try {
    await writeUserConfig(deps.paths.userConfigPath, input)
  } catch {
    return deps.sendJson(res, 500, { ok: false, error: 'user.json 写入失败' })
  }
  deps.sendJson(res, 200, { ok: true, ...userResolutionView(deps.resolveUser('')) })
}
