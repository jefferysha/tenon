#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export function publicInstallUrl(ref) {
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(ref)) {
    throw new Error(`invalid public install ref: ${ref}`)
  }
  return `https://raw.githubusercontent.com/jefferysha/tenon/${ref}/install.sh`
}

export function assertCodexAuthGuidance(output, label = 'install output') {
  const exactCommands = [
    'codex login',
    'codex login --device-auth',
    'printenv OPENAI_API_KEY | codex login --with-api-key',
    'codex login status',
  ]
  for (const expected of exactCommands) {
    const present = output.split(/\r?\n/u).some((line) => {
      const trimmed = line.trim()
      return trimmed === expected || trimmed.includes(`\`${expected}\``)
    })
    if (!present) throw new Error(`${label} is missing ${expected}`)
  }
  const apiKeysUrl = 'https://platform.openai.com/api-keys'
  if (!output.includes(apiKeysUrl)) {
    throw new Error(`${label} is missing ${apiKeysUrl}`)
  }
}
const REQUIRED_HOOK_EVENTS = new Set([
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
])
const DEFAULT_TERMINATION_GRACE_MS = 5_000
const DEFAULT_HTTP_TIMEOUT_MS = 2_000

function signalOwnedProcessTree(child, signal) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
    }
  }
  return child.kill(signal)
}

export function dashboardIdentityMatches(expected, actual) {
  return expected !== null
    && actual !== null
    && expected.releaseId === actual.releaseId
    && expected.transactionId === actual.transactionId
    && expected.stateScopeId === actual.stateScopeId
    && expected.pid === actual.pid
}

export function assertSameDashboardIdentity(expected, actual) {
  if (!dashboardIdentityMatches(expected, actual)) {
    throw new Error('Dashboard identity changed across the repeated installation')
  }
}

export function preserveOwnedDashboardIdentity(current, candidate) {
  if (current === null) return candidate
  assertSameDashboardIdentity(current, candidate)
  return current
}

export function requireJsonObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a non-null JSON object`)
  }
  return value
}

export function assertDashboardHealthIdentity(health, activeRelease, expectedVersion) {
  requireJsonObject(health, 'Dashboard health')
  if (health.ok !== true
    || health.releaseId !== activeRelease
    || health.version !== expectedVersion
    || typeof health.stateScopeId !== 'string'
    || !/^sha256-v1-[a-f0-9]{64}$/.test(health.stateScopeId)
    || typeof health.transactionId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(health.transactionId)
    || !Number.isSafeInteger(health.pid)
    || health.pid <= 0) {
    throw new Error('Dashboard health identity does not match the active managed release')
  }
}

export function isolatedAcceptanceStateScopeId(env) {
  let stateRoot
  if (typeof env.TENON_RUNTIME_ROOTS === 'string') {
    const roots = requireJsonObject(parseJson(env.TENON_RUNTIME_ROOTS, 'TENON_RUNTIME_ROOTS'), 'TENON_RUNTIME_ROOTS')
    stateRoot = roots.stateRoot
  } else if (typeof env.TENON_RUNTIME_HOME === 'string') {
    stateRoot = join(env.TENON_RUNTIME_HOME, 'state')
  }
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) {
    throw new Error('isolated Dashboard cleanup requires an absolute Tenon state root')
  }
  const digest = createHash('sha256')
    .update('tenon:machine-state-scope:v1\0')
    .update(resolve(stateRoot))
    .digest('hex')
  return `sha256-v1-${digest}`
}

export function assertCodexDiscovery(discovery) {
  const plugins = discovery.pluginInstalled?.marketplaces
    ?.flatMap((marketplace) => marketplace.plugins ?? []) ?? []
  const plugin = plugins.find((item) => item.id === 'tenon@tenon')
  if (plugin?.enabled !== true) throw new Error('Codex did not discover enabled tenon@tenon')

  const skills = discovery.skills?.data?.flatMap((item) => item.skills ?? []) ?? []
  const entry = skills.find((item) => item.name === 'tenon:tenon')
  if (entry === undefined || entry.enabled === false) {
    throw new Error('Codex did not discover enabled tenon:tenon')
  }

  const hooks = (discovery.hooks?.data?.flatMap((item) => item.hooks ?? []) ?? [])
    .filter((item) => item.pluginId === 'tenon@tenon')
  const events = new Set(hooks.map((item) => item.eventName))
  for (const event of REQUIRED_HOOK_EVENTS) {
    if (!events.has(event)) throw new Error(`missing Tenon hook event: ${event}`)
  }
  if (hooks.some((item) => item.trustStatus !== 'untrusted')) {
    throw new Error('Tenon hook trust boundary was changed by acceptance')
  }
}

export async function runCommand(command, args, options) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let processError = null
    let escalationTimer
    let finalTimer
    let settled = false
    const clearTimers = () => {
      clearTimeout(timer)
      clearTimeout(escalationTimer)
      clearTimeout(finalTimer)
    }
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimers()
      if (error === null) resolveResult(value)
      else reject(error)
    }
    const terminate = () => {
      signalOwnedProcessTree(child, 'SIGTERM')
      escalationTimer = setTimeout(() => {
        signalOwnedProcessTree(child, 'SIGKILL')
        finalTimer = setTimeout(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          settle(new Error(`${command} timed out after ${options.timeoutMs}ms`))
        }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS)
      }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      processError = error
      if (child.pid === undefined) {
        settle(error)
        return
      }
      if (escalationTimer === undefined) terminate()
    })
    child.once('close', (code, signal) => {
      if (timedOut) {
        settle(new Error(`${command} timed out after ${options.timeoutMs}ms`))
      } else if (processError !== null) {
        settle(processError)
      } else {
        settle(null, { code, signal, stdout, stderr })
      }
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
  if (options.allowFailure !== true && result.code !== 0) {
    throw commandResultError(`${command} ${args.join(' ')} failed`, result)
  }
  return result
}

export function commandResultError(message, result) {
  const termination = result.signal === null
    ? `exit code ${String(result.code)}`
    : `signal ${result.signal} (exit code ${String(result.code)})`
  const detail = result.stderr.trim() || result.stdout.trim()
  const failure = new Error(
    `${message} via ${termination}${detail === '' ? '' : `: ${detail}`}`,
    { cause: result },
  )
  failure.exitCode = result.code
  failure.signal = result.signal
  return failure
}

export function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} did not return valid JSON`, { cause: error })
  }
}

function installedTenonRoot(inventory) {
  const rows = Array.isArray(inventory?.installed) ? inventory.installed : []
  const item = rows.find((entry) =>
    entry?.id === 'tenon@tenon'
    || entry?.pluginId === 'tenon@tenon'
    || (entry?.name === 'tenon' && entry?.marketplaceName === 'tenon'))
  return typeof item?.source?.path === 'string' ? item.source.path : null
}

export function hasExactLocalTenonMarketplace(inventory, repoRoot) {
  requireJsonObject(inventory, 'codex marketplace inventory')
  if (!Array.isArray(inventory.marketplaces)) {
    throw new Error('codex marketplace inventory is missing marketplaces')
  }
  const tenonRows = inventory.marketplaces.filter((item) => item?.name === 'tenon')
  if (tenonRows.length === 0) return false
  if (tenonRows.length !== 1) {
    throw new Error('codex marketplace inventory has duplicate tenon registrations')
  }
  const marketplace = tenonRows[0]
  if (marketplace?.marketplaceSource?.sourceType !== 'local'
    || marketplace.marketplaceSource.source !== repoRoot) {
    throw new Error('codex marketplace inventory has a conflicting tenon registration')
  }
  return true
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('unable to allocate an isolated Dashboard port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

export async function fetchWithTimeout(
  url,
  timeoutMs,
  label,
  readBody = async (response) => response.text(),
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await readBody(response)
    return { response, body }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function connectionWasRefused(error) {
  let current = error
  while (current !== null && typeof current === 'object') {
    if (current.code === 'ECONNREFUSED') return true
    current = current.cause
  }
  return false
}

export async function waitForHealth(port, expectedPresent = true, options = {}) {
  const overallTimeoutMs = options.overallTimeoutMs ?? 15_000
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const deadline = Date.now() + overallTimeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now())
      const { response, body } = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/health`,
        Math.min(requestTimeoutMs, remaining),
        `Dashboard health on port ${port}`,
      )
      if (response.ok) {
        let health
        try {
          health = parseJson(body, `Dashboard health on port ${port}`)
        } catch (error) {
          lastError = error
          continue
        }
        if (expectedPresent) return health
      } else {
        lastError = new Error(
          `Dashboard health on port ${port} returned HTTP ${response.status}`,
        )
      }
    } catch (error) {
      lastError = error
      if (!expectedPresent && connectionWasRefused(error)) return null
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (!expectedPresent) {
    throw new Error(
      `Dashboard listener still owns or accepts port ${port} after cleanup: ${String(lastError ?? '')}`,
      { cause: lastError },
    )
  }
  throw new Error(
    `Dashboard did not become healthy on port ${port}: ${String(lastError ?? '')}`,
    { cause: lastError },
  )
}

async function terminateChild(child, closed, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed.catch(() => {})
    return
  }
  signalOwnedProcessTree(child, 'SIGTERM')
  const closedAfterTerm = await Promise.race([
    closed.then(() => true, () => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), graceMs)),
  ])
  if (!closedAfterTerm && child.exitCode === null && child.signalCode === null) {
    signalOwnedProcessTree(child, 'SIGKILL')
    const closedAfterKill = await Promise.race([
      closed.then(() => true, () => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), graceMs)),
    ])
    if (!closedAfterKill) {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
}

export async function runCodexDiscovery(env, cwd, options = {}) {
  const command = options.command ?? 'codex'
  const args = options.args ?? ['app-server', '--stdio', '--enable', 'plugins']
  const timeoutMs = options.timeoutMs ?? 15_000
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const pending = new Map()
  let stderr = ''
  let nextId = 1
  let fatalError = null
  let expectedResponsesComplete = false
  const failAll = (error) => {
    if (fatalError === null) fatalError = error
    for (const callback of pending.values()) callback.reject(fatalError)
    pending.clear()
  }
  const closed = new Promise((resolveClosed) => {
    child.once('close', (code, signal) => {
      if (!expectedResponsesComplete) {
        failAll(new Error(
          `Codex app-server exited before completing discovery (code=${String(code)}, signal=${String(signal)})`,
        ))
      }
      resolveClosed({ code, signal })
    })
  })
  child.once('error', (error) => {
    failAll(error)
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      failAll(new Error('Codex app-server returned malformed JSON', { cause: error }))
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      failAll(new Error('Codex app-server returned non-object JSON'))
      return
    }
    if (message.id === undefined) return
    const callback = pending.get(message.id)
    if (callback === undefined) {
      failAll(new Error(`Codex app-server returned an unexpected response id: ${String(message.id)}`))
      return
    }
    pending.delete(message.id)
    if (message.error !== undefined) callback.reject(new Error(JSON.stringify(message.error)))
    else callback.resolve(message.result)
  })
  const call = (method, params) => new Promise((resolveCall, reject) => {
    if (fatalError !== null) {
      reject(fatalError)
      return
    }
    const id = nextId++
    pending.set(id, { resolve: resolveCall, reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (error === null || error === undefined) return
      pending.delete(id)
      reject(error)
    })
  })
  const timer = setTimeout(() => {
    failAll(new Error(`Codex app-server discovery timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  try {
    await call('initialize', {
      clientInfo: { name: 'tenon-clean-install-acceptance', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    const [pluginInstalled, skills, hooks] = await Promise.all([
      call('plugin/installed', { cwds: [cwd] }),
      call('skills/list', { cwds: [cwd], forceReload: true }),
      call('hooks/list', { cwds: [cwd] }),
    ])
    const discovery = { pluginInstalled, skills, hooks }
    expectedResponsesComplete = true
    child.stdin.end()
    const protocolExit = await Promise.race([
      closed,
      new Promise((resolveDrain) => setTimeout(
        () => resolveDrain(null),
        options.gracefulShutdownMs ?? 1_000,
      )),
    ])
    if (protocolExit === null) {
      throw new Error('Codex app-server did not close after protocol EOF')
    }
    if (protocolExit.code !== 0 || protocolExit.signal !== null) {
      throw new Error(
        `Codex app-server exited unsuccessfully after discovery `
        + `(code=${String(protocolExit.code)}, signal=${String(protocolExit.signal)})`,
      )
    }
    if (fatalError !== null) throw fatalError
    assertCodexDiscovery(discovery)
    return discovery
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Codex app-server discovery failed: ${detail}; ${stderr.trim()}`,
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
    lines.close()
    child.stdin.end()
    await terminateChild(child, closed, terminationGraceMs)
  }
}

async function inventory(env, cwd) {
  const result = await runCommand('codex', ['plugin', 'list', '--json'], {
    cwd,
    env,
    timeoutMs: 30_000,
  })
  const parsed = parseJson(result.stdout, 'codex plugin list')
  if (installedTenonRoot(parsed) === null) throw new Error('tenon@tenon missing from Codex inventory')
  return parsed
}

async function installLocal(repoRoot, env, cwd, version) {
  return runCommand('bash', [join(repoRoot, 'install.sh'), '--codex', '--ref', `v${version}`], {
    cwd,
    env,
    timeoutMs: 180_000,
  })
}

const LOCAL_RELEASE_ENTRIES = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'adapters',
  'hooks',
  'packages/cli/dist/tenon.mjs',
  'packages/dashboard-app/dist',
  'packages/server/dist/dashboard.mjs',
  'runtime/tenon-bootstrap.mjs',
  'skills',
  'templates',
  'tools/verify-skills.sh',
]

async function createIsolatedReleaseRepository(repoRoot, fixture, env, version) {
  const releaseWork = join(fixture, 'release-work')
  const releaseBare = join(fixture, 'release.git')
  await mkdir(releaseWork)
  for (const entry of LOCAL_RELEASE_ENTRIES) {
    await cp(join(repoRoot, entry), join(releaseWork, entry), {
      recursive: true,
      preserveTimestamps: false,
    })
  }
  const git = (args) => runCommand('git', args, {
    cwd: releaseWork,
    env,
    timeoutMs: 60_000,
  })
  await git(['init', '--quiet'])
  await git(['config', 'user.name', 'Tenon clean-install acceptance'])
  await git(['config', 'user.email', 'acceptance@invalid.example'])
  await git(['add', '--all'])
  await git(['commit', '--quiet', '-m', `fixture v${version}`])
  // A lightweight tag makes the local GitHub ref fixture resolve directly to a commit object.
  await git(['tag', `v${version}`])
  const targetCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (!/^[a-f0-9]{40}$/u.test(targetCommit)) {
    throw new Error('acceptance release fixture did not produce a Git commit identity')
  }
  await git(['clone', '--quiet', '--bare', releaseWork, releaseBare])

  const rewriteKey = `url.file://${releaseBare}.insteadOf`
  await git(['config', '--global', 'protocol.file.allow', 'always'])
  await git(['config', '--global', '--add', rewriteKey, 'https://github.com/jefferysha/tenon.git'])
  await git(['config', '--global', '--add', rewriteKey, 'https://github.com/jefferysha/tenon'])

  const realGit = (await runCommand('which', ['git'], {
    cwd: releaseWork,
    env: process.env,
    timeoutMs: 10_000,
  })).stdout.trim()
  if (!isAbsolute(realGit)) throw new Error('acceptance could not resolve the real Git executable')
  const fixtureBin = join(env.HOME, '.local', 'bin')
  await mkdir(fixtureBin, { recursive: true })
  const gitWrapper = join(fixtureBin, 'git')
  await writeFile(
    gitWrapper,
    '#!/bin/sh\n'
      + 'if [ "$1" = "-C" ] && [ "$3" = "remote" ] && [ "$4" = "get-url" ] && [ "$5" = "origin" ]; then\n'
      + '  export GIT_CONFIG_GLOBAL=/dev/null\n'
      + `  exec ${JSON.stringify(realGit)} "$@"\n`
      + 'fi\n'
      + `exec ${JSON.stringify(realGit)} "$@"\n`,
    'utf8',
  )
  await chmod(gitWrapper, 0o755)

  const realCurl = (await runCommand('which', ['curl'], {
    cwd: releaseWork,
    env: process.env,
    timeoutMs: 10_000,
  })).stdout.trim()
  if (!isAbsolute(realCurl)) throw new Error('acceptance could not resolve the real curl executable')
  const curlWrapper = join(fixtureBin, 'curl')
  const tag = `v${version}`
  const releaseUrl = `https://api.github.com/repos/jefferysha/tenon/releases/tags/${tag}`
  const refUrl = `https://api.github.com/repos/jefferysha/tenon/git/ref/tags/${tag}`
  const releaseJson = JSON.stringify({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/jefferysha/tenon/releases/tag/${tag}`,
    published_at: '2026-08-09T00:00:00Z',
  })
  const refJson = JSON.stringify({
    ref: `refs/tags/${tag}`,
    object: { type: 'commit', sha: targetCommit },
  })
  await writeFile(
    curlWrapper,
    '#!/bin/sh\n'
      + 'url=""\nfor arg do url="$arg"; done\n'
      + `if [ "$url" = ${JSON.stringify(releaseUrl)} ]; then printf '%s\\n' ${JSON.stringify(releaseJson)}; exit 0; fi\n`
      + `if [ "$url" = ${JSON.stringify(refUrl)} ]; then printf '%s\\n' ${JSON.stringify(refJson)}; exit 0; fi\n`
      + `exec ${JSON.stringify(realCurl)} "$@"\n`,
    'utf8',
  )
  await chmod(curlWrapper, 0o755)
}

async function installPublic(env, cwd, ref) {
  const download = await runCommand('curl', ['-fsSL', publicInstallUrl(ref)], {
    cwd,
    env,
    timeoutMs: 60_000,
  })
  return runCommand('bash', ['-s', '--', '--codex', '--ref', ref], {
    cwd,
    env,
    input: download.stdout,
    timeoutMs: 180_000,
  })
}

export async function assertInstalledRuntime(
  env,
  cwd,
  port,
  registerOwnedHealth,
) {
  const launcher = join(env.HOME, '.local/bin/tenon')
  const runtime = requireJsonObject(parseJson((await runCommand(
    launcher,
    ['runtime', 'status', '--json'],
    { cwd, env, timeoutMs: 30_000 },
  )).stdout, 'tenon runtime status'), 'tenon runtime status')
  const active = requireJsonObject(runtime.active, 'tenon runtime status active release')
  const activeRelease = active.releaseId
  if (runtime.activeValid !== true
    || typeof activeRelease !== 'string'
    || activeRelease !== runtime.selection?.activeRelease
    || active.version !== 2
    || !/^sha256-[a-f0-9]{64}$/u.test(activeRelease)
    || typeof active.payloadDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(active.payloadDigest)
    || active.source?.host !== 'codex'
    || typeof active.source?.pluginVersion !== 'string'
    || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(active.source.pluginVersion)
    || active.stableTarget?.version !== active.source.pluginVersion
    || active.stableTarget?.tag !== `v${active.source.pluginVersion}`
    || typeof active.stableTarget?.commit !== 'string'
    || !/^[a-f0-9]{40}$/u.test(active.stableTarget.commit)) {
    throw new Error('managed runtime is not active and verified')
  }
  const doctor = requireJsonObject(parseJson((await runCommand(
    launcher,
    ['doctor', '--json'],
    { cwd, env, timeoutMs: 120_000 },
  )).stdout, 'tenon doctor'), 'tenon doctor')
  if (doctor.summary?.red !== 0) throw new Error(`doctor reported ${doctor.summary?.red} red checks`)

  const health = await waitForHealth(port)
  assertDashboardHealthIdentity(health, activeRelease, active.source.pluginVersion)
  registerOwnedHealth(health)
  const dashboardUrl = `http://127.0.0.1:${port}/`
  const { response: htmlResponse, body: html } = await fetchWithTimeout(
    dashboardUrl,
    5_000,
    `Dashboard HTML on port ${port}`,
  )
  if (!htmlResponse.ok || !/<title>Tenon Dashboard<\/title>/.test(html)) {
    throw new Error('Dashboard HTML is not the Tenon product')
  }
  const moduleSource = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1]
  if (moduleSource === undefined) {
    throw new Error('Dashboard HTML is missing its product module')
  }
  const { response: moduleResponse, body: moduleBody } = await fetchWithTimeout(
    new URL(moduleSource, dashboardUrl),
    5_000,
    `Dashboard product module on port ${port}`,
  )
  // Identity markers that the product module owns: its persisted theme key and the injected
  // Dashboard token global. Onboarding copy is not identity and changes with the UI.
  if (
    !moduleResponse.ok
    || !moduleBody.includes('tenon-dashboard-theme')
    || !moduleBody.includes('__TENON_DASHBOARD_TOKEN__')
  ) {
    throw new Error('Dashboard rendered content does not identify the Tenon product')
  }
  return { runtime, activeRelease, doctor, health }
}

async function stopOwnedDashboard(port, expected) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 0) {
    throw new Error('cleanup ownership has an unsafe PID; refusing to signal Dashboard process')
  }
  const current = await waitForHealth(port)
  if (!dashboardIdentityMatches(expected, current)) {
    throw new Error('cleanup ownership is unknown; refusing to signal Dashboard process')
  }
  process.kill(expected.pid, 'SIGTERM')
  await waitForHealth(port, false)
}

async function recoverIsolatedDashboardOwnership(env, port) {
  if (!await portAcceptsConnections(port)) return null
  const health = await waitForHealth(port, true, {
    overallTimeoutMs: 2_000,
    requestTimeoutMs: 500,
  })
  if (health?.stateScopeId !== isolatedAcceptanceStateScopeId(env)) {
    throw new Error('isolated Dashboard cleanup refused a listener from another state scope')
  }
  const runtimeHome = env.TENON_RUNTIME_HOME
  if (typeof runtimeHome !== 'string' || !isAbsolute(runtimeHome)) {
    throw new Error('isolated Dashboard cleanup requires TENON_RUNTIME_HOME')
  }
  if (typeof health.releaseId !== 'string') {
    throw new Error('isolated Dashboard cleanup health is missing release identity')
  }
  const manifest = requireJsonObject(parseJson(await readFile(
    join(runtimeHome, 'data', 'releases', health.releaseId, 'release.json'),
    'utf8',
  ), 'cleanup runtime release manifest'), 'cleanup runtime release manifest')
  if (manifest.releaseId !== health.releaseId
    || typeof manifest.source?.pluginVersion !== 'string') {
    throw new Error('isolated Dashboard cleanup release manifest does not match health')
  }
  assertDashboardHealthIdentity(health, health.releaseId, manifest.source.pluginVersion)
  return health
}

export async function cleanupIsolatedDashboardAfterFailure(env, port, ownedHealth) {
  const expected = ownedHealth ?? await recoverIsolatedDashboardOwnership(env, port)
  if (expected === null) return null
  await stopOwnedDashboard(port, expected)
  return expected
}

function pathIsWithin(candidate, root) {
  const remainder = relative(root, candidate)
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..')
}

function resolveExternalStateScope(env) {
  const home = env.HOME
  if (typeof home !== 'string' || home === '' || !isAbsolute(home)) {
    throw new Error('real HOME must be an absolute path for external-state proof')
  }
  const codexHome = env.CODEX_HOME ?? join(home, '.codex')
  if (!isAbsolute(codexHome)) {
    throw new Error('real CODEX_HOME must be absolute for external-state proof')
  }

  let runtimeRoots
  if (env.TENON_RUNTIME_ROOTS !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(env.TENON_RUNTIME_ROOTS)
    } catch (error) {
      throw new Error('real TENON_RUNTIME_ROOTS is malformed', { cause: error })
    }
    runtimeRoots = [parsed?.dataRoot, parsed?.stateRoot, parsed?.configRoot]
    if (runtimeRoots.some((item) => typeof item !== 'string' || !isAbsolute(item))) {
      throw new Error('real TENON_RUNTIME_ROOTS does not contain absolute product roots')
    }
  } else if (env.TENON_RUNTIME_HOME !== undefined) {
    if (!isAbsolute(env.TENON_RUNTIME_HOME)) {
      throw new Error('real TENON_RUNTIME_HOME must be absolute for external-state proof')
    }
    runtimeRoots = ['data', 'state', 'config'].map((name) => join(env.TENON_RUNTIME_HOME, name))
  } else if (process.platform === 'darwin') {
    const root = join(home, 'Library', 'Application Support', 'tenon')
    runtimeRoots = [root]
  } else if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    runtimeRoots = [join(local, 'tenon'), join(roaming, 'tenon')]
  } else {
    runtimeRoots = [
      join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'tenon'),
      join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'tenon'),
      join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'tenon'),
    ]
  }

  const pluginRoot = join(codexHome, 'plugins')
  const contentRoots = [
    join(pluginRoot, 'cache', 'tenon'),
    join(pluginRoot, 'marketplaces', 'tenon'),
    join(home, '.local', 'bin', 'tenon'),
    join(home, '.local', 'bin', 'tenon-hook'),
  ]
  const sensitivePaths = new Set([
    join(codexHome, 'auth.json'),
    ...runtimeRoots.map((root) => join(root, 'secrets.json')),
    ...runtimeRoots.map((root) => join(root, 'config', 'secrets.json')),
    ...runtimeRoots.map((root) => join(root, 'dashboard-token.json')),
    ...runtimeRoots.map((root) => join(root, 'state', 'dashboard-token.json')),
  ])
  return {
    roots: [
      pluginRoot,
      join(codexHome, 'config.toml'),
      join(codexHome, 'auth.json'),
      join(home, '.local', 'bin', 'tenon'),
      join(home, '.local', 'bin', 'tenon-hook'),
      ...runtimeRoots,
    ],
    contentRoots,
    sensitivePaths,
  }
}

async function fingerprintPath(path, label, scope, rows) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      rows.push({ path: label, type: 'missing' })
      return
    }
    throw error
  }
  const common = {
    path: label,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
  }
  const contentOwned = scope.contentRoots.some((root) => pathIsWithin(path, root))
  if (stats.isSymbolicLink()) {
    rows.push({
      ...common,
      type: 'symlink',
      ...(contentOwned ? { target: await readlink(path) } : { target: 'not-read' }),
    })
    return
  }
  if (stats.isDirectory()) {
    rows.push({ ...common, type: 'directory' })
    const names = (await readdir(path)).sort()
    for (const name of names) {
      await fingerprintPath(join(path, name), `${label}/${name}`, scope, rows)
    }
    return
  }
  if (!stats.isFile()) {
    rows.push({ ...common, type: 'other' })
    return
  }
  const sensitive = scope.sensitivePaths.has(path)
  rows.push({
    ...common,
    type: 'file',
    ...(contentOwned && !sensitive
      ? { sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
      : { content: 'not-read' }),
  })
}

async function portAcceptsConnections(port) {
  return await new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (open) => {
      socket.destroy()
      resolveOpen(open)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function snapshotDefaultDashboard() {
  let listenerPids = null
  try {
    const lsof = await runCommand(
      'lsof',
      ['-nP', '-t', '-iTCP:18765', '-sTCP:LISTEN'],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 2_000,
        terminationGraceMs: 250,
        allowFailure: true,
      },
    )
    if (lsof.code !== 0 && lsof.code !== 1) {
      throw commandResultError(
        'lsof failed while proving port 18765 ownership',
        lsof,
      )
    }
    listenerPids = lsof.stdout.trim() === ''
      ? []
      : [...new Set(lsof.stdout.trim().split(/\s+/))].sort()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const acceptsConnections = await portAcceptsConnections(18_765)
  assertListenerIdentityProvable(acceptsConnections, listenerPids)
  return {
    port: 18_765,
    listenerPids,
    acceptsConnections,
  }
}

export function assertListenerIdentityProvable(acceptsConnections, listenerPids) {
  if (
    acceptsConnections
    && (!Array.isArray(listenerPids) || listenerPids.length === 0)
  ) {
    throw new Error('lsof is required to prove the identity of the existing port 18765 listener')
  }
}

export async function snapshotExternalTenonState(env = process.env, options = {}) {
  const scope = resolveExternalStateScope(env)
  const rows = []
  for (const [index, root] of [...new Set(scope.roots)].entries()) {
    await fingerprintPath(root, `root-${index}`, scope, rows)
  }
  return {
    version: 1,
    files: rows,
    defaultDashboard: options.includeDefaultDashboard === false
      ? null
      : await snapshotDefaultDashboard(),
  }
}

export function assertExternalStateUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('real user Tenon state changed during isolated acceptance')
  }
}

export function assertSupportedAcceptancePlatform(platform = process.platform) {
  if (platform === 'win32') {
    throw new Error(
      'clean Codex install acceptance requires POSIX process groups and lsof; Windows is unsupported',
    )
  }
}

export async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const modeIndex = argv.indexOf('--mode')
  const mode = modeIndex === -1 ? 'local' : argv[modeIndex + 1]
  if (mode !== 'local' && mode !== 'public') {
    throw new Error('usage: clean-codex-install-acceptance.mjs --mode local|public')
  }
  const publicRefIndex = argv.indexOf('--public-ref')
  const packageVersion = requireJsonObject(
    JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')),
    'root package manifest',
  ).version
  if (typeof packageVersion !== 'string') throw new Error('root package version is invalid')
  const publicRef = publicRefIndex === -1 ? `v${packageVersion}` : argv[publicRefIndex + 1]
  if (typeof publicRef !== 'string' || publicRef === '') {
    throw new Error('--public-ref requires a value')
  }
  if (mode === 'public') publicInstallUrl(publicRef)
  assertSupportedAcceptancePlatform()
  const externalBefore = await snapshotExternalTenonState(process.env)
  let fixture = null
  let port = null
  let ownedHealth = null
  let cleanupComplete = false
  let externalStateUnchanged = false
  let installationStarted = false
  let successPayload = null
  try {
    fixture = await mkdtemp(join(tmpdir(), 'tenon-clean-install-'))
    const home = join(fixture, 'home')
    const codexHome = join(fixture, 'codex')
    const runtimeHome = join(fixture, 'runtime')
    const work = join(fixture, 'work')
    await Promise.all([mkdir(home), mkdir(codexHome), mkdir(runtimeHome), mkdir(work)])
    port = await reservePort()
    const inheritedPath = process.env.PATH
    if (inheritedPath === undefined) throw new Error('PATH is required for real Codex acceptance')
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      TENON_RUNTIME_HOME: runtimeHome,
      TENON_DASHBOARD_PORT: String(port),
      PATH: `${join(home, '.local/bin')}:${inheritedPath}`,
      LANG: process.env.LANG ?? 'C.UTF-8',
      CI: '1',
    }
    if (mode === 'local') {
      await createIsolatedReleaseRepository(repoRoot, fixture, env, packageVersion)
    }
    const install = mode === 'local'
      ? () => installLocal(repoRoot, env, work, packageVersion)
      : () => installPublic(env, work, publicRef)
    installationStarted = true
    const firstInstall = await install()
    assertCodexAuthGuidance(`${firstInstall.stdout}\n${firstInstall.stderr}`, 'first install output')
    try {
      await lstat(join(codexHome, 'auth.json'))
      throw new Error('first install created an unexpected Codex auth.json')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const registerOwnedHealth = (health) => {
      ownedHealth = preserveOwnedDashboardIdentity(ownedHealth, health)
    }
    const first = await assertInstalledRuntime(
      env,
      work,
      port,
      registerOwnedHealth,
    )
    await runCodexDiscovery(env, work)

    const secondInstall = await install()
    assertCodexAuthGuidance(`${secondInstall.stdout}\n${secondInstall.stderr}`, 'repeated install output')
    try {
      await lstat(join(codexHome, 'auth.json'))
      throw new Error('repeated install created an unexpected Codex auth.json')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const second = await assertInstalledRuntime(
      env,
      work,
      port,
      registerOwnedHealth,
    )
    assertSameDashboardIdentity(first.health, second.health)
    if (first.activeRelease !== second.activeRelease) {
      throw new Error('content-addressed release changed across identical installation')
    }
    await runCodexDiscovery(env, work)
    let final = second
    if (mode === 'public') {
      const launcher = join(home, '.local', 'bin', 'tenon')
      await runCommand(launcher, ['update', '--codex'], {
        cwd: work,
        env,
        timeoutMs: 180_000,
      })
      final = await assertInstalledRuntime(
        env,
        work,
        port,
        registerOwnedHealth,
      )
      assertSameDashboardIdentity(second.health, final.health)
      if (final.activeRelease !== second.activeRelease) {
        throw new Error('same-version public update changed the content-addressed release')
      }
      await runCodexDiscovery(env, work)
    }
    await stopOwnedDashboard(port, ownedHealth)
    cleanupComplete = true
    successPayload = {
      ok: true,
      mode,
      ...(mode === 'public' ? { publicRef } : {}),
      releaseId: final.activeRelease,
      dashboardPort: port,
      repeatedDashboardPid: second.health.pid,
      ...(mode === 'public' ? { updateDashboardPid: final.health.pid } : {}),
      hookTrust: 'untrusted',
    }
  } finally {
    if (!installationStarted && ownedHealth === null) cleanupComplete = true
    if (!cleanupComplete && port !== null && fixture !== null) {
      try {
        await cleanupIsolatedDashboardAfterFailure({
          TENON_RUNTIME_HOME: join(fixture, 'runtime'),
        }, port, ownedHealth)
        cleanupComplete = true
      } catch (error) {
        process.stderr.write(`[clean-install] ${error.message}\n`)
      }
    }
    let externalStateError = null
    try {
      const externalAfter = await snapshotExternalTenonState(process.env)
      assertExternalStateUnchanged(externalBefore, externalAfter)
      externalStateUnchanged = true
    } catch (error) {
      externalStateError = error
    }
    const safePrefix = join(tmpdir(), 'tenon-clean-install-')
    if (
      fixture !== null
      && cleanupComplete
      && externalStateUnchanged
      && fixture.startsWith(safePrefix)
    ) {
      await rm(fixture, { recursive: true, force: true })
    } else if (fixture !== null) {
      process.stderr.write(`[clean-install] retained isolated fixture: ${fixture}\n`)
    }
    if (externalStateError !== null) throw externalStateError
  }
  if (successPayload === null) throw new Error('clean install acceptance produced no result')
  process.stdout.write(`${JSON.stringify(successPayload)}\n`)
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[clean-install] FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
