import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildSnapshot, computeFingerprint, type SnapshotDeps } from './snapshot.js'
import { singleFlight } from './singleFlight.js'

const MAX_POST_BODY = 64 * 1024

export interface ServerTransportOptions {
  registry: () => string[]
  snapshotDeps: (nowMs?: number) => SnapshotDeps
  heartbeatMs: number
  pollIntervalMs: number
  webRoot?: string
  token: string
}

export function createServerTransport(options: ServerTransportOptions) {
  const { registry, snapshotDeps, heartbeatMs, pollIntervalMs, token } = options
const clients = new Set<ServerResponse>()
let lastFp = ''
let lastBeat = Date.now()
let pollTimer: ReturnType<typeof setInterval> | null = null

function broadcast(event: string, data: string): void {
  lastBeat = Date.now()
  const frame = `event: ${event}\ndata: ${data}\n\n`
  for (const res of clients) {
    try { res.write(frame) } catch { /* 断开的连接会在 close 事件里清理 */ }
  }
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const pollTick = singleFlight(async (): Promise<void> => {
  if (clients.size === 0) {
    stopPoll() // 零客户端不空转
    return
  }
  let fp: string
  const nowMs = Date.now()
  try {
    const deps = snapshotDeps(nowMs)
    fp = await computeFingerprint(registry(), nowMs, deps.rootAnchor, deps.readChangesDirectory, deps.viewer)
    if (fp !== lastFp) {
      lastFp = fp
      try {
        broadcast('snapshot', JSON.stringify(await buildSnapshot(deps)))
      } catch {
        /* 一次失败下轮再试 */
      }
    } else if (Date.now() - lastBeat > heartbeatMs) {
      lastBeat = Date.now()
      for (const res of clients) {
        try { res.write(': ping\n\n') } catch { /* ignore */ }
      }
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
      try { finish(JSON.parse(data)) } catch { finish(undefined) }
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
  clients.add(res)
  try {
    const nowMs = Date.now()
    const deps = snapshotDeps(nowMs)
    lastFp = await computeFingerprint(registry(), nowMs, deps.rootAnchor, deps.readChangesDirectory, deps.viewer)
    res.write(`event: snapshot\ndata: ${JSON.stringify(await buildSnapshot(deps))}\n\n`)
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

function acceptsGzip(header: string | string[] | undefined): boolean {
  if (header === undefined) return false
  const accepted = new Map<string, number>()
  for (const entry of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const [rawName, ...params] = entry.trim().toLowerCase().split(';')
    if (!rawName) continue
    const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
    const parsed = qParam === undefined ? 1 : Number(qParam.slice(2))
    accepted.set(rawName, Number.isFinite(parsed) ? parsed : 0)
  }
  const gzip = accepted.get('gzip')
  return (gzip ?? accepted.get('*') ?? 0) > 0
}
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
