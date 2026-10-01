// @vitest-environment node
/**
 * 契约往返：真 server 产出的测试体系响应（目录、基线、计划、记录、产物、快照里的策略判定）
 * 逐个喂给前端的严格解码器。fixtures 是手写的线上形状，这里证明真实的服务端输出也被解码器接受。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboardServer, resolveServerPaths } from '@tenon/server'
import { installSessionFetch } from '../../../server/src/test-support.js'
import {
  appendTestRunRecordV2, baselineV2Path, createFlowEngine, createStateStore, emptyTestPlan, loadManifest,
  nextBaselineV2, serializeKnownFailures, testRunArtifactsDir, testSystemPaths, writeTestBaselineV2, writeTestPlan,
} from '@tenon/kernel'
import {
  DESIGN_CATALOG, fixtureCase, fixtureRecordDraft, fixtureSuiteRun,
} from '@tenon/kernel/test-system/test-support'
import { decodeSnapshot } from './snapshotDecoder'
import {
  decodeBaselinesResponse, decodeCatalogResponse, decodePlanResponse, decodeRecordListResponse, decodeRecordResponse,
} from './testSystemDecoders'

const manifestPath = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))
const SLUG = 'tester-at-tenon.test'
const CHANGE = 'demo'
const ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
const roots: string[] = []
const closers: Array<() => Promise<void>> = []

afterAll(async () => {
  for (const close of closers) await close()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function start(): Promise<{ base: string; root: string; changeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pl-test-contract-'))
  roots.push(root)
  const store = createStateStore()
  const changeDir = await store.init({
    repoRoot: root, name: CHANGE, track: 'backend', reviewSeed: 'pending', preset: 'full',
    clock: () => '2026-09-29T00:00:00Z', creator: ACTOR,
  })
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home: root, env: {} }),
    version: 'itest',
    token: 'itest-token',
    registry: () => [root],
    store,
    flow: createFlowEngine(loadManifest(manifestPath)),
    clock: () => '2026-09-29T00:00:00Z',
    resolveUser: () => ({ ...ACTOR, slug: SLUG, source: 'env' }),
  })
  const { port } = await srv.listen(0, '127.0.0.1')
  const restoreFetch = await installSessionFetch(srv, port)
  closers.push(async () => { restoreFetch(); await srv.close() })
  return { base: `http://127.0.0.1:${port}`, root, changeDir }
}

async function getJson(base: string, path: string): Promise<unknown> {
  return (await fetch(`${base}${path}`)).json()
}

describe('测试体系契约往返（真 server → 严格解码器）', () => {
  it('目录、已知失败、基线、计划、记录、产物索引与快照策略判定都被解码', async () => {
    const h = await start()
    const query = `root=${encodeURIComponent(h.root)}`
    const paths = testSystemPaths(h.root)
    await mkdir(paths.root, { recursive: true })
    await writeFile(paths.catalog, DESIGN_CATALOG, 'utf8')
    await writeFile(paths.knownFailures, serializeKnownFailures([
      { suite: 'web-unit', test: 'src/a.test.ts › old', reason: 'r', link: 'https://example.test/1', expires: '2999-12-31', added_by: 'a@x.io' },
    ]), 'utf8')
    const profile = 'darwin-arm64-m3max-node22-1a2b3c4d'
    await writeTestBaselineV2(baselineV2Path(h.root, 'api-bench', profile), nextBaselineV2(undefined, {
      suite: 'api-bench', profile, profile_label: 'darwin-arm64-m3max-node22',
      metrics: { p95_ms: { median: 12, p95: 14, mad: 1, samples: 5, better: 'lower', unit: 'ms' } },
      source: { change: CHANGE, run_id: '20260929T100000Z-abcdef', commit: null }, actor: ACTOR, updated_at: '2026-09-20T00:00:00Z',
    }))
    await writeTestPlan(h.changeDir, {
      ...emptyTestPlan(CHANGE), suites: [{ suite: 'web-unit', scope: 'full' }],
      files: [{ path: 'src/a.test.ts', suite: 'web-unit' }], cases: [{ covers: 'task:1', tests: ['src/a.test.ts › works'] }],
      waivers: [{ kind: 'benchmark', reason: 'x', approved_by: null }],
    }, { actor: ACTOR, recordedAt: '2026-09-29T00:00:00Z' })
    const appended = await appendTestRunRecordV2(h.root, SLUG, fixtureRecordDraft({
      change: CHANGE, step: 'verify', result: 'fail',
      suites: [fixtureSuiteRun({
        suite: 'web-unit', result: 'fail', exit_code: 1,
        cases: [fixtureCase({ file: 'src/a.test.ts', line: 3, name: 'works', status: 'fail', failure: { message: 'boom', stack: 's', expected: '1', actual: '2' } })],
        coverage: { lines: 70.5, changed_lines: 90 },
        metrics: [{ name: 'p95_ms', unit: 'ms', better: 'lower', samples: [1, 2, 3], median: 2, p95: 3, mad: 1 }],
        artifacts: [{ path: 'shots/a.png', bytes: 3, digest: `sha256:${'a'.repeat(64)}`, media: 'image' }],
      })],
    }))
    const runId = appended.record.run_id
    const runDir = testRunArtifactsDir(h.root, SLUG, CHANGE, runId)
    await mkdir(join(runDir, 'shots'), { recursive: true })
    await writeFile(join(runDir, 'shots', 'a.png'), 'png', 'utf8')

    const catalog = decodeCatalogResponse(await getJson(h.base, `/api/tests/catalog?${query}`))
    expect(catalog?.catalog.state).toBe('ok')
    expect(catalog?.knownFailures).toMatchObject({ state: 'ok', entries: [{ suite: 'web-unit', expired: false }] })
    expect(catalog?.latest.map((item) => [item.suite, item.result])).toEqual([['web-unit', 'fail']])

    const baselines = decodeBaselinesResponse(await getJson(h.base, `/api/tests/baselines?${query}&suite=api-bench`))
    expect(baselines?.baselines[0]).toMatchObject({ profile, profileLabel: 'darwin-arm64-m3max-node22' })

    const plan = decodePlanResponse(await getJson(h.base, `/api/tests/plan?${query}&change=${CHANGE}`))
    expect(plan).toMatchObject({ state: 'ok', suites: [{ suite: 'web-unit', kind: 'unit' }], waivers: [{ kind: 'benchmark', approvedBy: null }] })

    const list = decodeRecordListResponse(await getJson(h.base, `/api/tests/records?${query}&change=${CHANGE}`))
    expect(list?.users).toEqual([{ user: SLUG, chain: 'intact' }])
    expect(list?.runs[0]).toMatchObject({ runId, trusted: true, step: 'verify' })

    const record = decodeRecordResponse(await getJson(h.base, `/api/tests/record?${query}&change=${CHANGE}&user=${SLUG}&run=${runId}`))
    expect(record).toMatchObject({ runId, trusted: true, machineLabel: 'darwin-arm64-m3max-node22' })
    expect(record?.artifactsDir.startsWith('/')).toBe(false)
    expect(record?.suites[0]?.cases[0]).toMatchObject({ file: 'src/a.test.ts', line: 3, failure: { message: 'boom', expected: '1', actual: '2' } })
    expect(record?.suites[0]?.artifacts[0]).toMatchObject({ path: 'shots/a.png', present: true, media: 'image' })
    const image = await fetch(`${h.base}/api/tests/artifact?${query}&change=${CHANGE}&user=${SLUG}&run=${runId}&path=shots%2Fa.png`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')

    const snapshot = decodeSnapshot(await getJson(h.base, '/api/snapshot'))
    expect(snapshot).not.toBeNull()
    const change = snapshot?.projects[0]?.changes.find((item) => item.name === CHANGE)
    expect(change?.testUser).toBe(SLUG)
    expect(change?.testPlan).toMatchObject({ state: 'ok', suites: [{ suite: 'web-unit', kind: 'unit' }] })
    const steps = (change?.testPolicy ?? []).map((report) => report.stepId)
    expect(steps.length).toBeGreaterThan(0)
    expect(steps).toContain('build')
    const build = change?.testPolicy?.find((report) => report.stepId === 'build')
    expect(build?.policy).not.toBeNull()
    expect(build?.suites.every((suite) => typeof suite.suite === 'string')).toBe(true)
  }, 30000)

  it('目录里的 not_applicable：真 server 的快照策略判定带着种类、原因与是否已批准，严格解码器接受', async () => {
    const h = await start()
    const paths = testSystemPaths(h.root)
    await mkdir(paths.root, { recursive: true })
    await writeFile(paths.catalog, `${DESIGN_CATALOG}not_applicable:
  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: reviewer@tenon.test }
  - { kind: visual, reason: 没有界面, approved_by: null }
`, 'utf8')
    const snapshot = decodeSnapshot(await getJson(h.base, '/api/snapshot'))
    expect(snapshot).not.toBeNull()
    const change = snapshot?.projects[0]?.changes.find((item) => item.name === CHANGE)
    const build = change?.testPolicy?.find((report) => report.stepId === 'build')
    expect(build?.notApplicable).toEqual([
      { kind: 'typecheck', reason: '纯 JavaScript 项目', approved: true },
      { kind: 'visual', reason: '没有界面', approved: false },
    ])
  }, 30000)

  it('没有目录的项目：目录 missing、计划 missing，快照里的判定带「目录缺失」阻塞与发现命令', async () => {
    const h = await start()
    const query = `root=${encodeURIComponent(h.root)}`
    expect(decodeCatalogResponse(await getJson(h.base, `/api/tests/catalog?${query}`)))
      .toEqual({ catalog: { state: 'missing' }, knownFailures: { state: 'missing' }, latest: [] })
    expect(decodePlanResponse(await getJson(h.base, `/api/tests/plan?${query}&change=${CHANGE}`))).toEqual({ state: 'missing' })
    const snapshot = decodeSnapshot(await getJson(h.base, '/api/snapshot'))
    const change = snapshot?.projects[0]?.changes.find((item) => item.name === CHANGE)
    const blockers = (change?.testPolicy ?? []).flatMap((report) => report.blockers)
    expect(blockers.some((item) => item.code === 'test-catalog-missing' && item.fix === 'tenon test discover --write')).toBe(true)
  }, 30000)
})
