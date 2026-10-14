// @vitest-environment node
/**
 * 保存工作流不能丢测试设置：真 server 读出内建 default → 前端严格解码 → 写回前整形 → POST → 再读，
 * 每个阶段（通用分支与各 track 分支）的 `test` 档位逐字相同；旧 `test_policy` 在没选档位之前同样原样往返，选档位即替换。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboardServer, resolveServerPaths } from '@tenon/server'
import { installSessionFetch } from '../../../server/src/test-support.js'
import { createFlowEngine, createStateStore, loadManifest } from '@tenon/kernel'
import { decodeWorkflowDefinition } from './governanceSchema'
import { definitionForWrite, selectBranchDef, setStepTestLevelInDef, writeBranchDef } from '../workbench/workbenchDefinition'
import type { WbStepDef, WbStepTestPolicy, WbTestLevel, WbWorkflowDef } from './governanceTypes'

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
  const restoreFetch = await installSessionFetch(srv, port)
  closers.push(async () => { restoreFetch(); await srv.close() })
  return { port, root, token: srv.token }
}

interface Declared {
  test?: WbTestLevel
  test_policy?: WbStepTestPolicy
}

function declarations(def: WbWorkflowDef): Record<string, Declared> {
  const out: Record<string, Declared> = {}
  const collect = (prefix: string, steps: readonly WbStepDef[]): void => {
    for (const step of steps) {
      out[`${prefix}${step.id}`] = {
        ...(step.test === undefined ? {} : { test: step.test }),
        ...(step.test_policy === undefined ? {} : { test_policy: step.test_policy }),
      }
    }
  }
  collect('', def.steps)
  for (const [track, branch] of Object.entries(def.tracks ?? {})) collect(`${track}:`, branch.steps)
  return out
}

const LEGACY: WbStepTestPolicy = {
  plan: 'required', kinds: ['unit'], run: ['unit'], scope: 'full', files: 'registered',
  coverage: { lines: 80, functions: 60 }, flaky: { max: 2, fail_on_new: true }, browsers: ['chromium'],
}

describe('保存工作流保留测试设置（真 server 往返）', () => {
  it('内建 default 读出 → 解码 → 写回 → 再读，每个阶段的档位不变；default 里没有旧 test_policy', async () => {
    const h = await start()
    const base = `http://127.0.0.1:${h.port}`
    const query = `root=${encodeURIComponent(h.root)}`
    const first = await (await fetch(`${base}/api/workflows/default?${query}`)).json()
    const before = decodeWorkflowDefinition(first)
    expect(before).not.toBeNull()
    if (before === null) return
    const declared = Object.values(declarations(before))
    expect(declared.some((item) => item.test === 'changed')).toBe(true)
    expect(declared.some((item) => item.test === 'full')).toBe(true)
    expect(declared.some((item) => item.test_policy !== undefined)).toBe(false)

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
    expect(declarations(after)).toEqual(declarations(before))
  }, 30000)

  it('旧 test_policy 原样往返；选档位即替换（写回后该步只有 test）', async () => {
    const h = await start()
    const base = `http://127.0.0.1:${h.port}`
    const query = `root=${encodeURIComponent(h.root)}`
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` }
    const read = async (): Promise<WbWorkflowDef> => {
      const decoded = decodeWorkflowDefinition(await (await fetch(`${base}/api/workflows/default?${query}`)).json())
      if (decoded === null) throw new Error('decode failed')
      return decoded
    }
    const write = (def: WbWorkflowDef): Promise<Response> => fetch(`${base}/api/workflows/default`, {
      method: 'POST', headers, body: JSON.stringify({ root: h.root, ...definitionForWrite(def) }),
    })
    const builtin = await read()
    const lite = builtin.tracks?.lite
    const stepId = lite?.steps.find((step) => step.test === 'full')?.id
    expect(stepId).toBeDefined()
    if (lite === undefined || stepId === undefined) return
    const stepOf = (def: WbWorkflowDef): WbStepDef | undefined => def.tracks?.lite?.steps.find((step) => step.id === stepId)

    // 项目覆盖文件：lite 分支里那一步换成旧策略（在没选档位之前它原样往返）。
    const legacyLite = {
      ...lite,
      steps: lite.steps.map((step) => {
        if (step.id !== stepId) return step
        const { test: _test, ...plain } = step
        return { ...plain, test_policy: LEGACY }
      }),
    }
    const wrote = await write({ ...builtin, tracks: { ...builtin.tracks, lite: legacyLite } })
    expect(wrote.status, await wrote.clone().text()).toBe(200)
    const legacyStep = stepOf(await read())
    expect(legacyStep?.test_policy).toEqual(LEGACY)
    expect(legacyStep).not.toHaveProperty('test')

    // 选档位即替换：写回后该步只有 test。
    const loaded = await read()
    const replaced = writeBranchDef(loaded, 'lite', setStepTestLevelInDef(selectBranchDef(loaded, 'lite'), stepId, 'changed'))
    const rewrite = await write(replaced)
    expect(rewrite.status, await rewrite.clone().text()).toBe(200)
    const after = stepOf(await read())
    expect(after).toMatchObject({ test: 'changed' })
    expect(after).not.toHaveProperty('test_policy')
  }, 30000)
})
