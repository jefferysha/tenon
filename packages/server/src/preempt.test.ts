/**
 * preempt.test —— B4 版本抢占：语义比较 + 裁决 + 真 HTTP health 探测 + 真 SIGTERM 抢占。
 * 抢占用例真 spawn 子进程、真写 pidfile、真发信号、真断言子进程退出（非 mock）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import {
  compareVersions, decidePreemption, parseListenerPids, preemptOldServer, probeHealth, probePortOpen, readPidfile,
} from './preempt.js'
import { createTestDashboardServer } from './test-server.js'
import type { DashboardServer } from './types.js'
import { makeTempHome, testFlow } from './test-support.js'
import { resolveServerPaths } from './paths.js'

const servers: DashboardServer[] = []
const rawServers: Server[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (rawServers.length) {
    const server = rawServers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* already gone */ } }
})

describe('compareVersions —— 语义化数值比较', () => {
  it('主次修订逐段数值比较', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0) // 非字典序
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })
})

describe('decidePreemption —— bind / reuse / preempt', () => {
  const stateScopeId = `sha256-v1-${'1'.repeat(64)}`
  const otherStateScopeId = `sha256-v1-${'2'.repeat(64)}`

  it('无既有 server → bind', () => {
    expect(decidePreemption(null, '0.1.0', undefined, stateScopeId)).toBe('bind')
  })
  it('managed transaction 不得抢占普通 Dashboard 或其他 transaction', () => {
    const releaseId = `sha256-${'a'.repeat(64)}`
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.1.0', releaseId, stateScopeId },
      '9.0.0',
      releaseId,
      stateScopeId,
      'transaction-a',
    )).toBe('reuse')
    expect(decidePreemption(
      {
        ok: true,
        scope: 'global',
        version: '0.1.0',
        releaseId,
        stateScopeId,
        transactionId: 'transaction-b',
      },
      '9.0.0',
      releaseId,
      stateScopeId,
      'transaction-a',
    )).toBe('reuse')
    expect(decidePreemption(
      {
        ok: true,
        scope: 'global',
        version: '0.1.0',
        releaseId,
        stateScopeId,
        transactionId: 'transaction-a',
      },
      '9.0.0',
      releaseId,
      stateScopeId,
      'transaction-a',
    )).toBe('preempt')
  })
  it('既有同版本 → reuse', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.1.0', stateScopeId },
      '0.1.0',
      undefined,
      stateScopeId,
    )).toBe('reuse')
  })
  it('同 release 但 machine-state scope 不同 → preempt，绝不串 registry', () => {
    const releaseId = `sha256-${'a'.repeat(64)}`
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.2.0', releaseId, stateScopeId },
      '0.2.0',
      releaseId,
      otherStateScopeId,
    )).toBe('preempt')
  })
  it('未绑定 immutable release 的直接 bundle 不得跨 state scope 抢占现有服务', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.2.0', stateScopeId },
      '0.2.0',
      undefined,
      otherStateScopeId,
    )).toBe('reuse')
  })
  it('未绑定 immutable release 的直接 bundle 不得覆盖现有 managed release', () => {
    expect(decidePreemption(
      {
        ok: true,
        scope: 'global',
        version: '0.2.0',
        releaseId: `sha256-${'a'.repeat(64)}`,
        stateScopeId,
      },
      '9.0.0',
      undefined,
      stateScopeId,
    )).toBe('reuse')
  })
  it('managed release 遇到 legacy health 缺 machine-state scope → preempt 一次完成迁移', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.2.0' },
      '0.2.0',
      `sha256-${'a'.repeat(64)}`,
      stateScopeId,
    )).toBe('preempt')
  })
  it('同一语义版本但不可变 release 已变化 → preempt，确保每次已发布更新刷新服务', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.2.0', releaseId: `sha256-${'a'.repeat(64)}`, stateScopeId },
      '0.2.0',
      `sha256-${'b'.repeat(64)}`,
      stateScopeId,
    )).toBe('preempt')
  })
  it('同一语义版本且不可变 release 未变化 → reuse', () => {
    const releaseId = `sha256-${'a'.repeat(64)}`
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.2.0', releaseId, stateScopeId },
      '0.2.0',
      releaseId,
      stateScopeId,
    )).toBe('reuse')
  })
  it('同一语义版本但既有服务不能证明 release 身份 → preempt，迁移旧服务', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.2.0', stateScopeId },
      '0.2.0',
      `sha256-${'a'.repeat(64)}`,
      stateScopeId,
    )).toBe('preempt')
  })
  it('既有旧版本、我更新 → preempt', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.1.0', stateScopeId },
      '0.2.0',
      undefined,
      stateScopeId,
    )).toBe('preempt')
  })
  it('既有更新版本 → reuse（让位，不降级抢占）', () => {
    expect(decidePreemption(
      { ok: true, scope: 'global', version: '0.3.0', stateScopeId },
      '0.2.0',
      undefined,
      stateScopeId,
    )).toBe('reuse')
  })
})

describe('probeHealth —— 真 HTTP 探测既有 server', () => {
  it('活着 → 回 health（含 version）；关掉 → null', async () => {
    const srv = createTestDashboardServer({
      paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
      version: '5.5.5',
      token: 't',
      registry: () => [],
      flow: testFlow(),
    })
    servers.push(srv)
    const { port } = await srv.listen(0, '127.0.0.1')
    const alive = await probeHealth(port, '127.0.0.1', 500)
    expect(alive?.version).toBe('5.5.5')
    expect(alive?.scope).toBe('global')
    await srv.close()
    servers.pop()
    const dead = await probeHealth(port, '127.0.0.1', 300)
    expect(dead).toBeNull()
  })

  it('200 partial body 被对端中断时在墙钟期限内返回 null', async () => {
    const server = createServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{"ok":')
      setImmediate(() => socket.destroy())
    })
    rawServers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing raw server address')

    await expect(probeHealth(address.port, '127.0.0.1', 200)).resolves.toBeNull()
  })
})

describe('readPidfile', () => {
  it('缺文件 → null', () => {
    expect(readPidfile('/no/such/pidfile')).toBeNull()
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('failed to allocate TCP port')); return }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function listenerChild(port: number): Promise<ChildProcess> {
  const script = [
    "const http = require('node:http')",
    `http.createServer((_req, res) => res.end('ok')).listen(${port}, '127.0.0.1')`,
    'setInterval(() => {}, 1 << 30)',
  ].join(';')
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await probePortOpen(port, '127.0.0.1', 100)) return child
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('listener child did not open its port')
}

function childPid(child: ChildProcess): number {
  if (typeof child.pid !== 'number' || child.pid <= 1) throw new Error('listener child has no usable pid')
  return child.pid
}

describe('listener PID parsing', () => {
  it('only admits positive integer listener PIDs and deduplicates them', () => {
    expect(parseListenerPids('42\n42\n0\n-1\nnot-a-pid\n')).toEqual([42])
  })
})

describe('preemptOldServer —— 真读 pidfile + 真 SIGTERM 干掉旧进程', () => {
  it('kill 旧 pid → 子进程真退出、端口空出 → 返回 true', async () => {
    const home = await makeTempHome()
    const pidfile = join(home, 'dashboard-server.json')
    const port = await freePort()
    // 真起一个 TCP listener。抢占路径必须验证 pid 的确拥有目标端口，不能只信 pidfile。
    const child = await listenerChild(port)
    children.push(child)
    const pid = childPid(child)

    await writeFile(pidfile, JSON.stringify({ pid, port, version: '0.1.0' }), 'utf8')

    let exitSignal: NodeJS.Signals | null = null
    const exited = new Promise<void>((resolve) =>
      child.on('exit', (_code, signal) => { exitSignal = signal; resolve() }))
    const ok = await preemptOldServer(pidfile, port, '127.0.0.1', { waitMs: 3000 })
    expect(ok).toBe(true)
    await exited // 若没真被 kill，这里会挂到测试超时
    expect(exitSignal).toBe('SIGTERM') // 真被我们的 SIGTERM 终结
  })

  it('legacy server 无 pidfile 时，仅在 health pid 与实际 listener 一致才接管', async () => {
    const home = await makeTempHome()
    const pidfile = join(home, 'dashboard-server.json')
    const port = await freePort()
    const child = await listenerChild(port)
    children.push(child)
    const pid = childPid(child)

    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    const ok = await preemptOldServer(pidfile, port, '127.0.0.1', { waitMs: 3000, legacyPid: pid })
    expect(ok).toBe(true)
    await exited
  })

  it('legacy health 报错 pid 不拥有 listener → fail-closed，绝不误杀', async () => {
    const home = await makeTempHome()
    const pidfile = join(home, 'dashboard-server.json')
    const port = await freePort()
    const child = await listenerChild(port)
    children.push(child)
    const pid = childPid(child)

    const ok = await preemptOldServer(pidfile, port, '127.0.0.1', { waitMs: 300, legacyPid: pid - 1 })
    expect(ok).toBe(false)
    expect(await probePortOpen(port, '127.0.0.1', 100)).toBe(true)
  })

  it('pidfile transaction id 不精确匹配时绝不 signal 真实 listener', async () => {
    const home = await makeTempHome()
    const pidfile = join(home, 'dashboard-server.json')
    const port = await freePort()
    const child = await listenerChild(port)
    children.push(child)
    const pid = childPid(child)
    await writeFile(pidfile, JSON.stringify({
      pid,
      port,
      version: '1.0.1',
      transactionId: 'transaction-other',
    }), 'utf8')

    const ok = await preemptOldServer(pidfile, port, '127.0.0.1', {
      waitMs: 300,
      transactionId: 'transaction-current',
    })

    expect(ok).toBe(false)
    expect(await probePortOpen(port, '127.0.0.1', 100)).toBe(true)
  })
})
