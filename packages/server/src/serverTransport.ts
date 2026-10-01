import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { SnapshotDeps } from './snapshot.js'
import { createSnapshotCache } from './snapshotCache.js'
import { acceptsGzip, type SharedListSnapshot } from './snapshotShared.js'
import { singleFlight } from './singleFlight.js'
import { noteBodyRoot } from './snapshotWriteScope.js'

const MAX_POST_BODY = 64 * 1024

export interface ServerTransportOptions {
  snapshotDeps: (nowMs?: number) => SnapshotDeps
  heartbeatMs: number
  pollIntervalMs: number
  webRoot?: string
  token: string
}

export function createServerTransport(options: ServerTransportOptions) {
  const { snapshotDeps, heartbeatMs, pollIntervalMs, token } = options
// /api/snapshot, the SSE first frame, poll broadcasts and the AFK views all read this one cache.
const snapshotCache = createSnapshotCache({ snapshotDeps })
const clients = new Set<ServerResponse>()
/**
 * What each connected stream has been sent. A `list` client receives the list tier: one full `snapshot` frame, then a
 * `snapshot-delta` frame holding only the projects whose bytes moved (the digests it was last sent are in `sent`). A
 * `full` client receives the documented full snapshot, re-sent whole whenever the fingerprint moves.
 */
interface StreamClient {
  readonly view: 'list' | 'full'
  primed: boolean
  sent: Map<string, string>
  order: string
}
const streamClients = new WeakMap<ServerResponse, StreamClient>()
let lastFp = ''
let lastBeat = Date.now()
let pollTimer: ReturnType<typeof setInterval> | null = null

function write(res: ServerResponse, frame: string): void {
  try { res.write(frame) } catch { /* 断开的连接会在 close 事件里清理 */ }
}

/** The documented full snapshot goes to every `full` client whole, every time. */
function broadcastFull(body: string): void {
  lastBeat = Date.now()
  const frame = `event: snapshot\ndata: ${body}\n\n`
  for (const res of clients) if (streamClients.get(res)?.view === 'full') write(res, frame)
}

/** Send `client` what it is missing of `shared`: the whole snapshot the first time, afterwards only changed projects. */
function sendList(res: ServerResponse, client: StreamClient, shared: SharedListSnapshot): void {
  const order = shared.chunks.map((chunk) => chunk.root)
  const orderKey = order.join('\u0000')
  if (!client.primed) {
    write(res, `event: snapshot\ndata: ${shared.body}\n\n`)
    client.primed = true
  } else {
    const changed = shared.chunks.filter((chunk) => client.sent.get(chunk.root) !== chunk.digest)
    if (changed.length === 0 && orderKey === client.order) return
    write(res, `event: snapshot-delta\ndata: ${shared.envelope.slice(0, -1)},"roots":${JSON.stringify(order)},"projects":[${changed.map((chunk) => chunk.json).join(',')}]}\n\n`)
  }
  client.sent = new Map(shared.chunks.map((chunk) => [chunk.root, chunk.digest]))
  client.order = orderKey
  lastBeat = Date.now()
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function hasClients(view: StreamClient['view']): boolean {
  for (const res of clients) if (streamClients.get(res)?.view === view) return true
  return false
}

const pollTick = singleFlight(async (): Promise<void> => {
  if (clients.size === 0) {
    stopPoll() // 零客户端不空转
    return
  }
  try {
    const fp = await snapshotCache.fingerprint()
    if (fp !== lastFp) {
      try {
        if (hasClients('list')) {
          const shared = await snapshotCache.list()
          lastFp = shared.fingerprint
          for (const res of clients) {
            const client = streamClients.get(res)
            // A list client that has not received its first frame yet gets it here; the rest get the delta.
            if (client?.view === 'list') sendList(res, client, shared)
          }
        }
        if (hasClients('full')) {
          const shared = await snapshotCache.full()
          lastFp = shared.fingerprint
          broadcastFull(shared.body)
        }
      } catch {
        /* 一次失败下轮再试 */
      }
    } else if (Date.now() - lastBeat > heartbeatMs) {
      lastBeat = Date.now()
      for (const res of clients) write(res, ': ping\n\n')
    }
  } catch {
    return
  }
})

function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => { void pollTick() }, pollIntervalMs)
  pollTimer.unref?.()
}

// ── 响应工具 ──
function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res: ServerResponse, code: number, html: string): void {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: unknown): void => { if (!done) { done = true; resolve(v) } }
    const len = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
    if (Number.isFinite(len) && len > MAX_POST_BODY) return finish(undefined)
    let data = ''
    let size = 0
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      size += Buffer.byteLength(c)
      if (size > MAX_POST_BODY) { finish(undefined); req.destroy(); return }
      data += c
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(data)
        noteBodyRoot(req, parsed)
        finish(parsed)
      } catch { finish(undefined) }
    })
    req.on('error', () => finish(undefined))
  })
}

// ── SSE 端点 ──
async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const view = new URL(req.url ?? '/', 'http://localhost').searchParams.get('view') === 'list' ? 'list' : 'full'
  // A full client has no per-client state: it is sent whole snapshots as they are built, so it is primed from the start.
  const client: StreamClient = { view, primed: view === 'full', sent: new Map(), order: '' }
  streamClients.set(res, client)
  clients.add(res)
  try {
    if (view === 'list') {
      const shared = await snapshotCache.list()
      // The poll may have sent the first frame while this one was being built; a frame that old must not follow it.
      if (!client.primed) sendList(res, client, shared)
      // Whatever changed while the first frame was being built is sent now.
      sendList(res, client, await snapshotCache.list())
      if (clients.size === 1) lastFp = shared.fingerprint
    } else {
      const shared = await snapshotCache.full()
      write(res, `event: snapshot\ndata: ${shared.body}\n\n`)
      // Only the sole client may move the marker: any other client still has to be told what changed since its frame.
      if (clients.size === 1) lastFp = shared.fingerprint
    }
  } catch {
    /* 初始快照失败不影响后续推送 */
  }
  startPoll()
  req.on('close', () => {
    clients.delete(res)
    if (clients.size === 0) stopPoll()
  })
}

// ── SPA 静态供给（BACKLOG #26c）：webRoot 存在则服务 dashboard-app 产物 ──
const webRoot = options.webRoot
const STATIC_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}
const GZIP_MIN_BYTES = 1_024
const GZIP_TYPES = new Set(['.js', '.css', '.html', '.json', '.svg'])
const gzipCache = new Map<string, Buffer>()

function serveIndexWithToken(res: ServerResponse): boolean {
  if (!webRoot) return false
  try {
    let html = readFileSync(join(webRoot, 'index.html'), 'utf8')
    const jsToken = JSON.stringify(token).replace(/</g, '\\u003c')
    const inject = `<script>window.__TENON_DASHBOARD_TOKEN__ = ${jsToken};</script>`
    html = html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : `${inject}${html}`
    sendHtml(res, 200, html)
    return true
  } catch { return false }
}
/** /assets/* 静态供给：限 webRoot/assets 子树（防路径穿越），命中返回 true。 */
function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!webRoot || !path.startsWith('/assets/')) return false
  const rel = path.slice(1) // 去前导 /
  if (rel.includes('..')) return false
  const abs = join(webRoot, rel)
  if (!abs.startsWith(join(webRoot, 'assets'))) return false
  try {
    const source = readFileSync(abs)
    const ext = abs.slice(abs.lastIndexOf('.'))
    const compressible = GZIP_TYPES.has(ext) && source.length >= GZIP_MIN_BYTES
    const gzip = compressible && acceptsGzip(req.headers['accept-encoding'])
    let body: Uint8Array = source
    if (gzip) {
      const compressed = gzipCache.get(abs) ?? gzipSync(source)
      gzipCache.set(abs, compressed)
      body = compressed
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    })
    res.end(body)
    return true
  } catch { return false }
}

/** v9-I/J：session-link 核心查询 —— 单条端点与批量端点共用（不复制粘贴）。查 automation_worktree
 *  →回落 root→listMemSessions→拼 resumeCmd；入参 root/name 假定已过校验（名字格式/root 信任锚/
 *  change 存在），此函数只管查询与降级，不做 400/404 判断。查询异常收敛 found:false（不外抛），
 *  同 /api/afk/readiness「查不到是常态不是故障」的恒 200 哲学。 */

  return {
    snapshotCache,
    clients,
    stopPoll,
    sendJson,
    sendHtml,
    readJsonBody,
    handleStream,
    serveIndexWithToken,
    serveAsset,
  }
}
