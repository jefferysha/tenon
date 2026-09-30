/**
 * tap 测试基座 —— 真 socket / 真 http / 真 fs 工具（GOAL C9：绝不 mock，真起真请求）。
 * 非 *.test.ts（会被 tsc 编入 dist），仅测试引用；生产 index.ts 不导出。
 */
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

export interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface FakeUpstream {
  url: string
  port: number
  requests: CapturedRequest[]
  close(): Promise<void>
}

export interface FakeUpstreamOptions {
  /** 自定义响应；默认回显收到的请求为 JSON。 */
  respond?: (req: CapturedRequest, res: import('node:http').ServerResponse) => void
}

/** 真起一个 http 上游 server（随机端口），记录收到的请求。 */
export async function startFakeUpstream(opts: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = []
  const server: Server = createHttpServer((req: IncomingMessage, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => { body += c })
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      }
      requests.push(captured)
      if (opts.respond) return opts.respond(captured, res)
      const payload = Buffer.from(JSON.stringify({ ok: true, echo: safeParse(body), path: captured.url }), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 真起一个 SSE 上游：分块推送 text/event-stream。 */
export async function startFakeSseUpstream(chunks: string[]): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = []
  const server: Server = createHttpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body })
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      let i = 0
      const tick = (): void => {
        if (i >= chunks.length) { res.end(); return }
        res.write(chunks[i++])
        setTimeout(tick, 5)
      }
      tick()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface TcpEcho { port: number; connections: number; close(): Promise<void> }

/** 真起一个 TCP echo server（供 CONNECT 盲隧道透明转发测试）。 */
export async function startTcpEcho(): Promise<TcpEcho> {
  let connections = 0
  const server: TcpServer = createTcpServer((sock: Socket) => {
    connections += 1
    sock.on('data', (d) => { try { sock.write(d) } catch { /* closed */ } })
    sock.on('error', () => { /* ignore */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    get connections() { return connections },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface HttpResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  json<T = unknown>(): T
}

/** 直连 http 请求（用于打 proxy 的监听端口）。 */
export function httpReq(
  opts: { host?: string; port: number; path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? ''
    const headers = { ...(opts.headers ?? {}) }
    if (opts.method === 'POST' && !('Content-Length' in headers) && !('content-length' in headers)) {
      headers['Content-Length'] = String(Buffer.byteLength(body))
    }
    const r = httpRequest(
      { host: opts.host ?? '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        let b = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { b += c })
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: b,
          json: <T,>() => JSON.parse(b) as T,
        }))
      },
    )
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

/**
 * 经 forward proxy 做 CONNECT 盲隧道，返回建立的 socket（已收到 200）。
 * 调用方可对 socket 写字节、读回显（透明转发验证）。
 */
export function connectThroughProxy(proxyPort: number, authority: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData)
        if (/^HTTP\/1\.1 200/.test(buf)) resolve(sock)
        else { sock.destroy(); reject(new Error('CONNECT 未返回 200: ' + buf.split('\r\n')[0])) }
      }
    }
    sock.on('data', onData)
    sock.on('error', reject)
  })
}

/** 经 forward proxy 发一个明文 http 绝对 URI 请求（POST http://host/path）。 */
export function forwardHttpReq(
  proxyPort: number,
  target: { host: string; port: number; path: string },
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const absolute = `http://${target.host}:${target.port}${target.path}`
  const body = opts.body ?? ''
  const headers: Record<string, string> = { Host: `${target.host}:${target.port}`, ...(opts.headers ?? {}) }
  if (opts.method === 'POST' && !('Content-Length' in headers)) headers['Content-Length'] = String(Buffer.byteLength(body))
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port: proxyPort, method: opts.method ?? 'GET', path: absolute, headers },
      (res) => {
        let b = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { b += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, json: <T,>() => JSON.parse(b) as T }))
      },
    )
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

export async function tempTapDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pl-tap-'))
}

/** 递归删除带重试：daemon / 代理刚停下时还在收尾写文件，裸 rm 会以 ENOTEMPTY 失败。 */
export async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}
