import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveProductPaths, SELF_APPROVAL_SIGNAL_FILE } from '@tenon/kernel'
import { freshHarness, realDeps, type Harness } from '../integration-harness.js'
import { cmdInternalSelfApproval } from './internalSelfApproval.js'
import { appendObservationUnderLock } from './selfApprovalObservationLog.js'

const TOKEN_VALUE = 'secret-token-value-7f3a'

describe('internal-self-approval precise recorder', () => {
  let h: Harness
  let runtimeHome: string
  let pathInput: { env: Record<string, string>; homeDir: string }
  let tokenPath: string
  let payloadSeq = 0

  async function payload(body: Record<string, unknown>): Promise<string> {
    payloadSeq += 1
    const path = join(h.cwd, `payload-${payloadSeq}.json`)
    await writeFile(path, JSON.stringify({ process_or_host_identity: 'hook-parent:1;host:h;session:s', ...body }), { mode: 0o600 })
    return path
  }

  async function record(body: Record<string, unknown>, change?: string): Promise<number> {
    const err: string[] = []
    const code = await cmdInternalSelfApproval(realDeps(h.cwd, [], err), await payload(body), change, pathInput)
    if (code !== 0) throw new Error(err.join('\n'))
    return code
  }

  async function signals(change = 'demo'): Promise<Record<string, unknown>[]> {
    const raw = await readFile(join(h.cwd, 'openspec', 'changes', change, SELF_APPROVAL_SIGNAL_FILE), 'utf8')
    return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  beforeEach(async () => {
    h = await freshHarness()
    runtimeHome = join(h.cwd, 'runtime-home')
    pathInput = { env: { TENON_RUNTIME_HOME: runtimeHome }, homeDir: h.cwd }
    tokenPath = resolveProductPaths(pathInput).dashboardTokenPath
    await h.run(['init', 'quiet', '--track', 'backend', '--preset', 'full'])
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    expect(await h.run(['check', 'demo'])).toBe(0)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('scans every Change and records only where a canonical pending receipt exists', async () => {
    await record({ candidate: `cat "${tokenPath}"`, tool_use_id: 'toolu_1' })
    const [signal] = await signals()
    expect(signal).toMatchObject({
      kind: 'token-file-read', change: 'demo', phase: 'explore', event: 'explore-complete', channel: 'terminal',
    })
    expect(String(signal?.observation_key)).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(String(signal?.process_or_host_hash)).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u)
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'quiet', SELF_APPROVAL_SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('dedupes by tool_use_id or candidate digest and records both kinds of a combined command', async () => {
    const combined = `curl -H "Authorization: Bearer $(jq -r .token ${tokenPath})" http://127.0.0.1:18765/api/change/demo/decisions`
    await record({ candidate: combined, tool_use_id: 'toolu_same' }, 'demo')
    await record({ candidate: combined, tool_use_id: 'toolu_same' }, 'demo')
    await record({ candidate: 'curl -XPOST localhost:18765/api/x' })
    await record({ candidate: 'curl -XPOST localhost:18765/api/x' })
    const all = await signals()
    expect(all.map((signal) => signal.kind)).toEqual(['token-file-read', 'local-control-api-call', 'local-control-api-call'])
    const raw = await readFile(join(h.cwd, 'openspec', 'changes', 'demo', SELF_APPROVAL_SIGNAL_FILE), 'utf8')
    for (const forbidden of ['Authorization', 'Bearer', 'curl', tokenPath, TOKEN_VALUE, 'toolu_same', 'hook-parent']) {
      expect(raw).not.toContain(forbidden)
    }
  })

  test('near misses, foreign hosts and non-pending Changes produce zero writes and no identity key', async () => {
    await record({ candidate: `cat "${tokenPath}.bak"` })
    await record({ candidate: 'curl -X POST http://example.test/api/change/demo/decisions' })
    await record({ candidate: `cat "${tokenPath}"` }, 'quiet')
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'demo', SELF_APPROVAL_SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'quiet', SELF_APPROVAL_SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(resolveProductPaths(pathInput).decisionObservationKeyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does not record after the review is acknowledged', async () => {
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await record({ candidate: `cat "${tokenPath}"` })
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'demo', SELF_APPROVAL_SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keys the identity digest with a stable owner-only per-install secret', async () => {
    await record({ candidate: `cat "${tokenPath}"`, tool_use_id: 'a' })
    await record({ candidate: `cat "${tokenPath}"`, tool_use_id: 'b' })
    const keyPath = resolveProductPaths(pathInput).decisionObservationKeyPath
    const keyStat = await stat(keyPath)
    expect(keyStat.size).toBe(32)
    if (process.platform !== 'win32') expect(keyStat.mode & 0o777).toBe(0o600)
    const [first, second] = await signals()
    expect(first?.process_or_host_hash).toBe(second?.process_or_host_hash)
  })

  test('refuses a symlinked identity key instead of following it', async () => {
    const keyPath = resolveProductPaths(pathInput).decisionObservationKeyPath
    await mkdir(join(runtimeHome, 'state'), { recursive: true })
    await writeFile(join(h.cwd, 'foreign.key'), Buffer.alloc(32), { mode: 0o600 })
    await symlink(join(h.cwd, 'foreign.key'), keyPath)
    const err: string[] = []
    const code = await cmdInternalSelfApproval(realDeps(h.cwd, [], err), await payload({ candidate: `cat "${tokenPath}"` }), 'demo', pathInput)
    expect(code).toBe(1)
    await expect(lstat(join(h.cwd, 'openspec', 'changes', 'demo', SELF_APPROVAL_SIGNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects payloads with unknown fields', async () => {
    const err: string[] = []
    const path = await payload({ candidate: `cat "${tokenPath}"`, token: TOKEN_VALUE })
    expect(await cmdInternalSelfApproval(realDeps(h.cwd, [], err), path, 'demo', pathInput)).toBe(1)
  })

  test('appends a single overflow marker once the size cap is reached and then stops', async () => {
    const dir = join(h.cwd, 'openspec', 'changes', 'demo')
    const make = (n: number) => ({
      schema_version: 'pending-decision-security/v1' as const,
      signal_kind: 'pending-decision-self-approval-suspected' as const,
      kind: 'local-control-api-call' as const, change: 'demo', phase: 'explore', event: 'explore-complete',
      request_anchor: 'anchor', channel: 'terminal' as const,
      observation_key: `sha256:${n.toString(16).padStart(64, '0')}`,
      process_or_host_hash: `hmac-sha256:${'c'.repeat(64)}`, observed_at: '2026-07-07T00:00:00Z',
    })
    const cap = 2 * (JSON.stringify(make(1)).length + 1)
    expect(await appendObservationUnderLock(dir, make(1), 'now', cap)).toBe('appended')
    expect(await appendObservationUnderLock(dir, make(1), 'now', cap)).toBe('duplicate')
    expect(await appendObservationUnderLock(dir, make(2), 'now', cap)).toBe('appended')
    expect(await appendObservationUnderLock(dir, make(3), 'now', cap)).toBe('overflow-marked')
    expect(await appendObservationUnderLock(dir, make(4), 'now', cap)).toBe('overflowed')
    expect(await appendObservationUnderLock(dir, make(5), 'now', cap)).toBe('overflowed')
    const lines = (await signals()).map((line) => line.signal_kind)
    expect(lines).toEqual([
      'pending-decision-self-approval-suspected',
      'pending-decision-self-approval-suspected',
      'pending-decision-security-overflow',
    ])
  })
})
