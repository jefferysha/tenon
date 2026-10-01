/**
 * Dashboard 快照 × 测试证据封存：封存（本机 HMAC 文件 + 它的密钥）被破坏后，Dashboard 立刻显示 `record-unsealed`，
 * 而不是继续给出缓存里那份「全绿」。缓存的输入指纹必须覆盖封存判定依赖的文件，不能靠 30 秒的老化上限兜底。
 * 真临时项目、真 CLI 建任务并真运行套件、真缓存（createSnapshotCache）与真指纹，零 mock；时钟固定，所以老化上限不会参与。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStateStore, userProjectPaths, type TenonUser } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from '../../cli/src/integration-harness.js'
import { createSnapshotCache, type SnapshotCache } from './snapshotCache.js'
import type { PolicyReportDto } from './testSystemDtoTypes.js'

const USER: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const ENV = { TENON_USER: USER.id, TENON_USER_NAME: USER.name }
const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
`
const GEN_REPORT = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/unit.xml', '<?xml version="1.0"?><testsuites><testsuite name="t" tests="1" failures="0"><testcase name="good" classname="t" file="src/a.test.js"/></testsuite></testsuites>')
`
const WORKFLOW = `name: sealed
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    test_policy:
      run: [unit]
    transitions:
      - event: build-done
        to: done
  - id: done
    label: 完结
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

let harness: Harness | undefined
afterEach(async () => {
  if (harness !== undefined) await rm(harness.cwd, { recursive: true, force: true })
  harness = undefined
})

async function project(): Promise<{ readonly h: Harness; readonly cache: SnapshotCache }> {
  const h = await freshHarness()
  harness = h
  await mkdir(join(h.cwd, 'src'), { recursive: true })
  await mkdir(join(h.cwd, '.tenon', 'tests'), { recursive: true })
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, 'package.json'), '{ "name": "fixture", "private": true, "type": "module" }\n', 'utf8')
  await writeFile(join(h.cwd, 'gen-report.mjs'), GEN_REPORT, 'utf8')
  await writeFile(join(h.cwd, 'src', 'a.test.js'), 'export {}\n', 'utf8')
  await writeFile(join(h.cwd, '.tenon', 'tests', 'catalog.yaml'), CATALOG, 'utf8')
  await writeFile(join(h.cwd, '.pipeline', 'workflows', 'sealed.yaml'), WORKFLOW, 'utf8')
  expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'sealed', '--preset', 'full'], { env: ENV }), h.err.join('\n')).toBe(0)
  expect(await h.run(['test', 'register', 'demo', '--suite', 'unit'], { env: ENV }), h.err.join('\n')).toBe(0)
  expect(await h.run(['test', 'run', 'demo', '--stage'], { env: ENV }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)
  // The clock never moves, so the cell's age limit cannot be what makes a change visible.
  const cache = createSnapshotCache({
    snapshotDeps: () => ({
      registry: () => [h.cwd], store: createStateStore(), version: '1', clock: () => '2026-09-30T10:00:00Z', resolveUser: () => USER,
    }),
    now: () => Date.parse('2026-09-30T10:00:00Z'),
  })
  return { h, cache }
}

const blockingCodes = (policy: PolicyReportDto | undefined): string[] =>
  (policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)

async function fullCodes(cache: SnapshotCache): Promise<string[]> {
  const snapshot = (await cache.full()).snapshot
  const change = snapshot.projects[0]?.changes.find((candidate) => candidate.name === 'demo')
  return blockingCodes(change?.testPolicy?.find((report) => report.stepId === 'build'))
}

async function detailCodes(cache: SnapshotCache, root: string): Promise<string[]> {
  const shared = await cache.detail(root, 'demo')
  return blockingCodes(shared?.change.testPolicy?.find((report) => report.stepId === 'build'))
}

describe('Dashboard 快照里的封存判定不被缓存挡住', () => {
  test('封存文件被破坏：完整快照与任务详情都在下一次读取时出现 record-unsealed（不需要写入失效，也不等老化上限）', async () => {
    const { h, cache } = await project()
    expect(await fullCodes(cache)).toEqual([])
    expect(await detailCodes(cache, h.cwd)).toEqual([])
    // 同一份缓存、同一个时钟再读一次：命中缓存，仍然是绿的。
    expect(await fullCodes(cache)).toEqual([])

    const seal = join(userProjectPaths(h.cwd, USER.slug).localDir, 'test-seal.json')
    const original = await readFile(seal, 'utf8')
    await writeFile(seal, original.replace(/"mac":\s*"[0-9a-f]+"/, `"mac":"${'0'.repeat(64)}"`), 'utf8')

    expect(await fullCodes(cache)).toContain('record-unsealed')
    expect(await detailCodes(cache, h.cwd)).toContain('record-unsealed')
  }, 120_000)

  test('密钥被换掉、封存被删除同样可见；还原后恢复', async () => {
    const { h, cache } = await project()
    expect(await fullCodes(cache)).toEqual([])
    const paths = userProjectPaths(h.cwd, USER.slug)
    const seal = join(paths.localDir, 'test-seal.json')
    const key = await readFile(paths.envKey, 'utf8')
    const original = await readFile(seal, 'utf8')

    await writeFile(paths.envKey, `${'f'.repeat(64)}\n`, 'utf8')
    expect(await fullCodes(cache)).toContain('record-unsealed')
    await writeFile(paths.envKey, key, 'utf8')
    expect(await fullCodes(cache)).toEqual([])

    await rm(seal)
    expect(await fullCodes(cache)).toContain('record-unsealed')
    await writeFile(seal, original, 'utf8')
    expect(await fullCodes(cache)).toEqual([])
  }, 120_000)
})
