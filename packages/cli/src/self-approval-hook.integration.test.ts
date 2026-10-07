import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveProductPaths } from '@tenon/kernel'
import { freshHarness, REPO_ROOT, type Harness } from './integration-harness.js'

interface HookResult { code: number; stdout: string; stderr: string }

const TOKEN_VALUE = 'secret-token-value-7f3a'
const SIGNAL_FILE = '.pipeline-decision-security.jsonl'

/** The random digests a record carries: request_anchor, observation_key and process_or_host_hash all embed 64 hex digits. */
const RECORDED_DIGEST = /[0-9a-f]{64}/gu

/**
 * The forbidden fragments that appear in the recorded text, ignoring the digests. A digit run such as the port
 * `18765` turns up inside a random digest by chance; what must never be recorded is the port, URL or command
 * the observed process used, which sit in readable fields, not in a hash.
 */
function recordedFragments(raw: string, forbidden: readonly string[]): string[] {
  const readable = raw.replace(RECORDED_DIGEST, '')
  return forbidden.filter((fragment) => readable.includes(fragment))
}

/** Runs the real hook against the built CLI bundle; the runtime home isolates product state. */
function runGate(payload: unknown, runtimeHome: string, afk: boolean): HookResult {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, TENON_RUNTIME_HOME: runtimeHome }
  delete env.TENON_RUNTIME_STATE_ROOT
  delete env.TENON_RUNTIME_ROOTS
  delete env.PLUGIN_ROOT
  if (afk) env.TENON_AFK = '1'
  else delete env.TENON_AFK
  const result = spawnSync('bash', [join(REPO_ROOT, 'hooks', 'gate.sh')], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_ROOT, env,
  })
  if (result.error) throw result.error
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('pending review self-approval detector (hook → CLI)', () => {
  let h: Harness
  let runtimeHome: string
  let tokenPath: string

  async function signalFile(): Promise<string> {
    return h.readIn('demo', SIGNAL_FILE)
  }

  beforeEach(async () => {
    h = await freshHarness()
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['check', 'demo'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    runtimeHome = join(h.cwd, 'runtime-home')
    tokenPath = resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: h.cwd }).dashboardTokenPath
    await mkdir(join(runtimeHome, 'state'), { recursive: true })
    await writeFile(tokenPath, JSON.stringify({ token: TOKEN_VALUE }), { mode: 0o600 })
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('AFK still records a token read and a loopback API call without blocking', async () => {
    const read = runGate({ cwd: h.cwd, tool_name: 'Bash', tool_use_id: 'toolu_a', command: `cat "${tokenPath}"` }, runtimeHome, true)
    expect(read.code, read.stderr).toBe(0)
    const api = runGate({
      cwd: h.cwd, tool_name: 'Bash', tool_use_id: 'toolu_b',
      command: 'curl -X POST http://127.0.0.1:18765/api/change/demo/decisions',
    }, runtimeHome, true)
    expect(api.code, api.stderr).toBe(0)
    const signals = (await signalFile()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(signals.map((signal) => signal.kind)).toEqual(['token-file-read', 'local-control-api-call'])
    for (const signal of signals) {
      expect(signal).toMatchObject({
        signal_kind: 'pending-decision-self-approval-suspected', change: 'demo',
        phase: 'explore', event: 'explore-complete', channel: 'terminal',
      })
      expect(signal.request_anchor).toMatch(/^2026-07-07T00:00:00Z\|[0-9a-f]{64}\|/u)
      expect(signal.process_or_host_hash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u)
    }
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
  })

  test('HITL keeps blocking a token read while recording it', async () => {
    const read = runGate({ cwd: h.cwd, tool_name: 'Bash', command: `cat "${tokenPath}"` }, runtimeHome, false)
    expect(read.code).toBe(2)
    expect(read.stderr).toContain('dashboard token')
    expect(await signalFile()).toContain('token-file-read')
  })

  test('Read tool and command variants each produce a candidate and a record', async () => {
    const variants: Array<[string, Record<string, unknown>]> = [
      ['read', { tool_name: 'Read', tool_input: { file_path: tokenPath } }],
      ['xpost', { tool_name: 'Bash', command: 'curl -XPOST http://127.0.0.1:18765/api/change/demo/decisions' }],
      ['json', { tool_name: 'Bash', command: 'curl --json \'{"x":1}\' http://localhost:18765/api/change/demo/decisions' }],
      ['data-file', { tool_name: 'Bash', command: 'curl -d @body.json http://[::1]:18765/api/change/demo/transition' }],
      ['subst', { tool_name: 'Bash', command: `curl -H "Authorization: Bearer $(jq -r .token ${tokenPath})" http://127.0.0.1:18765/api/x` }],
      ['pipe', { tool_name: 'Bash', command: `cat ${tokenPath} | jq -r .token` }],
      ['wrapped', { tool_name: 'command_execution', command: '/bin/zsh -lc "wget -qO- localhost:18765/api/snapshot"' }],
    ]
    for (const [id, body] of variants) {
      const result = runGate({ cwd: h.cwd, tool_use_id: `toolu_${id}`, ...body }, runtimeHome, true)
      expect(result.code, `${id}: ${result.stderr}`).toBe(0)
    }
    const signals = (await signalFile()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(signals.map((signal) => signal.kind)).toEqual([
      'token-file-read',
      'local-control-api-call',
      'local-control-api-call',
      'local-control-api-call',
      'token-file-read', 'local-control-api-call',
      'token-file-read',
      'local-control-api-call',
    ])
    const raw = await signalFile()
    expect(recordedFragments(raw, [TOKEN_VALUE, 'Authorization', 'Bearer', 'curl', tokenPath, 'toolu_'])).toEqual([])
  })

  // The previous raw-JSON filter ("token file name, or loopback host plus /api/") let all of these through
  // unrecorded; GET / used to hand out the write token, so a path-less request was the useful one.
  test('every shape the old filter missed is recorded, in AFK and with a script file', async () => {
    await writeFile(join(h.cwd, 'poke.sh'), '#!/bin/sh\nH=127.0.0.1\nP=18765\ncurl -s "http://$H:$P/"\n')
    await writeFile(join(h.cwd, 'poke.py'), 'import urllib.request\nurllib.request.urlopen("http://localhost:18765/").read()\n')
    await writeFile(join(h.cwd, 'build.sh'), '#!/bin/sh\necho building\n')
    const shapes: Array<[string, string]> = [
      ['root-get', 'curl -s http://127.0.0.1:18765/'],
      ['bare-host', 'curl -s localhost:18765'],
      ['no-api-path', 'curl http://127.0.0.1:18765/health'],
      ['netcat', 'nc localhost 18765'],
      ['dev-tcp', 'exec 3<>/dev/tcp/127.0.0.1/18765'],
      ['decimal-ip', 'curl http://2130706433:18765/'],
      ['hex-ip', 'curl http://0x7f000001:18765/'],
      ['mapped-v6', 'curl "http://[::ffff:127.0.0.1]:18765/"'],
      ['variables', 'H=127.0.0.1; curl http://$H:$PORT/'],
      ['python-inline', 'python3 -c "import urllib.request as u; u.urlopen(\'http://localhost:18765/\')"'],
      ['node-inline', 'node -e "fetch(\'http://127.0.0.1:18765/\')"'],
      ['shell-script', 'sh poke.sh'],
      ['shell-script-dot', './poke.sh'],
      ['python-script', 'python3 poke.py'],
      ['chained-script', 'cd . && python3 poke.py'],
      ['session-open', 'curl -X POST -H "Content-Type: application/json" -d {} http://127.0.0.1:18765/api/session/open'],
      ['launcher', 'tenon dashboard'],
      ['server-bundle', 'node packages/server/dist/dashboard.mjs'],
    ]
    for (const [id, command] of shapes) {
      const result = runGate({ cwd: h.cwd, tool_name: 'Bash', tool_use_id: `toolu_${id}`, command }, runtimeHome, true)
      expect(result.code, `${id}: ${result.stderr}`).toBe(0)
    }
    const signals = (await signalFile()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(signals).toHaveLength(shapes.length)
    expect(new Set(signals.map((signal) => signal.kind))).toEqual(new Set(['local-control-api-call']))
    const raw = await signalFile()
    expect(recordedFragments(raw, ['poke', '127.0.0.1', 'localhost', '18765', 'curl', 'toolu_'])).toEqual([])
  })

  test('commands that cannot reach the control surface are not recorded', async () => {
    await writeFile(join(h.cwd, 'build.sh'), '#!/bin/sh\necho building\n')
    for (const command of [
      'sh build.sh',
      'curl -s http://127.0.0.1:18765/api/health',
      'curl -s http://localhost:3000/api/users',
      'grep -n localhost /etc/hosts',
      'tenon dashboard --open',
      'git status',
    ]) {
      const result = runGate({ cwd: h.cwd, tool_name: 'Bash', command }, runtimeHome, true)
      expect(result.code, `${command}: ${result.stderr}`).toBe(0)
    }
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'demo', SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('the recorded port follows the running server recorded in the pidfile, not only 18765', async () => {
    await writeFile(
      resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: h.cwd }).dashboardPidfilePath,
      JSON.stringify({ pid: 1, port: 19765, version: '0.3.0' }),
    )
    runGate({ cwd: h.cwd, tool_name: 'Bash', command: 'curl -s http://127.0.0.1:19765/' }, runtimeHome, true)
    expect((await signalFile()).trim().split('\n')).toHaveLength(1)
  })

  test('HITL blocks reaching the control surface with a pointer to the sanctioned path, but lets `tenon dashboard --open` through', async () => {
    const blocked = runGate({ cwd: h.cwd, tool_name: 'Bash', command: 'curl -s http://127.0.0.1:18765/' }, runtimeHome, false)
    expect(blocked.code).toBe(2)
    expect(blocked.stderr).toContain('Dashboard 控制面')
    expect(blocked.stderr).toContain('tenon dashboard --open')
    const foreground = runGate({ cwd: h.cwd, tool_name: 'Bash', command: 'tenon dashboard' }, runtimeHome, false)
    expect(foreground.code).toBe(2)
    const opened = runGate({ cwd: h.cwd, tool_name: 'Bash', command: 'tenon dashboard --open' }, runtimeHome, false)
    expect(opened.code, opened.stderr).toBe(0)
    const chained = runGate({ cwd: h.cwd, tool_name: 'Bash', command: 'cd . && tenon dashboard --open --port 18765' }, runtimeHome, false)
    expect(chained.code, chained.stderr).toBe(0)
    for (const smuggled of ['tenon dashboard --open && curl http://127.0.0.1:18765/', 'tenon dashboard --open --port 1;id', 'tenon dashboard --open --port x']) {
      expect(runGate({ cwd: h.cwd, tool_name: 'Bash', command: smuggled }, runtimeHome, false).code, smuggled).toBe(2)
    }
  })

  test('the same tool_use_id is recorded once', async () => {
    const payload = { cwd: h.cwd, tool_name: 'Bash', tool_use_id: 'toolu_repeat', command: `cat "${tokenPath}"` }
    runGate(payload, runtimeHome, true)
    runGate(payload, runtimeHome, true)
    expect((await signalFile()).trim().split('\n')).toHaveLength(1)
  })

  test('no canonical pending receipt means zero writes, even with a fresh hook marker', async () => {
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await writeFile(join(h.cwd, '.pipeline-pending-review'), 'pipeline-review-v2\nphase=explore\nchange=demo\nrequested_at=x\n')
    runGate({ cwd: h.cwd, tool_name: 'Bash', command: `cat "${tokenPath}"` }, runtimeHome, true)
    await expect(readFile(join(h.cwd, 'openspec', 'changes', 'demo', SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('non-candidate tool input is not forwarded', async () => {
    const result = runGate({ cwd: h.cwd, tool_name: 'Bash', command: 'curl https://example.test/api/change/demo/decisions' }, runtimeHome, true)
    expect(result.code).toBe(0)
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'demo', SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('recordedFragments ignores digit runs inside the random digests', () => {
  /** A request_anchor whose digest holds the Dashboard port by chance, as in a failed CI run (`…|0e299d7918765…`). */
  const digestWithPort = `0e299d7918765${'a'.repeat(51)}`
  const record = (extra: Record<string, string> = {}): string => JSON.stringify({
    signal_kind: 'pending-decision-self-approval-suspected', kind: 'local-control-api-call', change: 'demo',
    phase: 'explore', event: 'explore-complete', channel: 'terminal',
    request_anchor: `2026-07-07T00:00:00Z|${digestWithPort}|explore-complete`,
    observation_key: `sha256:${digestWithPort}`,
    process_or_host_hash: `hmac-sha256:${digestWithPort}`,
    ...extra,
  })

  test('a port that only occurs inside a digest is not reported, where the bare substring check was', () => {
    const raw = record()
    expect(digestWithPort).toHaveLength(64)
    expect(raw.includes('18765')).toBe(true)
    expect(recordedFragments(raw, ['18765', '127.0.0.1', 'localhost', 'curl'])).toEqual([])
  })

  test('the port, host or command in a readable field is still reported', () => {
    for (const leak of ['curl http://127.0.0.1:18765/', 'localhost:18765', '[::1]:18765', 'nc localhost 18765', 'port 18765']) {
      expect(recordedFragments(record({ event: leak }), ['18765', '127.0.0.1', 'localhost', 'curl']), leak).not.toEqual([])
    }
  })
})
