import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveProductPaths } from '@tenon/kernel'
import { freshHarness, REPO_ROOT, type Harness } from './integration-harness.js'

interface HookResult { code: number; stdout: string; stderr: string }

const TOKEN_VALUE = 'secret-token-value-7f3a'
const SIGNAL_FILE = '.pipeline-decision-security.jsonl'

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
    for (const forbidden of [TOKEN_VALUE, 'Authorization', 'Bearer', 'curl', tokenPath, 'toolu_']) {
      expect(raw).not.toContain(forbidden)
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
