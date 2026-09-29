import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { corruptTestRunFiles } from '../test-evidence/evaluate.js'
import { loadCatalogInput, loadDeltaScenarios, loadKnownFailures, loadTaskItems } from './load.js'
import { testRunRecordsDir, testSystemPaths } from './paths.js'
import { appendTestRunRecordV2 } from './record-chain.js'
import { EMPTY_TEST_CATALOG, fixtureRecordDraft } from './test-support.js'

let repo = ''
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-load-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

describe('策略判定的 IO 装配', () => {
  it('目录：缺失 / 无效（带行号）/ 非普通文件 / 合法', async () => {
    const paths = testSystemPaths(repo)
    expect(await loadCatalogInput(repo)).toEqual({ state: 'missing' })
    await put(paths.catalog, 'schema: tenon-test-catalog/v1\nsuites:\n  - id: x\n')
    const invalid = await loadCatalogInput(repo)
    expect(invalid.state).toBe('invalid')
    expect(invalid.state === 'invalid' ? invalid.issues[0] : '').toMatch(/^catalog\.yaml:3: /)
    await rm(paths.catalog)
    await mkdir(paths.catalog)
    expect(await loadCatalogInput(repo)).toEqual({ state: 'invalid', issues: ['catalog.yaml 不是普通文件'] })
    await rm(paths.catalog, { recursive: true })
    await put(paths.catalog, EMPTY_TEST_CATALOG)
    expect(await loadCatalogInput(repo)).toMatchObject({ state: 'ok', catalog: { suites: [] } })
  })

  it('已知失败清单格式错 → 按空清单（失败不被豁免）', async () => {
    const paths = testSystemPaths(repo)
    expect(await loadKnownFailures(repo)).toEqual([])
    await put(paths.knownFailures, 'schema: nope\n')
    expect(await loadKnownFailures(repo)).toEqual([])
    await put(paths.knownFailures, 'schema: tenon-known-failures/v1\nentries:\n  - { suite: a, test: "a.ts › x", reason: r, expires: 2026-12-31, added_by: me }\n')
    expect(await loadKnownFailures(repo)).toHaveLength(1)
  })

  it('delta spec 场景与 tasks.md 条目从 change 目录读取', async () => {
    const changeDir = join(repo, 'openspec', 'changes', 'demo')
    expect(await loadDeltaScenarios(changeDir)).toEqual([])
    expect(await loadTaskItems(changeDir)).toEqual([])
    await put(join(changeDir, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requirement: R\n#### Scenario: 登录\n')
    await put(join(changeDir, 'specs', 'billing', 'spec.md'), '## ADDED Requirements\n#### Scenario: 付款\n')
    await put(join(changeDir, 'tasks.md'), '## 1. Build\n- [ ] 1.1 做\n')
    expect((await loadDeltaScenarios(changeDir)).map((item) => item.covers)).toEqual(['spec:auth/登录', 'spec:billing/付款'])
    expect((await loadTaskItems(changeDir)).map((item) => item.covers)).toEqual(['task:1.1'])
  })

  it('v2 记录与 v1 同目录，不被当成损坏的 v1 记录', async () => {
    const slug = 'tester-at-tenon.test'
    await appendTestRunRecordV2(repo, slug, fixtureRecordDraft())
    await writeFile(join(testRunRecordsDir(repo, slug, 'demo'), '20260101T000000Z-000002.json'), '{', 'utf8')
    expect(await corruptTestRunFiles(repo, 'demo', slug)).toEqual(['20260101T000000Z-000002.json'])
  })
})
