import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  assertCodexAuthGuidance,
  assertCodexDiscovery,
  assertDashboardHealthIdentity,
  assertExternalStateUnchanged,
  assertInstalledRuntime,
  assertListenerIdentityProvable,
  assertSameDashboardIdentity,
  assertSupportedAcceptancePlatform,
  commandResultError,
  cleanupIsolatedDashboardAfterFailure,
  FORCED_RELEASE_ENTRIES,
  LOCAL_RELEASE_ENTRIES,
  dashboardIdentityMatches,
  FetchTimeoutError,
  fetchWithTimeout,
  hasExactLocalTenonMarketplace,
  isolatedAcceptanceStateScopeId,
  parseJson,
  preserveOwnedDashboardIdentity,
  publicInstallUrl,
  requireJsonObject,
  runCodexDiscovery,
  runCommand,
  snapshotExternalTenonState,
  waitForHealth,
} from './clean-codex-install-acceptance.mjs'

test('local release fixture mirrors a real tag for ignore rules', () => {
  // Omitting .gitignore made the fixture commit the upstream skills that a real tag never carries;
  // the install's own fetch then rewrote skills/skills.lock.json and the clone read dirty.
  assert.ok(LOCAL_RELEASE_ENTRIES.includes('.gitignore'))
  // .agents/ is ignored, yet the repository tracks the Codex marketplace manifest inside it.
  assert.ok(FORCED_RELEASE_ENTRIES.includes('.agents/plugins/marketplace.json'))
  for (const entry of FORCED_RELEASE_ENTRIES) assert.ok(LOCAL_RELEASE_ENTRIES.includes(entry))
})

test('clean-install auth guidance requires every supported login route and status verification', () => {
  const complete = [
    'codex login',
    'codex login --device-auth',
    'https://platform.openai.com/api-keys',
    'printenv OPENAI_API_KEY | codex login --with-api-key',
    'codex login status',
  ].join('\n')
  assert.doesNotThrow(() => assertCodexAuthGuidance(complete))
  assert.throws(
    () => assertCodexAuthGuidance(complete.replace('codex login --device-auth', '')),
    /device-auth/,
  )
  assert.throws(
    () => assertCodexAuthGuidance(
      complete.split('\n').filter((line) => line !== 'codex login').join('\n'),
    ),
    /codex login/,
  )
})

const identity = {
  ok: true,
  version: '1.0.2',
  releaseId: `sha256-${'a'.repeat(64)}`,
  transactionId: 'transaction-1',
  stateScopeId: `sha256-v1-${'b'.repeat(64)}`,
  pid: 1234,
}

function portAcceptsConnections(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

// The fixture children of the runCommand timeout tests must start node, bind their listener and write the
// identity file before runCommand's timer fires: that file is the only way the test can later prove the
// whole owned tree was reaped. Node needs about 50 ms for that on an idle machine and well over 100 ms under
// CPU contention, so a 100-300 ms timer raced the fixture's own start-up and left no identity file to read.
// The timer is deliberately far above any plausible start-up; the timeout path itself is what is asserted.
const FIXTURE_COMMAND_TIMEOUT_MS = 1_500

async function assertProcessReapedWithClosedPort(pid, port, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // SIGKILL is asynchronous: on a loaded runner the killed descendant can still hold its listener
    // for a few milliseconds after the owned group was signalled. Both the listener and the pid must
    // be gone before the deadline; neither is asserted on the first observation.
    const listening = await portAcceptsConnections(port)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      assert.equal(error.code, 'ESRCH')
      alive = false
    }
    if (!listening && !alive) return
    if (Date.now() >= deadline) {
      assert.fail(`process ${pid} remained observable after ${timeoutMs}ms (listening=${listening}, alive=${alive})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('dashboard identity requires exact release, transaction, state scope, and pid equality', () => {
  assert.equal(dashboardIdentityMatches(identity, { ...identity }), true)
  assert.equal(dashboardIdentityMatches(identity, { ...identity, pid: 9999 }), false)
  assert.throws(
    () => assertSameDashboardIdentity(identity, { ...identity, transactionId: 'transaction-2' }),
    /Dashboard identity changed/,
  )
})

test('Dashboard health rejects zero, negative, and unsafe PIDs before cleanup can signal them', () => {
  for (const pid of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertDashboardHealthIdentity({ ...identity, pid }, identity.releaseId, '1.0.2'),
      /does not match the active managed release/,
    )
  }
  assert.doesNotThrow(() => assertDashboardHealthIdentity(identity, identity.releaseId, '1.0.2'))
})

test('Dashboard health requires canonical nonempty state-scope and transaction identities', () => {
  for (const health of [
    { ...identity, version: '1.0.1' },
    { ...identity, stateScopeId: '' },
    { ...identity, stateScopeId: `sha256-v1-${'g'.repeat(64)}` },
    { ...identity, transactionId: '' },
    { ...identity, transactionId: 'contains whitespace' },
  ]) {
    assert.throws(
      () => assertDashboardHealthIdentity(health, identity.releaseId, '1.0.2'),
      /does not match the active managed release/,
    )
  }
})

test('external JSON object boundaries reject null and arrays with stable errors', () => {
  assert.throws(
    () => assertDashboardHealthIdentity(null, identity.releaseId, '1.0.2'),
    /Dashboard health must be a non-null JSON object/,
  )
  assert.throws(
    () => requireJsonObject(null, 'tenon runtime status'),
    /tenon runtime status must be a non-null JSON object/,
  )
  assert.throws(
    () => requireJsonObject([], 'tenon doctor'),
    /tenon doctor must be a non-null JSON object/,
  )
})

test('owned Dashboard registration is write-once and rejects a replacement identity', () => {
  const first = preserveOwnedDashboardIdentity(null, identity)
  assert.equal(first, identity)
  assert.equal(preserveOwnedDashboardIdentity(first, { ...identity }), first)
  assert.throws(
    () => preserveOwnedDashboardIdentity(first, { ...identity, pid: 9999 }),
    /Dashboard identity changed/,
  )
  assert.equal(first.pid, 1234)
})

test('allow-failure command errors preserve result, exit code, signal, and stderr', () => {
  const result = {
    code: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: 'terminated by fixture',
  }
  const error = commandResultError('fixture failed', result)
  assert.equal(error.cause, result)
  assert.equal(error.exitCode, null)
  assert.equal(error.signal, 'SIGTERM')
  assert.match(error.message, /terminated by fixture/)
})

test('local Marketplace idempotency requires one exact local tenon registration', () => {
  const root = '/workspace/tenon'
  assert.equal(hasExactLocalTenonMarketplace({ marketplaces: [] }, root), false)
  assert.equal(hasExactLocalTenonMarketplace({
    marketplaces: [{
      name: 'tenon',
      marketplaceSource: { sourceType: 'local', source: root },
    }],
  }, root), true)
  assert.throws(
    () => hasExactLocalTenonMarketplace({
      marketplaces: [{
        name: 'tenon',
        marketplaceSource: { sourceType: 'git', source: 'already exists' },
      }],
    }, root),
    /conflicting tenon registration/,
  )
  assert.throws(
    () => hasExactLocalTenonMarketplace({
      marketplaces: [
        { name: 'tenon', marketplaceSource: { sourceType: 'local', source: root } },
        { name: 'tenon', marketplaceSource: { sourceType: 'local', source: root } },
      ],
    }, root),
    /duplicate tenon registrations/,
  )
})

test('JSON parse failures preserve the original syntax error as cause', () => {
  assert.throws(
    () => parseJson('not-json', 'fixture'),
    (error) => error.message === 'fixture did not return valid JSON'
      && error.cause instanceof SyntaxError,
  )
})

test('Codex discovery requires enabled plugin, entry skill, four hook events, and untrusted hooks', () => {
  const discovery = {
    pluginInstalled: {
      marketplaces: [{ plugins: [{ id: 'tenon@tenon', enabled: true }] }],
    },
    skills: {
      data: [{ skills: [{ name: 'tenon:tenon', enabled: true }] }],
    },
    hooks: {
      data: [{
        hooks: ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse']
          .map((eventName) => ({
            pluginId: 'tenon@tenon',
            eventName,
            trustStatus: 'untrusted',
          })),
      }],
    },
  }

  assert.doesNotThrow(() => assertCodexDiscovery(discovery))
  assert.throws(
    () => assertCodexDiscovery({
      ...discovery,
      hooks: { data: [{ hooks: discovery.hooks.data[0].hooks.slice(1) }] },
    }),
    /missing Tenon hook event/,
  )
})

test('command timeout waits for an ignored SIGTERM child to be killed before rejecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-command-timeout-'))
  const identityFile = join(root, 'identity.json')
  try {
    await assert.rejects(
      runCommand(process.execPath, [
        '-e',
        "const fs=require('node:fs');const net=require('node:net');"
          + "const server=net.createServer();"
          + "server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],"
          + "JSON.stringify({pid:process.pid,port:server.address().port})));"
          + "process.on('SIGTERM', () => {});",
        identityFile,
      ], {
        cwd: root,
        env: process.env,
        timeoutMs: FIXTURE_COMMAND_TIMEOUT_MS,
        terminationGraceMs: 50,
      }),
      new RegExp(`timed out after ${FIXTURE_COMMAND_TIMEOUT_MS}ms`),
    )
    const identity = JSON.parse(await readFile(identityFile, 'utf8'))
    await assertProcessReapedWithClosedPort(identity.pid, identity.port)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('command failure preserves a spontaneous terminating signal', {
  skip: process.platform === 'win32',
}, async () => {
  await assert.rejects(
    runCommand(process.execPath, [
      '-e',
      "process.kill(process.pid,'SIGTERM')",
    ], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 1_000,
    }),
    (error) => error.signal === 'SIGTERM'
      && error.exitCode === null
      && error.cause?.signal === 'SIGTERM'
      && /signal SIGTERM \(exit code null\)/.test(error.message),
  )
})

test('command timeout kills the complete owned process group, including an ignored-SIGTERM descendant', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-command-tree-timeout-'))
  const identityFile = join(root, 'identity.json')
  const descendant = [
    "const fs=require('node:fs');const net=require('node:net');",
    'const server=net.createServer();',
    "server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],",
    'JSON.stringify({pid:process.pid,port:server.address().port})));',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ].join('')
  const parent = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'ignore'});`,
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ].join('')
  try {
    await assert.rejects(
      runCommand(process.execPath, ['-e', parent, identityFile], {
        cwd: root,
        env: process.env,
        timeoutMs: FIXTURE_COMMAND_TIMEOUT_MS,
        terminationGraceMs: 50,
      }),
      new RegExp(`timed out after ${FIXTURE_COMMAND_TIMEOUT_MS}ms`),
    )
    const descendantIdentity = JSON.parse(await readFile(identityFile, 'utf8'))
    await assertProcessReapedWithClosedPort(descendantIdentity.pid, descendantIdentity.port)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bounded fetch aborts a listener that accepts HTTP but never responds', async () => {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  try {
    await assert.rejects(
      fetchWithTimeout(`http://127.0.0.1:${address.port}/`, 50, 'stall fixture'),
      /stall fixture timed out after 50ms/,
    )
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('cleanup health proof does not mistake malformed JSON for a closed listener', async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('not-json')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  try {
    await assert.rejects(
      waitForHealth(address.port, false, {
        overallTimeoutMs: 100,
        requestTimeoutMs: 50,
      }),
      /still owns or accepts port/,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// A fetch stand-in that never touches a socket: each scripted step answers from microtasks (an HTTP status,
// a thrown error) or hangs until the request's own abort timer fires. Nothing here races a real connection,
// so the outcomes waitForHealth sees are exactly the script, whatever the machine load.
function scriptedHealthFetch(t, steps) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const step = steps[Math.min(calls.length, steps.length - 1)]
    calls.push({ url: String(url), at: Date.now(), step })
    if (typeof step === 'number') {
      return new Response('answer', { status: step, headers: { 'content-type': 'text/plain' } })
    }
    if (step === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    throw step
  })
  return calls
}

test('non-success health responses preserve HTTP status as the timeout cause', async (t) => {
  // The answer is served by a fetch that settles from microtasks: no abort timer, however short or late,
  // can fire before it resolves, so the only thing asserted is how a non-ok answer is recorded. The
  // real-socket variant below runs the same scenario over a loopback listener.
  const port = 4_242
  const calls = scriptedHealthFetch(t, [503])
  await assert.rejects(
    waitForHealth(port, true, {
      overallTimeoutMs: 250,
      requestTimeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, new RegExp(`Dashboard did not become healthy on port ${port}`))
      assert.equal(error.cause?.message, `Dashboard health on port ${port} returned HTTP 503`)
      return true
    },
  )
  assert.ok(calls.length >= 1)
  assert.deepEqual([...new Set(calls.map((call) => call.url))], [`http://127.0.0.1:${port}/api/health`])
})

test('non-success health responses preserve HTTP status as the timeout cause over a real socket', async () => {
  // The last attempt only gets the time left before the overall deadline, so it can lose to its own abort
  // timer. That timeout must not replace the HTTP status the earlier attempts really saw.
  const server = createHttpServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' })
    response.end('temporarily unavailable')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  try {
    await assert.rejects(
      waitForHealth(address.port, true, {
        overallTimeoutMs: 400,
        requestTimeoutMs: 200,
      }),
      (error) => {
        assert.match(error.message, new RegExp(`Dashboard did not become healthy on port ${address.port}`))
        assert.equal(
          error.cause?.message,
          `Dashboard health on port ${address.port} returned HTTP 503`,
        )
        return true
      },
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a late timeout does not replace the HTTP status the earlier attempts saw', async (t) => {
  const port = 4_243
  const calls = scriptedHealthFetch(t, [503, 503, 'hang'])
  await assert.rejects(
    waitForHealth(port, true, {
      overallTimeoutMs: 400,
      requestTimeoutMs: 40,
      pollIntervalMs: 5,
    }),
    (error) => {
      assert.equal(error.cause?.message, `Dashboard health on port ${port} returned HTTP 503`)
      assert.match(error.message, /returned HTTP 503/)
      return true
    },
  )
  // At least one attempt really timed out after the 503s, or the test proves nothing.
  assert.ok(calls.filter((call) => call.step === 'hang').length >= 1)
})

test('the most recent non-timeout cause wins over an older one and over later timeouts', async (t) => {
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4244'), { code: 'ECONNREFUSED' }),
  })
  const calls = scriptedHealthFetch(t, [503, refused, 'hang'])
  await assert.rejects(
    waitForHealth(4_244, true, {
      overallTimeoutMs: 400,
      requestTimeoutMs: 40,
      pollIntervalMs: 5,
    }),
    (error) => {
      assert.equal(error.cause, refused)
      return true
    },
  )
  assert.ok(calls.filter((call) => call.step === 'hang').length >= 1)
})

test('health that only ever times out still reports the timeout as the cause', async (t) => {
  scriptedHealthFetch(t, ['hang'])
  await assert.rejects(
    waitForHealth(4_245, true, {
      overallTimeoutMs: 300,
      requestTimeoutMs: 60,
      pollIntervalMs: 5,
    }),
    (error) => {
      assert.ok(error.cause instanceof FetchTimeoutError)
      assert.match(error.cause.message, /Dashboard health on port 4245 timed out after \d+ms/)
      return true
    },
  )
})

test('a wait for the listener to disappear keeps the non-timeout cause over a late timeout', async (t) => {
  const port = 4_246
  const calls = scriptedHealthFetch(t, [503, 'hang'])
  await assert.rejects(
    waitForHealth(port, false, {
      overallTimeoutMs: 300,
      requestTimeoutMs: 40,
      pollIntervalMs: 5,
    }),
    (error) => {
      assert.match(error.message, new RegExp(`still owns or accepts port ${port}`))
      assert.equal(error.cause?.message, `Dashboard health on port ${port} returned HTTP 503`)
      return true
    },
  )
  assert.ok(calls.filter((call) => call.step === 'hang').length >= 1)
})

test('health polling starts no attempt with less than the floor left before the overall deadline', async (t) => {
  const overallTimeoutMs = 230
  const calls = scriptedHealthFetch(t, [503])
  const startedAt = Date.now()
  await assert.rejects(
    waitForHealth(4_247, true, { overallTimeoutMs, requestTimeoutMs: 1_000 }),
    /returned HTTP 503/,
  )
  assert.ok(calls.length >= 1)
  for (const call of calls) {
    // Two ms of slack for the clock read inside waitForHealth landing after this one.
    assert.ok(
      call.at - startedAt <= overallTimeoutMs - 50 + 2,
      `an attempt started ${call.at - startedAt}ms in, with under 50ms of ${overallTimeoutMs}ms left`,
    )
  }
  // Attempts land at about 0, 100 and 200 ms; the one at 200 ms has only 30 ms left and must not start.
  assert.ok(calls.length <= 2, `${calls.length} attempts started`)
})

test('a health budget shorter than the floor still gets its one attempt', async (t) => {
  const calls = scriptedHealthFetch(t, [503])
  await assert.rejects(
    waitForHealth(4_248, true, { overallTimeoutMs: 20, requestTimeoutMs: 1_000 }),
    (error) => /returned HTTP 503/.test(error.cause?.message ?? ''),
  )
  assert.equal(calls.length, 1)
})

test('a 200 with malformed JSON waits the normal poll interval instead of spinning', async () => {
  let requests = 0
  const server = createHttpServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('not-json')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const overallTimeoutMs = 450
  try {
    await assert.rejects(
      waitForHealth(address.port, true, { overallTimeoutMs, requestTimeoutMs: 200 }),
      (error) => {
        assert.match(error.cause?.message ?? '', /did not return valid JSON/)
        return true
      },
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  // One attempt per 100 ms poll interval, plus the first: a loop that skipped the interval answers
  // thousands of times in the same window on loopback.
  assert.ok(requests >= 1)
  assert.ok(requests <= overallTimeoutMs / 100 + 1, `${requests} requests in ${overallTimeoutMs}ms`)
})

test('public install URL accepts only a complete stable release tag', () => {
  assert.equal(
    publicInstallUrl('v1.2.3'),
    'https://raw.githubusercontent.com/jefferysha/tenon/v1.2.3/install.sh',
  )
  assert.throws(() => publicInstallUrl('main'), /invalid public install ref/)
  assert.throws(() => publicInstallUrl('0123456789abcdef0123456789abcdef01234567'), /invalid public install ref/)
  assert.throws(() => publicInstallUrl('v1.2.3-rc.1'), /invalid public install ref/)
  assert.throws(() => publicInstallUrl('../main'), /invalid public install ref/)
})

test('positive health timeout preserves the final connection error as cause', async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  await new Promise((resolve) => server.close(resolve))
  await assert.rejects(
    waitForHealth(address.port, true, {
      overallTimeoutMs: 100,
      requestTimeoutMs: 50,
    }),
    (error) => /did not become healthy/.test(error.message)
      && error.cause instanceof Error,
  )
})

test('verified Dashboard ownership is registered before a later HTML identity failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-dashboard-registration-'))
  const launcher = join(root, '.local', 'bin', 'tenon')
  const runtimeHome = join(root, 'runtime')
  const releaseId = `sha256-${'d'.repeat(64)}`
  const health = {
    ok: true,
    version: '1.0.2',
    releaseId,
    stateScopeId: `sha256-v1-${'e'.repeat(64)}`,
    transactionId: 'transaction-registration',
    pid: process.pid,
  }
  const server = createHttpServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(health))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<title>Wrong Product</title>')
  })
  try {
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(
      launcher,
      '#!/bin/sh\n'
        + 'if [ "$1" = "runtime" ]; then\n'
        + `  printf '%s\\n' '${JSON.stringify({
          activeValid: true,
          active: {
            version: 2,
            releaseId,
            payloadDigest: 'd'.repeat(64),
            source: { host: 'codex', pluginVersion: '1.0.2' },
            stableTarget: { version: '1.0.2', tag: 'v1.0.2', commit: 'c'.repeat(40) },
          },
          selection: { activeRelease: releaseId },
        })}'\n`
        + 'else\n'
        + "  printf '%s\\n' '{\"summary\":{\"red\":0}}'\n"
        + 'fi\n',
      'utf8',
    )
    await chmod(launcher, 0o755)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.notEqual(address, null)
    assert.equal(typeof address, 'object')
    let registered = null
    await assert.rejects(
      assertInstalledRuntime(
        { ...process.env, HOME: root, TENON_RUNTIME_HOME: runtimeHome },
        root,
        address.port,
        (current) => { registered = current },
      ),
      /Dashboard HTML is not the Tenon product/,
    )
    assert.deepEqual(registered, health)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A launcher + Dashboard pair that behaves like the real ones: `runtime`/`doctor` report a healthy install,
 * `dashboard --open` hands a one-time login link to the fake desktop opener (a file), and the server
 * answers anonymous callers with 401 unless `leaky` is set.
 */
async function signInFixture({ leaky = false, replayable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-dashboard-signin-'))
  const launcher = join(root, '.local', 'bin', 'tenon')
  const runtimeHome = join(root, 'runtime')
  const openedFile = join(root, 'opened-url.txt')
  const releaseId = `sha256-${'a'.repeat(64)}`
  const health = {
    ok: true, version: '1.0.3', releaseId, stateScopeId: `sha256-v1-${'b'.repeat(64)}`,
    transactionId: 'transaction-signin', pid: process.pid,
  }
  const page = '<!doctype html><title>Tenon Dashboard</title><script type="module" src="/assets/app.js"></script>'
  let used = false
  let port = 0
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const signedIn = (request.headers.cookie ?? '').includes('tenon_session=ok')
    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, { 'content-type': type, ...headers })
      response.end(body)
    }
    if (url.pathname === '/api/health') return send(200, 'application/json', JSON.stringify(health))
    if (url.pathname === '/assets/app.js') return send(200, 'text/javascript', 'tenon-dashboard-theme __TENON_DASHBOARD_TOKEN__')
    if (url.pathname === '/session/start') {
      if (used && !replayable) return send(403, 'text/html', 'used')
      used = true
      return send(303, 'text/plain', '', { location: '/', 'set-cookie': 'tenon_session=ok; HttpOnly; SameSite=Strict; Path=/' })
    }
    if (url.pathname === '/') {
      if (signedIn) return send(200, 'text/html', page)
      return leaky ? send(200, 'text/html', `${page}<script>window.__TENON_DASHBOARD_TOKEN__="x"</script>`) : send(401, 'text/html', '<title>Tenon Dashboard</title>sign in')
    }
    if (url.pathname === '/api/snapshot') return send(signedIn ? 200 : (leaky ? 200 : 401), 'application/json', '{}')
    return send(404, 'text/plain', '')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, [
    '#!/bin/sh',
    'case "$1" in',
    `  runtime) printf '%s\\n' '${JSON.stringify({
      activeValid: true,
      active: {
        version: 2, releaseId, payloadDigest: 'd'.repeat(64), source: { host: 'codex', pluginVersion: '1.0.3' },
        stableTarget: { version: '1.0.3', tag: 'v1.0.3', commit: 'c'.repeat(40) },
      },
      selection: { activeRelease: releaseId },
    })}' ;;`,
    `  dashboard) printf '%s\\n' "http://127.0.0.1:${port}/session/start?code=one-time-code" >> "$TENON_ACCEPTANCE_OPENED_URL" ;;`,
    `  *) printf '%s\\n' '{"summary":{"red":0}}' ;;`,
    'esac',
    '',
  ].join('\n'), 'utf8')
  await chmod(launcher, 0o755)
  const env = { ...process.env, HOME: root, TENON_RUNTIME_HOME: runtimeHome, TENON_ACCEPTANCE_OPENED_URL: openedFile }
  return {
    root, port, env, openedFile,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('Dashboard acceptance signs in the supported way: anonymous 401, one-time link, cookie, then the SPA', async () => {
  const fixture = await signInFixture()
  try {
    let registered = null
    const result = await assertInstalledRuntime(fixture.env, fixture.root, fixture.port, (health) => { registered = health })
    assert.equal(result.health.pid, process.pid)
    assert.notEqual(registered, null)
    assert.match(await readFile(fixture.openedFile, 'utf8'), /\/session\/start\?code=one-time-code/u)
  } finally {
    await fixture.close()
  }
})

test('Dashboard acceptance fails when an anonymous caller is given the page, the write token or data', async () => {
  const fixture = await signInFixture({ leaky: true })
  try {
    await assert.rejects(
      assertInstalledRuntime(fixture.env, fixture.root, fixture.port, () => {}),
      /served its page or write token to an unauthenticated caller/u,
    )
  } finally {
    await fixture.close()
  }
})

test('Dashboard acceptance fails when a login link can be used twice', async () => {
  const fixture = await signInFixture({ replayable: true })
  try {
    await assert.rejects(
      assertInstalledRuntime(fixture.env, fixture.root, fixture.port, () => {}),
      /can be used twice/u,
    )
  } finally {
    await fixture.close()
  }
})

test('Dashboard acceptance fails when `tenon dashboard --open` hands the browser nothing', async () => {
  const fixture = await signInFixture()
  try {
    const launcher = join(fixture.root, '.local', 'bin', 'tenon')
    const original = await readFile(launcher, 'utf8')
    await writeFile(launcher, original.replace(/  dashboard\) .*;;\n/u, '  dashboard) : ;;\n'), 'utf8')
    await assert.rejects(
      assertInstalledRuntime(fixture.env, fixture.root, fixture.port, () => {}),
      /did not hand a one-time login link to the browser opener/u,
    )
  } finally {
    await fixture.close()
  }
})

test('failure cleanup discovers and stops an isolated Dashboard before ownership registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-dashboard-late-cleanup-'))
  const runtimeHome = join(root, 'runtime')
  const releaseId = `sha256-${'f'.repeat(64)}`
  const releaseRoot = join(runtimeHome, 'data', 'releases', releaseId)
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const port = address.port
  await new Promise((resolve) => probe.close(resolve))
  const env = { ...process.env, TENON_RUNTIME_HOME: runtimeHome }
  const stateScopeId = isolatedAcceptanceStateScopeId(env)
  await mkdir(releaseRoot, { recursive: true })
  await writeFile(join(releaseRoot, 'release.json'), JSON.stringify({
    version: 1,
    releaseId,
    source: { host: 'codex', pluginVersion: '1.0.2' },
  }))
  const serverSource = [
    "const http = require('node:http')",
    "const health = JSON.parse(process.env.HEALTH)",
    "health.pid = process.pid",
    "http.createServer((req, res) => {",
    "res.writeHead(200, {'content-type':'application/json'})",
    "res.end(JSON.stringify(health))",
    `}).listen(${port}, '127.0.0.1')`,
  ].join(';')
  const child = spawn(process.execPath, ['-e', serverSource], {
    env: {
      ...process.env,
      HEALTH: JSON.stringify({
        ok: true,
        version: '1.0.2',
        releaseId,
        stateScopeId,
        transactionId: 'transaction-late-cleanup',
      }),
    },
    stdio: 'ignore',
  })
  try {
    const health = await waitForHealth(port)
    assert.equal(health.pid, child.pid)
    const recovered = await cleanupIsolatedDashboardAfterFailure(env, port, null)
    assert.deepEqual(recovered, health)
    await assertProcessReapedWithClosedPort(child.pid, port)
  } finally {
    try { process.kill(child.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex discovery uses newline-delimited RPC framing and validates the complete response', async () => {
  const server = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line',(line)=>{const request=JSON.parse(line);if(request.id===undefined)return;",
    "let result={};",
    "if(request.method==='plugin/installed')result={marketplaces:[{plugins:[{id:'tenon@tenon',enabled:true}]}]};",
    "if(request.method==='skills/list')result={data:[{skills:[{name:'tenon:tenon',enabled:true}]}]};",
    "if(request.method==='hooks/list')result={data:[{hooks:['sessionStart','userPromptSubmit','preToolUse','postToolUse'].map(eventName=>({pluginId:'tenon@tenon',eventName,trustStatus:'untrusted'}))}]};",
    "process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');",
    "});",
  ].join('')
  await assert.doesNotReject(runCodexDiscovery(process.env, process.cwd(), {
    command: process.execPath,
    args: ['-e', server],
    timeoutMs: 1_000,
    terminationGraceMs: 50,
  }))
})

test('Codex discovery fails closed on malformed JSON and closes the child', async () => {
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: ['-e', "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000)"],
      timeoutMs: 1_000,
      terminationGraceMs: 50,
    }),
    (error) => /malformed JSON/.test(error.message)
      && error.cause?.cause instanceof SyntaxError,
  )
})

test('Codex discovery fails closed when the app-server never answers', async () => {
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
      terminationGraceMs: 25,
    }),
    /discovery timed out after 50ms/,
  )
})

test('Codex discovery fails closed on an unexpected response id', async () => {
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write(JSON.stringify({id:999,result:{}})+'\\n');"
          + 'setInterval(() => {}, 1000)',
      ],
      timeoutMs: 1_000,
      terminationGraceMs: 25,
    }),
    /unexpected response id: 999/,
  )
})

test('Codex discovery fails closed on a non-object JSON message', async () => {
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: ['-e', "process.stdout.write('null\\n'); setInterval(() => {}, 1000)"],
      timeoutMs: 1_000,
      terminationGraceMs: 50,
    }),
    /non-object JSON/,
  )
})

test('Codex discovery cannot pass when malformed JSON follows the final expected response', async () => {
  const server = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line',(line)=>{const request=JSON.parse(line);if(request.id===undefined)return;",
    "let result={};",
    "if(request.method==='plugin/installed')result={marketplaces:[{plugins:[{id:'tenon@tenon',enabled:true}]}]};",
    "if(request.method==='skills/list')result={data:[{skills:[{name:'tenon:tenon',enabled:true}]}]};",
    "if(request.method==='hooks/list')result={data:[{hooks:['sessionStart','userPromptSubmit','preToolUse','postToolUse'].map(eventName=>({pluginId:'tenon@tenon',eventName,trustStatus:'untrusted'}))}]};",
    "process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');",
    "if(request.method==='hooks/list')process.stdout.write('not-json\\n');",
    '});',
  ].join('')
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: ['-e', server],
      timeoutMs: 1_000,
      terminationGraceMs: 50,
    }),
    /malformed JSON/,
  )
})

test('Codex discovery cannot pass when the app-server exits nonzero after all responses', async () => {
  const server = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line',(line)=>{const request=JSON.parse(line);if(request.id===undefined)return;",
    "let result={};",
    "if(request.method==='plugin/installed')result={marketplaces:[{plugins:[{id:'tenon@tenon',enabled:true}]}]};",
    "if(request.method==='skills/list')result={data:[{skills:[{name:'tenon:tenon',enabled:true}]}]};",
    "if(request.method==='hooks/list')result={data:[{hooks:['sessionStart','userPromptSubmit','preToolUse','postToolUse'].map(eventName=>({pluginId:'tenon@tenon',eventName,trustStatus:'untrusted'}))}]};",
    "process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');",
    '});',
    "rl.on('close',()=>process.exit(9));",
  ].join('')
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: ['-e', server],
      timeoutMs: 1_000,
      terminationGraceMs: 25,
    }),
    /exited unsuccessfully after discovery \(code=9/,
  )
})

test('Codex discovery rejects all pending RPCs when the child exits', async () => {
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 1_000,
      terminationGraceMs: 50,
    }),
    /exited before completing discovery/,
  )
})

test('Codex discovery rejects a spawn error without leaving a pending RPC', async () => {
  await assert.rejects(
    runCodexDiscovery(process.env, process.cwd(), {
      command: join(tmpdir(), 'tenon-command-that-does-not-exist'),
      args: [],
      timeoutMs: 1_000,
      terminationGraceMs: 50,
    }),
    /ENOENT/,
  )
})

test('external-state snapshot detects Tenon mutations without reading credential contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-external-snapshot-'))
  const home = join(root, 'home')
  const codexHome = join(root, 'codex')
  const runtimeHome = join(root, 'runtime')
  const pluginRoot = join(codexHome, 'plugins', 'cache', 'tenon')
  const configRoot = join(runtimeHome, 'config')
  const secretPath = join(configRoot, 'secrets.json')
  const stateRoot = join(runtimeHome, 'state')
  const dashboardTokenPath = join(stateRoot, 'dashboard-token.json')
  const auditPath = join(stateRoot, 'audit.jsonl')
  try {
    await Promise.all([
      mkdir(pluginRoot, { recursive: true }),
      mkdir(configRoot, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
      mkdir(join(home, '.local', 'bin'), { recursive: true }),
    ])
    await writeFile(join(pluginRoot, 'plugin.json'), '{"name":"tenon"}', 'utf8')
    await writeFile(secretPath, 'credential-must-not-be-read', 'utf8')
    await writeFile(dashboardTokenPath, 'dashboard-token-must-not-be-read', 'utf8')
    await writeFile(auditPath, 'real-user-event-must-not-be-read', 'utf8')
    await Promise.all([
      chmod(secretPath, 0o000),
      chmod(dashboardTokenPath, 0o000),
      chmod(auditPath, 0o000),
    ])
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      TENON_RUNTIME_HOME: runtimeHome,
    }
    const before = await snapshotExternalTenonState(env, {
      includeDefaultDashboard: false,
    })
    await writeFile(join(pluginRoot, 'plugin.json'), '{"name":"changed"}', 'utf8')
    const after = await snapshotExternalTenonState(env, {
      includeDefaultDashboard: false,
    })
    assert.throws(
      () => assertExternalStateUnchanged(before, after),
      /real user Tenon state changed/,
    )
  } finally {
    await Promise.all([
      chmod(secretPath, 0o600).catch(() => {}),
      chmod(dashboardTokenPath, 0o600).catch(() => {}),
      chmod(auditPath, 0o600).catch(() => {}),
    ])
    await rm(root, { recursive: true, force: true })
  }
})

test('a live default Dashboard listener is unverifiable without process identity', () => {
  assert.throws(
    () => assertListenerIdentityProvable(true, null),
    /lsof is required/,
  )
  assert.throws(
    () => assertListenerIdentityProvable(true, []),
    /lsof is required/,
  )
  assert.doesNotThrow(() => assertListenerIdentityProvable(false, null))
  assert.doesNotThrow(() => assertListenerIdentityProvable(true, ['1234']))
})

test('clean-install acceptance declares its POSIX process-ownership boundary', () => {
  assert.throws(
    () => assertSupportedAcceptancePlatform('win32'),
    /Windows is unsupported/,
  )
  assert.doesNotThrow(() => assertSupportedAcceptancePlatform('darwin'))
  assert.doesNotThrow(() => assertSupportedAcceptancePlatform('linux'))
})
