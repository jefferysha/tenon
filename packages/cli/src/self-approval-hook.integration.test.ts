import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveProductPaths } from '@tenon/kernel'
import { freshHarness, realDeps, REPO_ROOT, type Harness } from './integration-harness.js'

interface HookResult { code: number; stdout: string; stderr: string }

function runGate(root: string, payload: unknown, runtimeHome: string): HookResult {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, TENON_RUNTIME_STATE_ROOT: join(runtimeHome, 'state') }
  delete env.TENON_AFK
  delete env.TENON_RUNTIME_HOME
  delete env.TENON_RUNTIME_ROOTS
  const result = spawnSync('bash', [join(REPO_ROOT, 'hooks', 'gate.sh')], {
    input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_ROOT, env,
  })
  if (result.error) throw result.error
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('pending review self-approval detector', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    expect(await h.run(['check', 'demo'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('records exact token read and localhost review control write as redacted signals', async () => {
    const runtimeHome = join(h.cwd, 'runtime-home')
    const tokenPath = resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: h.cwd }).dashboardTokenPath
    const tokenRead = runGate(h.cwd, { cwd: h.cwd, tool_name: 'Bash', command: `cat "${tokenPath}"` }, runtimeHome)
    expect(tokenRead.code, tokenRead.stderr).toBe(2)
    const apiWrite = runGate(h.cwd, {
      cwd: h.cwd, tool_name: 'Bash',
      command: 'curl -X POST http://127.0.0.1:18765/api/change/demo/decisions',
    }, runtimeHome)
    expect(apiWrite.code).toBe(2)

    const raw = await h.readIn('demo', '.pipeline-decision-security.jsonl')
    const signals = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(signals).toHaveLength(2)
    expect(signals.map((signal) => signal.kind)).toEqual(['token-file-read', 'localhost-control-write'])
    for (const signal of signals) {
      expect(signal.signal_kind).toBe('pending-decision-self-approval-suspected')
      expect(signal.change).toBe('demo')
      expect(signal.phase).toBe('explore')
      expect(signal.event).toBe('explore-complete')
      expect(signal.request_anchor).toMatch(/^2026-07-07T00:00:00Z\|[0-9a-f]{64}\|/u)
      expect(signal.channel).toBe('hook')
      expect(signal.process_or_host_hash).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(Number.isNaN(Date.parse(String(signal.observed_at)))).toBe(false)
      expect(JSON.stringify(signal)).not.toContain(tokenPath)
      expect(JSON.stringify(signal)).not.toContain('secret-token-value')
    }
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
  })

  test('does not report near-match reads or GET/foreign-host requests', async () => {
    const runtimeHome = join(h.cwd, 'runtime-home')
    const tokenPath = resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: h.cwd }).dashboardTokenPath
    expect(runGate(h.cwd, { cwd: h.cwd, tool_name: 'Bash', command: `cat "${tokenPath}.bak"` }, runtimeHome).code).toBe(0)
    expect(runGate(h.cwd, { cwd: h.cwd, tool_name: 'Bash', command: 'curl -X GET http://127.0.0.1:18765/api/change/demo/decisions' }, runtimeHome).code).toBe(2)
    expect(runGate(h.cwd, { cwd: h.cwd, tool_name: 'Bash', command: 'curl -X POST http://example.test/api/change/demo/decisions' }, runtimeHome).code).toBe(2)
    await expect(readFile(join(h.cwd, 'openspec', 'changes', 'demo', '.pipeline-decision-security.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does not record after the pending review is acknowledged', async () => {
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    const runtimeHome = join(h.cwd, 'runtime-home')
    const tokenPath = resolveProductPaths({ env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: h.cwd }).dashboardTokenPath
    expect(runGate(h.cwd, { cwd: h.cwd, tool_name: 'Bash', command: `cat "${tokenPath}"` }, runtimeHome).code).toBe(0)
    await expect(readFile(join(h.cwd, 'openspec', 'changes', 'demo', '.pipeline-decision-security.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
