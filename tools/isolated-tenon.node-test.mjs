import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  INHERITED_RUNTIME_ROOT_VARS, REPO_ROOT, createScratch, exchangeLoginLink, freePort, isTrustedExecutable, isolatedEnv, isolatedNode,
  prepareTrustedNode, readLoginLink, removeScratch, withoutInheritedRuntimeRoots,
} from './lib/isolated-tenon.mjs'
import { exportDecoyHostRoots } from './lib/decoy-host-roots.mjs'

test('isolatedEnv points HOME and the runtime home at the scratch root and drops host plugin variables', () => {
  const previous = { plugin: process.env.CLAUDE_PLUGIN_ROOT, port: process.env.TENON_DASHBOARD_PORT }
  process.env.CLAUDE_PLUGIN_ROOT = '/somewhere/else'
  process.env.TENON_DASHBOARD_PORT = '1234'
  const scratch = createScratch('tenon-isolated-test')
  try {
    const env = isolatedEnv(scratch)
    assert.equal(env.HOME, join(scratch.scratch, 'home'))
    assert.equal(env.TENON_RUNTIME_HOME, join(scratch.scratch, 'runtime'))
    assert.equal(env.TENON_USER, 'e2e@tenon.test')
    assert.equal(env.CLAUDE_PLUGIN_ROOT, undefined)
    assert.equal(env.TENON_DASHBOARD_PORT, undefined)
    assert.ok(existsSync(env.HOME) && existsSync(env.TENON_RUNTIME_HOME))
  } finally {
    removeScratch(scratch.scratch)
    if (previous.plugin === undefined) delete process.env.CLAUDE_PLUGIN_ROOT
    else process.env.CLAUDE_PLUGIN_ROOT = previous.plugin
    if (previous.port === undefined) delete process.env.TENON_DASHBOARD_PORT
    else process.env.TENON_DASHBOARD_PORT = previous.port
  }
  assert.equal(existsSync(scratch.scratch), false)
})

// `tenon test run` executes the suites under the launcher, which exports the machine's real runtime roots.  Those
// take precedence over TENON_RUNTIME_HOME, so a child CLI that inherits them writes into the real Tenon state
// (2026-10-08: the bench fixture registered its temporary projects in the user's real projects.json).
test('isolatedEnv drops inherited runtime roots so TENON_RUNTIME_HOME decides every path', () => {
  const names = ['TENON_RUNTIME_ROOTS', 'TENON_RUNTIME_DATA_ROOT', 'TENON_RUNTIME_STATE_ROOT', 'TENON_RUNTIME_CONFIG_ROOT']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.TENON_RUNTIME_ROOTS = '{"version":1,"dataRoot":"/real","stateRoot":"/real/state","configRoot":"/real/config"}'
  process.env.TENON_RUNTIME_DATA_ROOT = '/real'
  process.env.TENON_RUNTIME_STATE_ROOT = '/real/state'
  process.env.TENON_RUNTIME_CONFIG_ROOT = '/real/config'
  const scratch = createScratch('tenon-isolated-roots-test')
  try {
    const env = isolatedEnv(scratch)
    for (const name of names) assert.equal(env[name], undefined, `${name} must not leak into the isolated env`)
    assert.equal(env.TENON_RUNTIME_HOME, join(scratch.scratch, 'runtime'))
  } finally {
    removeScratch(scratch.scratch)
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('withoutInheritedRuntimeRoots returns a copy without the four launcher roots and leaves the input alone', () => {
  assert.deepEqual([...INHERITED_RUNTIME_ROOT_VARS].sort(), [
    'TENON_RUNTIME_CONFIG_ROOT', 'TENON_RUNTIME_DATA_ROOT', 'TENON_RUNTIME_ROOTS', 'TENON_RUNTIME_STATE_ROOT',
  ])
  const input = {
    PATH: '/usr/bin',
    TENON_RUNTIME_HOME: '/scratch/runtime',
    TENON_RUNTIME_ROOTS: '{"version":1}',
    TENON_RUNTIME_DATA_ROOT: '/real',
    TENON_RUNTIME_STATE_ROOT: '/real/state',
    TENON_RUNTIME_CONFIG_ROOT: '/real/config',
  }
  const before = { ...input }
  const clean = withoutInheritedRuntimeRoots(input)
  assert.deepEqual(clean, { PATH: '/usr/bin', TENON_RUNTIME_HOME: '/scratch/runtime' })
  assert.notEqual(clean, input)
  assert.deepEqual(input, before, 'the caller\'s environment is not modified')
  assert.deepEqual(withoutInheritedRuntimeRoots({}), {})
})

test('a child started with isolatedEnv does not see the roots the host launcher exported', () => {
  const decoy = exportDecoyHostRoots('tenon-isolated-child-test')
  const scratch = createScratch('tenon-isolated-child-test')
  try {
    const present = (env) => JSON.parse(spawnSync(process.execPath, [
      '-e', 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).filter((name) => process.env[name] !== undefined).sort()))',
      JSON.stringify(INHERITED_RUNTIME_ROOT_VARS),
    ], { env, encoding: 'utf8' }).stdout)
    assert.deepEqual(present(process.env), [...INHERITED_RUNTIME_ROOT_VARS].sort(), 'the control: a plain child inherits all four')
    const env = isolatedEnv(scratch)
    assert.deepEqual(present(env), [])
    assert.equal(env.TENON_RUNTIME_HOME, scratch.runtime)
    assert.deepEqual(decoy.written(), [])
  } finally {
    removeScratch(scratch.scratch)
    decoy.restore()
  }
})

test('freePort returns a usable loopback port', async () => {
  const port = await freePort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
})

const posixOnly = { skip: process.platform === 'win32' ? '可信 Node 守卫的权限位检查只在 POSIX 上有意义' : false }

/** 一个只有 shebang 的假 node：能被执行、能回答 --version，足够验证复制与守卫，不依赖真 Node 的动态库布局。 */
function fakeNode(dir, { mode = 0o755, body = 'echo v0.0.0' } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'node')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, mode)
  return file
}

function tempRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'tenon-trusted-node-test-')))
}

// 与 CLI 里真正的守卫（freezeTrustedExecutable）逐场景对拍：tsc 产物在 npm run build 之后才有。
const guardModule = join(REPO_ROOT, 'packages', 'cli', 'dist', 'commands', 'trusted-executable.js')
const realGuard = existsSync(guardModule)
  ? (await import(pathToFileURL(guardModule).href)).freezeTrustedExecutable
  : undefined

test('isTrustedExecutable accepts a private 0755 executable and a sticky-world-writable parent', posixOnly, () => {
  const root = tempRoot()
  try {
    const owned = fakeNode(join(root, 'owned'))
    chmodSync(join(root, 'owned'), 0o700)
    const sticky = fakeNode(join(root, 'sticky'))
    chmodSync(join(root, 'sticky'), 0o1777)
    const groupOwnedBySelf = fakeNode(join(root, 'group'))
    chmodSync(join(root, 'group'), 0o770)
    symlinkSync(owned, join(root, 'link'))
    assert.equal(isTrustedExecutable(owned), true)
    assert.equal(isTrustedExecutable(sticky), true)
    assert.equal(isTrustedExecutable(groupOwnedBySelf), true, '同属主的组可写目录守卫接受')
    assert.equal(isTrustedExecutable(join(root, 'link')), true, '符号链接按 realpath 判定')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isTrustedExecutable rejects what the CLI guard rejects: writable file, non-sticky world-writable parent, non-executable', posixOnly, () => {
  const root = tempRoot()
  try {
    const groupWritableFile = fakeNode(join(root, 'gw'), { mode: 0o775 })
    const worldWritableFile = fakeNode(join(root, 'ww'), { mode: 0o757 })
    const openParent = fakeNode(join(root, 'open'))
    chmodSync(join(root, 'open'), 0o777)
    const notExecutable = fakeNode(join(root, 'plain'), { mode: 0o644 })
    for (const path of [groupWritableFile, worldWritableFile, openParent, notExecutable, join(root, 'missing')]) {
      assert.equal(isTrustedExecutable(path), false, path)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isTrustedExecutable agrees with the real freezeTrustedExecutable on every scenario',
  { skip: process.platform === 'win32' ? 'POSIX only' : realGuard === undefined ? 'packages/cli/dist/commands 还没有 tsc 产物（先 npm run build）' : false },
  () => {
    const root = tempRoot()
    try {
      const paths = [
        fakeNode(join(root, 'a')),
        fakeNode(join(root, 'b'), { mode: 0o775 }),
        fakeNode(join(root, 'c'), { mode: 0o757 }),
        fakeNode(join(root, 'd')),
        fakeNode(join(root, 'e')),
        fakeNode(join(root, 'f')),
        fakeNode(join(root, 'g'), { mode: 0o644 }),
        join(root, 'missing'),
      ]
      chmodSync(join(root, 'd'), 0o777)
      chmodSync(join(root, 'e'), 0o1777)
      chmodSync(join(root, 'f'), 0o770)
      for (const path of paths) {
        assert.equal(isTrustedExecutable(path), realGuard(path) !== undefined, path)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

test('prepareTrustedNode returns an already trusted node untouched and creates nothing', posixOnly, () => {
  const root = tempRoot()
  try {
    const source = fakeNode(join(root, 'bin'))
    chmodSync(join(root, 'bin'), 0o700)
    assert.equal(prepareTrustedNode(root, { source }), source)
    assert.equal(existsSync(join(root, 'node-bin')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createScratch copies an untrusted node into <scratch>/node-bin, threads it through the env and removeScratch deletes it', posixOnly, () => {
  const root = tempRoot()
  let scratch
  try {
    const source = fakeNode(join(root, 'toolcache'), { mode: 0o775 })
    chmodSync(join(root, 'toolcache'), 0o777)
    assert.equal(isTrustedExecutable(source), false)

    scratch = createScratch('tenon-isolated-test', { nodeSource: source })
    const expected = join(scratch.scratch, 'node-bin', 'node')
    assert.equal(scratch.node, expected)
    assert.equal(statSync(join(scratch.scratch, 'node-bin')).mode & 0o777, 0o700)
    const copy = statSync(expected)
    assert.equal(copy.mode & 0o777, 0o755)
    assert.equal(copy.uid, process.getuid())
    assert.equal(readFileSync(expected, 'utf8'), readFileSync(source, 'utf8'))
    assert.equal(isTrustedExecutable(expected), true)
    assert.equal(statSync(source).mode & 0o777, 0o775, '原来的 node 不被改动')

    const env = isolatedEnv(scratch)
    assert.equal(isolatedNode(env), expected)
    assert.equal(isolatedNode({}), process.execPath, '没有记录时退回当前进程的 node')
    assert.equal(isolatedNode(isolatedEnv({ home: scratch.home, runtime: scratch.runtime })), process.execPath)
  } finally {
    if (scratch !== undefined) removeScratch(scratch.scratch)
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(existsSync(scratch.scratch), false)
  assert.equal(existsSync(scratch.node), false)
})

test('createScratch removes the fresh scratch and throws when the copied node cannot run', posixOnly, () => {
  const root = tempRoot()
  const privateTmp = tempRoot()
  const previousTmp = process.env.TMPDIR
  try {
    const source = fakeNode(join(root, 'toolcache'), { mode: 0o775, body: 'exit 1' })
    chmodSync(join(root, 'toolcache'), 0o777)
    // 让 os.tmpdir() 指向一个只有本测试用的目录，才能确切断言没有遗留隔离根（系统临时目录里别的进程也在写）。
    process.env.TMPDIR = privateTmp
    assert.throws(() => createScratch('tenon-isolated-fail', { nodeSource: source }), /无法独立运行/)
    assert.deepEqual(readdirSync(privateTmp), [])
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
    rmSync(root, { recursive: true, force: true })
    rmSync(privateTmp, { recursive: true, force: true })
  }
})

test('readLoginLink picks the one-time link the server printed to its launcher, and gives up without one', async () => {
  const root = tempRoot()
  try {
    const log = join(root, 'dashboard.log')
    writeFileSync(log, '[dashboard-server] Global server http://127.0.0.1:18765  version=1\n')
    await assert.rejects(readLoginLink(log, { timeoutMs: 150 }), /TENON_DASHBOARD_PRINT_LINK=1/)
    writeFileSync(log, '[dashboard-server] 登录链接（一次性，2 分钟内有效）：http://127.0.0.1:18765/session/start?code=abc_DEF-123\n', { flag: 'a' })
    assert.equal(await readLoginLink(log), 'http://127.0.0.1:18765/session/start?code=abc_DEF-123')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exchangeLoginLink follows the link like a browser and returns the session cookie, once', async () => {
  let used = false
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.headers['sec-fetch-site'])
    if (used) { res.writeHead(403); res.end(); return }
    used = true
    res.writeHead(303, { location: '/', 'set-cookie': 'tenon_session_1=secret; HttpOnly; SameSite=Strict; Path=/' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const link = `http://127.0.0.1:${server.address().port}/session/start?code=x`
    assert.deepEqual(await exchangeLoginLink(link), { name: 'tenon_session_1', value: 'secret', header: 'tenon_session_1=secret' })
    assert.deepEqual(seen, ['none'])
    await assert.rejects(exchangeLoginLink(link), /只能用一次/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
