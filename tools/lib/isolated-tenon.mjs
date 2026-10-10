/**
 * 用已构建的 CLI 在隔离环境里播种项目、启动 dashboard：Dashboard e2e（e2e/dashboard/support）与基准脚本（tools/bench）共用。
 *
 * 隔离 = 一个临时根：HOME、TENON_RUNTIME_HOME 与项目全部在里面，不读也不写开发机的 ~/.tenon、
 * ~/.codex、~/.claude 和项目注册表；身份固定为 e2e@tenon.test。播种只走真实的 CLI，不手写任何 Tenon 状态文件。
 *
 * 可信 Node：`tenon dashboard` 只肯用「物理身份可证明」的 Node 启动 server（packages/cli/src/commands/trusted-executable.ts：
 * 可执行文件本身、以及它的任一父目录，不得对组 / 其他人可写（sticky 目录除外），文件属主必须是 root 或当前用户）。
 * GitHub 托管 runner 上 setup-node 装在 /opt/hostedtoolcache 下，不满足这个条件，dashboard 会以
 * 「Dashboard 启动前无法冻结当前 Node 物理身份」退出 1。这个守卫是安全边界，不能放宽，所以由本工具在隔离根里备一份可信 Node：
 * `createScratch` 先用与守卫相同的条件检查 process.execPath，能过就直接用（开发机、已经备好可信 Node 的 PATH），
 * 过不了才把它复制到 <scratch>/node-bin/node（目录 0700、文件 0755、属主是当前用户，父目录是 sticky 的系统临时目录）。
 * 复制出来的那份随 `removeScratch` 一起删除。之后所有子进程（播种用的 CLI、dashboard、基准里的 status 采样）都用这一个 Node，
 * 路径经 env.TENON_ISOLATED_NODE 传递（见 `isolatedNode`）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { get as httpGet } from 'node:http'
import {
  accessSync, chmodSync, constants as fsConstants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INHERITED_RUNTIME_ROOT_VARS, withoutInheritedRuntimeRoots } from './runtime-roots.mjs'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const TENON_CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'tenon.mjs')
export const TENON_USER = 'e2e@tenon.test'

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const HEALTH_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 5_000

/**
 * `tenon` 的可信 Node 守卫是否会接受这个可执行文件——按 trusted-executable.ts `freezeTrustedExecutable` 的接受条件镜像
 * （只判定可否通过，不做物理身份冻结）：realpath 后是可执行的普通文件；文件不能对组 / 其他人可写；属主是 root 或当前用户；
 * 从它的目录一路到根，每一级都是真目录，且不能是「其他人可写」或「别的属主的组可写」——sticky 目录（/tmp）除外。
 * Windows 上守卫不检查权限位，这里同样直接放行。
 */
export function isTrustedExecutable(path, platform = process.platform) {
  let executable
  try {
    executable = realpathSync(path)
    accessSync(executable, fsConstants.X_OK)
  } catch {
    return false
  }
  if (platform === 'win32') return true
  let file
  try {
    file = lstatSync(executable)
  } catch {
    return false
  }
  if (!file.isFile() || file.isSymbolicLink()) return false
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : file.uid
  if ((file.mode & 0o022) !== 0 || (file.uid !== 0 && file.uid !== currentUid)) return false
  let cursor = dirname(executable)
  while (true) {
    let dir
    try {
      dir = lstatSync(cursor)
    } catch {
      return false
    }
    const otherWritable = (dir.mode & 0o002) !== 0
    const groupWritableByAnotherOwner = (dir.mode & 0o020) !== 0 && dir.uid !== file.uid
    const sticky = (dir.mode & 0o1000) !== 0
    if (!dir.isDirectory() || dir.isSymbolicLink() || ((otherWritable || groupWritableByAnotherOwner) && !sticky)) return false
    const parent = dirname(cursor)
    if (parent === cursor) return true
    cursor = parent
  }
}

/**
 * 给 tenon 备一个可信 Node：`source`（默认 process.execPath）已经能过守卫就原样返回；否则复制到 <scratch>/node-bin/node
 * （0700 目录 + 0755 文件）并返回复制品路径。复制品仍过不了守卫、或者复制出来跑不起来（Node 依赖相对安装目录的动态库，
 * 例如 Homebrew 的 libnode）时抛错，不悄悄退回不可信的那份。
 */
export function prepareTrustedNode(scratch, { source = process.execPath } = {}) {
  if (isTrustedExecutable(source)) return source
  const dir = join(scratch, 'node-bin')
  const target = join(dir, 'node')
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
  copyFileSync(realpathSync(source), target)
  chmodSync(target, 0o755)
  if (!isTrustedExecutable(target)) {
    throw new Error(`${source} 不在 tenon 可信 Node 守卫接受的位置，复制到 ${target} 后仍不被接受（检查临时目录 ${tmpdir()} 及其父目录的权限）`)
  }
  const probe = spawnSync(target, ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    throw new Error(`复制出来的 Node ${target} 无法独立运行（它可能依赖安装目录里的动态库）：请改用独立打包的 Node（如 actions/setup-node 装的）。\n${probe.stderr ?? ''}`)
  }
  return target
}

/**
 * 新建隔离根（realpath：macOS 的 /var 是 /private/var 的别名，注册表记的是真实路径）。
 * 返回值里的 `node` 是这个隔离根该用的可信 Node（见文件头），传给 `isolatedEnv`；`nodeSource` 只给测试换掉要检查的 Node。
 * 备可信 Node 失败时先删掉刚建的隔离根再抛错。
 */
export function createScratch(prefix, { nodeSource = process.execPath } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)))
  const home = join(scratch, 'home')
  const runtime = join(scratch, 'runtime')
  mkdirSync(home, { recursive: true })
  mkdirSync(runtime, { recursive: true })
  let node
  try {
    node = prepareTrustedNode(scratch, { source: nodeSource })
  } catch (error) {
    removeScratch(scratch)
    throw error
  }
  return { scratch, home, runtime, node }
}

const NODE_ENV = 'TENON_ISOLATED_NODE'

// 启动器导出的运行时根优先于 TENON_RUNTIME_HOME；构造隔离子进程环境的地方都经 withoutInheritedRuntimeRoots 去掉它们（定义见 ./runtime-roots.mjs）。
export { INHERITED_RUNTIME_ROOT_VARS, withoutInheritedRuntimeRoots }

/**
 * 子进程环境：继承宿主 PATH 等，但 HOME / 运行时根 / 身份换成隔离的，并去掉会让 CLI 找到真实插件或端口的变量。
 * 传入 `node`（createScratch 的返回值）时，把它记在 TENON_ISOLATED_NODE 里，runTenon / startDashboard 用它代替 process.execPath。
 */
export function isolatedEnv({ home, runtime, node }) {
  const env = withoutInheritedRuntimeRoots({
    ...process.env,
    HOME: home,
    TENON_RUNTIME_HOME: runtime,
    TENON_USER,
    TENON_USER_NAME: 'E2E',
    CODEX_HOME: join(home, '.codex'),
  })
  delete env.TENON_DASHBOARD_PORT
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.PLUGIN_ROOT
  delete env[NODE_ENV]
  if (node !== undefined) env[NODE_ENV] = node
  return env
}

/** 该环境该用哪个 Node 去跑 tenon：isolatedEnv 记下的可信 Node；没记就是当前进程自己的。 */
export function isolatedNode(env) {
  return env[NODE_ENV] ?? process.execPath
}

export function writeProjectFile(root, path, text) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

/** 跑一次 tenon；退出码不在 allow 里就抛错（带 stdout / stderr）。 */
export function runTenon(env, cwd, args, { allow = [0] } = {}) {
  const result = spawnSync(isolatedNode(env), [TENON_CLI, ...args], { cwd, env, encoding: 'utf8' })
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

/**
 * 在隔离环境里放一个假的桌面 opener（`open` / `xdg-open`），把它收到的 URL 追加到 openedFile，并把它排到 PATH 最前：
 * dashboard 的 `POST /api/session/open`（即 `tenon dashboard --open`）会交给它一条一次性登录链接，测试从文件里读出来，
 * 扮演“用户的浏览器”。不这样的话 server 会去开开发机上真正的浏览器。返回要并进子进程环境的变量。
 */
export function installFakeBrowserOpener(dir, openedFile, env) {
  mkdirSync(dir, { recursive: true })
  for (const name of ['open', 'xdg-open']) {
    const script = join(dir, name)
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${openedFile}'\n`)
    chmodSync(script, 0o755)
  }
  return { ...env, PATH: `${dir}:${env.PATH ?? ''}` }
}

const LOGIN_LINK = /登录链接[^\n]*?：(http:\/\/127\.0\.0\.1:\d+\/session\/start\?code=[A-Za-z0-9_-]+)/u

/**
 * 读 dashboard 日志里启动者专属的一次性登录链接。server 只在 stdout 是 TTY 或 `TENON_DASHBOARD_PRINT_LINK=1` 时打印它
 * （自动化自己创建日志、自己读，见 docs/usage/security-model.md）；链接 2 分钟内有效、只能用一次。
 */
export async function readLoginLink(logFile, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = LOGIN_LINK.exec(readFileSync(logFile, 'utf8'))
    if (match !== null) return match[1]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${logFile} 里没有一次性登录链接（启动 dashboard 时需设 TENON_DASHBOARD_PRINT_LINK=1）`)
}

/** 像浏览器一样打开登录链接，换出会话 cookie：{ name, value, header }，header 可直接放进 `Cookie:`。 */
export function exchangeLoginLink(link) {
  const target = new URL(link)
  return new Promise((resolve, reject) => {
    const req = httpGet({
      host: target.hostname, port: Number(target.port), path: `${target.pathname}${target.search}`,
      headers: { 'Sec-Fetch-Site': 'none' },
    }, (res) => {
      res.resume()
      const raw = res.headers['set-cookie']?.[0]
      if (res.statusCode !== 303 || raw === undefined) {
        reject(new Error(`登录链接没有换出会话（HTTP ${res.statusCode}）：它只能用一次，且 2 分钟内有效`))
        return
      }
      const pair = raw.split(';', 1)[0]
      const eq = pair.indexOf('=')
      resolve({ name: pair.slice(0, eq), value: pair.slice(eq + 1), header: pair })
    })
    req.on('error', reject)
  })
}

/**
 * 用 `tenon dashboard --port <空闲端口>` 起服务并等到 /api/health 通；日志写 logFile。
 * 返回 { url, port, child, session }：session 是启动者（本函数）用日志里的一次性链接换来的会话 cookie，
 * 之后的读写请求带 `Cookie: session.header`，浏览器上下文用 `session.name` / `session.value`。
 */
export async function startDashboard({ env, cwd, logFile }) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'w')
  const child = spawn(isolatedNode(env), [TENON_CLI, 'dashboard', '--port', String(port)], {
    cwd, env: { ...env, TENON_DASHBOARD_PRINT_LINK: '1' }, detached: true, stdio: ['ignore', log, log],
  })
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dashboard 提前退出（exit ${child.exitCode}），日志：${logFile}`)
    if (await healthy(url)) {
      const session = await exchangeLoginLink(await readLoginLink(logFile))
      return { url, port, child, session }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopGroup(child)
  throw new Error(`dashboard 在 ${HEALTH_TIMEOUT_MS / 1000}s 内没有就绪，日志：${logFile}`)
}

// 刚停下的 dashboard / CLI 子进程可能还在收尾写文件，递归删除带重试，不然 ENOTEMPTY 会盖住真正的失败；复制出来的 node-bin 也在这个根里，一并删除。
export function removeScratch(scratch) {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
