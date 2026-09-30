/**
 * 用已构建的 CLI 在隔离环境里播种项目、启动 dashboard：Dashboard e2e（e2e/dashboard/support）与基准脚本（tools/bench）共用。
 *
 * 隔离 = 一个临时根：HOME、TENON_RUNTIME_HOME 与项目全部在里面，不读也不写开发机的 ~/.tenon、
 * ~/.codex、~/.claude 和项目注册表；身份固定为 e2e@tenon.test。播种只走真实的 CLI，不手写任何 Tenon 状态文件。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const TENON_CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'tenon.mjs')
export const TENON_USER = 'e2e@tenon.test'

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const HEALTH_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 5_000

/** 新建隔离根（realpath：macOS 的 /var 是 /private/var 的别名，注册表记的是真实路径）。 */
export function createScratch(prefix) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)))
  const home = join(scratch, 'home')
  const runtime = join(scratch, 'runtime')
  mkdirSync(home, { recursive: true })
  mkdirSync(runtime, { recursive: true })
  return { scratch, home, runtime }
}

/** 子进程环境：继承宿主 PATH 等，但 HOME / 运行时根 / 身份换成隔离的，并去掉会让 CLI 找到真实插件或端口的变量。 */
export function isolatedEnv({ home, runtime }) {
  const env = {
    ...process.env,
    HOME: home,
    TENON_RUNTIME_HOME: runtime,
    TENON_USER,
    TENON_USER_NAME: 'E2E',
    CODEX_HOME: join(home, '.codex'),
  }
  delete env.TENON_DASHBOARD_PORT
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.PLUGIN_ROOT
  return env
}

export function writeProjectFile(root, path, text) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

/** 跑一次 tenon；退出码不在 allow 里就抛错（带 stdout / stderr）。 */
export function runTenon(env, cwd, args, { allow = [0] } = {}) {
  const result = spawnSync(process.execPath, [TENON_CLI, ...args], { cwd, env, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (!allow.includes(result.status)) {
    throw new Error(`tenon ${args.join(' ')} 退出 ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function git(root, args, env) {
  const result = spawnSync('git', ['-c', 'user.email=e2e@tenon.test', '-c', 'user.name=E2E', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, env: { ...env, ...GIT_ENV }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败\n${result.stderr}`)
}

/** 项目根提交一次 base：测试产物不进提交，运行结果留在被忽略的目录里。 */
export function commitBase(root, env) {
  writeProjectFile(root, '.gitignore', 'node_modules\ntest-results\nplaywright-report\ncoverage\n')
  git(root, ['init', '-q', '-b', 'main'], env)
  git(root, ['add', '-A'], env)
  git(root, ['commit', '-q', '-m', 'base'], env)
}

/** 系统分配的空闲端口（先占再放；到 dashboard 真正监听之间有极短的窗口）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

export async function healthy(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** 先 SIGTERM 整个进程组，宽限期后 SIGKILL；`tenon dashboard` 与它拉起的 server 在同一个组里。 */
export async function stopGroup(child) {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline && groupAlive(child.pid)) await new Promise((resolve) => setTimeout(resolve, 100))
  if (groupAlive(child.pid)) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

/** 用 `tenon dashboard --port <空闲端口>` 起服务并等到 /api/health 通；日志写 logFile。返回 { url, port, child }。 */
export async function startDashboard({ env, cwd, logFile }) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'w')
  const child = spawn(process.execPath, [TENON_CLI, 'dashboard', '--port', String(port)], {
    cwd, env, detached: true, stdio: ['ignore', log, log],
  })
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dashboard 提前退出（exit ${child.exitCode}），日志：${logFile}`)
    if (await healthy(url)) return { url, port, child }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopGroup(child)
  throw new Error(`dashboard 在 ${HEALTH_TIMEOUT_MS / 1000}s 内没有就绪，日志：${logFile}`)
}

export function removeScratch(scratch) {
  rmSync(scratch, { recursive: true, force: true })
}
