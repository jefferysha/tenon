// @vitest-environment node
/**
 * 保存工作流不能丢 `test_policy`：真 server 读出内建 default → 前端严格解码 → 写回前整形 → POST → 再读，
 * 每个阶段（通用分支与各 track 分支）的策略逐字相同。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboardServer, resolveServerPaths } from '@tenon/server'
import { createFlowEngine, createStateStore, loadManifest } from '@tenon/kernel'
import { decodeWorkflowDefinition } from './governanceSchema'
import { definitionForWrite } from '../workbench/workbenchDefinition'
import type { WbStepDef, WbStepTestPolicy, WbWorkflowDef } from './governanceTypes'

const manifestPath = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))
const roots: string[] = []
const closers: Array<() => Promise<void>> = []

afterAll(async () => {
  for (const close of closers) await close()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function start(): Promise<{ port: number; root: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pl-policy-roundtrip-'))
  roots.push(root)
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home: root, env: {} }),
    version: 'itest',
    token: 'itest-token',
    registry: () => [root],
    store: createStateStore(),
    flow: createFlowEngine(loadManifest(manifestPath)),
    clock: () => '2026-09-29T00:00:00Z',
    resolveUser: () => ({ id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared' }),
  })
  const { port } = await srv.listen(0, '127.0.0.1')
  closers.push(() => srv.close())
  return { port, root, token: srv.token }
}

function policies(def: WbWorkflowDef): Record<string, WbStepTestPolicy | undefined> {
  const out: Record<string, WbStepTestPolicy | undefined> = {}
  const collect = (prefix: string, steps: readonly WbStepDef[]): void => {
    for (const step of steps) out[`${prefix}${step.id}`] = step.test_policy
  }
  collect('', def.steps)
  for (const [track, branch] of Object.entries(def.tracks ?? {})) collect(`${track}:`, branch.steps)
  return out
}

describe('保存工作流保留 test_policy（真 server 往返）', () => {
  it('内建 default 读出 → 解码 → 写回 → 再读，每个阶段的策略不变', async () => {
    const h = await start()
    const base = `http://127.0.0.1:${h.port}`
    const query = `root=${encodeURIComponent(h.root)}`
    const first = await (await fetch(`${base}/api/workflows/default?${query}`)).json()
    const before = decodeWorkflowDefinition(first)
    expect(before).not.toBeNull()
    if (before === null) return
    const declared = Object.values(policies(before)).filter((policy) => policy !== undefined)
    expect(declared.length).toBeGreaterThan(0)

    const posted = await fetch(`${base}/api/workflows/default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ root: h.root, ...definitionForWrite(before) }),
    })
    expect(posted.status).toBe(200)

    const second = await (await fetch(`${base}/api/workflows/default?${query}`)).json()
    const after = decodeWorkflowDefinition(second)
    expect(after).not.toBeNull()
    if (after === null) return
    expect(policies(after)).toEqual(policies(before))
  }, 30000)
})
