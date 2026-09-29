/**
 * 服务生命周期 × 真实进程：就绪探测三种方式、启动即退出、超时、启动前端口已被占用、回收整个进程组（含孙进程）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogService } from '@tenon/kernel'
import { serviceRecord, startService, stopService, type RunningService } from './services.js'

let dir = ''
const started: RunningService[] = []
const servers: Server[] = []

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenon-services-')) })
afterEach(async () => {
  for (const service of started.splice(0)) await stopService(service)
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  await rm(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise((done) => server.close(done))
  return port
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function service(overrides: Partial<CatalogService> & Pick<CatalogService, 'start' | 'ready'>): CatalogService {
  return { id: 'svc', cwd: '.', stop: 'SIGTERM', env: [], ...overrides }
}

async function start(definition: CatalogService) {
  const result = await startService(definition, { repoRoot: dir, logPath: join(dir, 'logs', 'svc.log'), env: process.env })
  started.push(result.running)
  return result
}

describe('startService / stopService', () => {
  it('URL 就绪：记录就绪耗时；回收后端口不再响应', async () => {
    const port = await freePort()
    const script = `require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`
    const { running, start: result } = await start(service({ start: `node -e "${script}"`, ready: { url: `http://127.0.0.1:${port}/`, timeout_s: 20 } }))
    expect(result.ok).toBe(true)
    expect(running.readyMs).toBeGreaterThanOrEqual(0)
    await stopService(running)
    expect(serviceRecord(running, 'services/svc.log')).toMatchObject({ id: 'svc', exit: 'stopped', leaked_pids: [], log: 'services/svc.log' })
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).rejects.toThrow()
  })

  it('端口就绪与日志就绪', async () => {
    const port = await freePort()
    const listen = `require('net').createServer().listen(${port},'127.0.0.1')`
    const byPort = await start(service({ start: `node -e "${listen}"`, ready: { port, timeout_s: 20 } }))
    expect(byPort.start.ok).toBe(true)
    const byLog = await start(service({ id: 'logged', start: `node -e "console.log('server is ready'); setInterval(()=>{},1000)"`, ready: { log: 'is ready', timeout_s: 20 } }))
    expect(byLog.start.ok).toBe(true)
  })

  it('启动即退出 → crashed，附日志尾部', async () => {
    const { start: result, running } = await start(service({ start: `node -e "console.error('boom on start'); process.exit(3)"`, ready: { port: await freePort(), timeout_s: 20 } }))
    expect(result.ok).toBe(false)
    expect(result.failure).toContain('boom on start')
    expect(running.exit).toBe('crashed')
  })

  it('超时未就绪 → not-ready 且已回收', async () => {
    const { start: result, running } = await start(service({ start: `node -e "setInterval(()=>{},1000)"`, ready: { port: await freePort(), timeout_s: 1 } }))
    expect(result.ok).toBe(false)
    expect(result.failure).toContain('没等到')
    expect(running.exit).toBe('not-ready')
    expect(running.child.pid !== undefined && alive(running.child.pid)).toBe(false)
  })

  it('启动前 URL / 端口已经在响应 → 拒绝复用（别的进程占着，测试会打到旧代码上）', async () => {
    const server = createServer((_request, response) => response.end('old')).listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise((done) => server.once('listening', done))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const { start: result, running } = await start(service({ start: `node -e "setInterval(()=>{},1000)"`, ready: { url: `http://127.0.0.1:${port}/`, timeout_s: 5 } }))
    expect(result.ok).toBe(false)
    expect(result.failure).toContain('已经在响应')
    expect(running.exit).toBe('not-ready')
  })

  it('回收整个进程组：命令启动的孙进程也被杀掉，pid 不残留', async () => {
    const pidFile = join(dir, 'grandchild.pid')
    const port = await freePort()
    const grand = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'ignore'}); require('net').createServer().listen(${port},'127.0.0.1')`
    const { running, start: result } = await start(service({ start: `node -e ${JSON.stringify(parent)}`, ready: { port, timeout_s: 20 } }))
    expect(result.ok).toBe(true)
    let pid = 0
    for (let attempt = 0; attempt < 50 && pid === 0; attempt++) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      if (pid === 0) await new Promise((done) => setTimeout(done, 100))
    }
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    await stopService(running)
    expect(alive(pid)).toBe(false)
    expect(running.leaked).toEqual([])
    await writeFile(pidFile, '', 'utf8')
  })
})
