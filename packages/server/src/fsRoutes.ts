/**
 * 选择文件夹的两个端点：
 *
 * - POST /api/fs/choose-folder `{ title?, start_dir? }`：调起本机原生对话框。Host 守卫、token、application/json
 *   三闸由 POST 路由表在分派前完成。200 `{ ok: true, path }` | `{ ok: false, cancelled: true }` |
 *   `{ ok: false, unavailable: true }`；已有对话框打开时 409 `picker-busy`。
 * - GET /api/fs/list?dir=&hidden=1：列子目录（页面内浏览器）。目录名属于本机私有信息，所以这个 GET 同样要
 *   Host 守卫 + token。
 */
import { lstatSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import type { FolderChooser } from './folderChooser.js'
import { listFolders } from './folderList.js'
import { tokenFromHeaders, tokensMatch } from './token.js'

export interface FsRouteResult { readonly status: number; readonly body: unknown }

export interface FsGetDeps {
  readonly isLocalHost: (host: string | undefined, port: number) => boolean
  readonly boundPort: () => number
  readonly token: string
  /** 页面内浏览器的起点（主目录快捷）。 */
  readonly hostHome: string
}

export interface FsPostDeps {
  readonly readJsonBody?: (req: IncomingMessage) => Promise<unknown>
  readonly folderChooser: FolderChooser
}

const failure = (status: number, code: string, error: string): FsRouteResult => ({ status, body: { ok: false, code, error } })

const TITLE_MAX = 200
const DEFAULT_TITLE = 'Tenon'

function decodeChooseRequest(value: unknown): { title: string; startDir: string | null } | null {
  if (value === undefined || value === null) return { title: DEFAULT_TITLE, startDir: null }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const body = Object.fromEntries(Object.entries(value))
  if (Object.keys(body).some((key) => key !== 'title' && key !== 'start_dir')) return null
  const title = body.title ?? DEFAULT_TITLE
  const start = body.start_dir ?? null
  // 控制字符不能进系统对话框标题。
  if (typeof title !== 'string' || title.length > TITLE_MAX || /\p{Cc}/u.test(title)) return null
  if (start !== null && (typeof start !== 'string' || start.includes('\0') || !isAbsolute(start))) return null
  return { title: title === '' ? DEFAULT_TITLE : title, startDir: start !== null && isDirectory(start) ? start : null }
}

/** 起始目录不存在时不传给对话框（否则 osascript 直接报错），退回系统默认位置。 */
function isDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path)
    return entry.isDirectory() && !entry.isSymbolicLink()
  } catch {
    return false
  }
}

export function resolveFsGet(req: IncomingMessage, path: string, deps: FsGetDeps): FsRouteResult | null {
  if (path !== '/api/fs/list') return null
  if (!deps.isLocalHost(req.headers.host, deps.boundPort())) return failure(403, 'host-denied', 'Host header 不合法')
  const provided = tokenFromHeaders(req.headers)
  if (!provided || !tokensMatch(provided, deps.token)) return failure(401, 'token-required', '缺少或无效 token')
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  return listFolders(query.get('dir') ?? '', query.get('hidden') === '1', deps.hostHome)
}

export function resolveFsPost(req: IncomingMessage, path: string, deps: FsPostDeps): Promise<FsRouteResult> | null {
  if (path !== '/api/fs/choose-folder') return null
  return (async () => {
    const request = decodeChooseRequest(deps.readJsonBody ? await deps.readJsonBody(req) : undefined)
    if (request === null) return failure(400, 'invalid', '请求体不合法')
    const picked = await deps.folderChooser.choose(request)
    if (!picked.ok && 'busy' in picked) return failure(409, 'picker-busy', '已有选择框打开')
    return { status: 200, body: picked }
  })()
}
