import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveProductPaths } from '@tenon/kernel'
import { exchangeLoginUrl } from './test-session.js'
import { reqGet } from './test-support.js'

const serverBundle = fileURLToPath(new URL('../dist/dashboard.mjs', import.meta.url))

/** How long a SIGTERMed bundle gets to finish its graceful shutdown before it is SIGKILLed (CPU-starved CI runners are slow). */
const TERM_GRACE_MS = 10_000
/** How long a SIGKILLed bundle gets to be reaped before cleanup gives up waiting. */
const KILL_WAIT_MS = 5_000

const children: ChildProcess[] = []
const dirs: string[] = []

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

/** Resolves true once the child has exited, false if it is still running after `timeoutMs`. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

/**
 * SIGTERM the bundle and wait until the process is really gone, with SIGKILL as the bounded fallback.
 * The signal alone is not enough: on SIGTERM the bundle still logs "stopping" into state/logs/dashboard.log
 * and closes down, so removing its home right after `kill()` races those writes (ENOTEMPTY on state/logs).
 */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || hasExited(child)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, TERM_GRACE_MS)) return
  child.kill('SIGKILL')
  await waitForExit(child, KILL_WAIT_MS)
}

afterEach(async () => {
  // Every child must be gone before its home is removed; one that will not die must not skip the removal.
  await Promise.allSettled(children.splice(0).map(terminate))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

/**
 * The real bundle in an isolated home; resolves once it says where it listens. With the link flag set it
 * also waits for the whole login line: main.ts writes the banner and the link as two separate chunks.
 */
async function startBundle(extraEnv: NodeJS.ProcessEnv): Promise<{ port: number; stdout: () => string; stateRoot: string; child: ChildProcess }> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-server-bundle-'))
  dirs.push(home)
  const runtimeHome = join(home, 'runtime')
  const paths = resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: home })
  await mkdir(paths.stateRoot, { recursive: true })
  // What a pre-0.3 release left behind: a readable write token.
  await writeFile(paths.dashboardTokenPath, JSON.stringify({ token: 'legacy-write-token', pid: 1 }), { mode: 0o600 })
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, TENON_RUNTIME_HOME: runtimeHome, TENON_DASHBOARD_PORT: String(port),
  }
  delete env.TENON_DASHBOARD_PRINT_LINK
  Object.assign(env, extraEnv)
  const child = spawn(process.execPath, [serverBundle], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { out += chunk })
  const wantsLink = extraEnv.TENON_DASHBOARD_PRINT_LINK === '1'
  const ready = (): boolean => out.includes('Global server http://') && (!wantsLink || /session\/start\?code=[A-Za-z0-9_-]+\n/u.test(out))
  const deadline = Date.now() + 30_000
  while (!ready() && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dashboard bundle exited early (${child.exitCode}): ${out}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { port, stdout: () => out, stateRoot: paths.stateRoot, child }
}

describe('Dashboard server bundle process contract', () => {
  test('help writes real line feeds and exits without starting the server', () => {
    const result = spawnSync(process.execPath, [serverBundle, '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      'Tenon Dashboard server is an internal managed-runtime entrypoint.\n'
      + 'Use `tenon dashboard` to start or inspect the product.\n',
    )
    expect(result.stderr).toBe('')
  })

  test('unknown arguments fail with one newline-terminated stderr record', () => {
    const result = spawnSync(process.execPath, [serverBundle, '--unknown'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      '[dashboard-server] unsupported direct server arguments: --unknown\n',
    )
  })

  test('a launcher that asks for it gets one login link on stdout; the link signs in once and nothing else does', async () => {
    const started = await startBundle({ TENON_DASHBOARD_PRINT_LINK: '1' })
    const link = /登录链接[^\n]*?：(http:\/\/127\.0\.0\.1:\d+\/session\/start\?code=[A-Za-z0-9_-]+)/u.exec(started.stdout())?.[1]
    expect(link).toBeDefined()

    // Anonymous callers: a sign-in prompt and 401s, never a token.
    const page = await reqGet(started.port, '/')
    expect(page.status).toBe(401)
    expect(page.body).not.toContain('__TENON_DASHBOARD_TOKEN__')
    expect((await reqGet(started.port, '/api/snapshot')).status).toBe(401)
    expect((await reqGet(started.port, '/api/health')).status).toBe(200)

    const cookie = await exchangeLoginUrl(link ?? '')
    expect((await reqGet(started.port, '/api/snapshot', '127.0.0.1', { Cookie: cookie })).status).toBe(200)
    await expect(exchangeLoginUrl(link ?? '')).rejects.toThrow(/login exchange failed: 403/)
  }, 60_000)

  test('removes the write-token file an older release left in the state directory, and writes no credential file', async () => {
    const started = await startBundle({ TENON_DASHBOARD_PRINT_LINK: '1' })
    expect(existsSync(join(started.stateRoot, 'dashboard-token.json'))).toBe(false)
    expect(existsSync(join(started.stateRoot, 'dashboard-server.json'))).toBe(true) // pid/port/version only
  }, 60_000)

  test('mirrors its output into state/logs/dashboard.log (0600): startup and shutdown are recorded, the login code never is', async () => {
    const started = await startBundle({ TENON_DASHBOARD_PRINT_LINK: '1' })
    const code = /session\/start\?code=([A-Za-z0-9_-]+)/u.exec(started.stdout())?.[1]
    expect(code).toBeDefined()
    const logPath = join(started.stateRoot, 'logs', 'dashboard.log')
    expect(existsSync(logPath)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(logPath).mode & 0o777).toBe(0o600)
    // The mirror appends to the file synchronously before it forwards a chunk to stdout, so the link is already logged.
    const running = readFileSync(logPath, 'utf8')
    expect(running).toMatch(/ event \[dashboard-server\] starting pid=\d+ port=\d+ version=/u)
    expect(running).toContain('Global server http://127.0.0.1:')
    expect(running).toContain('/session/start?code=[REDACTED:token]')
    expect(running).not.toContain(code ?? 'unreachable')

    await terminate(started.child)
    expect(hasExited(started.child)).toBe(true)
    const stopped = readFileSync(logPath, 'utf8')
    expect(stopped).toMatch(/\[dashboard-server\] stopping pid=\d+/u)
    expect(stopped).not.toContain(code ?? 'unreachable')
  }, 60_000)

  test('prints no login link when nobody asked for one (managed background start: stdout is not a terminal)', async () => {
    const started = await startBundle({})
    expect(started.stdout()).not.toContain('session/start')
    expect(started.stdout()).not.toMatch(/code=/u)
  }, 60_000)
})
