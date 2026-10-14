/**
 * Dashboard 快照 × 测试文件认领：`files: registered` 的策略判定读「自任务起点以来的改动文件」，
 * 快照扫描把它作为惰性输入传给测试证据投影（与 CLI / 转换同源），所以新增的测试文件由套件 glob 认领、不再要求登记，
 * 没人认领的在工作台上显示为 test-file-orphan；不是 git 仓库时以 files-diff-unavailable 阻塞而不是当作没有改动。
 * 真临时项目、真 git、真 CLI 建任务、真快照扫描，零 mock。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStateStore, testSystemPaths, type TenonUser } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from '../../cli/src/integration-harness.js'
import { commitAll, initGit, writeFiles } from '../../cli/src/integration-harness-tests.js'
import { buildSnapshot } from './snapshot.js'

const FIXED = '2026-09-30T10:00:00Z'
const USER: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: vitest
    command: npx vitest run
    files: ["src/**/*.test.ts"]
    report: { format: junit, path: test-results/unit.xml }
`
const WORKFLOW = `name: filesflow
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
      files: registered
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

async function project(options: { git: boolean }): Promise<Harness> {
  const h = await freshHarness()
  harness = h
  await writeFiles(h.cwd, { 'package.json': '{ "name": "fixture", "private": true }\n', 'src/old.test.ts': '// existing\n' })
  if (options.git) {
    initGit(h.cwd)
    commitAll(h.cwd, 'base', '2026-01-01T00:00:00Z')
  }
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, '.pipeline', 'workflows', 'filesflow.yaml'), WORKFLOW, 'utf8')
  expect(await h.run(['init', 'demo', '--workflow', 'filesflow', '--preset', 'full'], { env: { TENON_USER: USER.id, TENON_USER_NAME: USER.name } }), h.err.join('\n')).toBe(0)
  const paths = testSystemPaths(h.cwd)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.catalog, CATALOG, 'utf8')
  return h
}

async function policyOf(h: Harness): Promise<{ blockers: Array<{ code: string; subject?: string; fix?: string }>; files: { checked: boolean; claimed: Array<{ path: string; suites: string[] }>; orphans: string[] } } | undefined> {
  const snapshot = await buildSnapshot({
    registry: () => [h.cwd], store: createStateStore(), version: '1', clock: () => FIXED, resolveUser: () => USER,
  })
  const change = snapshot.projects[0]?.changes.find((candidate) => candidate.name === 'demo')
  return change?.testPolicy?.find((report) => report.stepId === 'build')
}

describe('快照扫描把 changedFiles 接到策略判定', () => {
  test('新增的测试文件由套件 glob 认领，工作台不再显示 test-file-unregistered；没人认领的显示 test-file-orphan 与一条 --auto 修复命令', async () => {
    const h = await project({ git: true })
    await writeFiles(h.cwd, { 'src/new.test.ts': '// new in this task\n' })
    const claimed = await policyOf(h)
    expect(claimed?.files.checked).toBe(true)
    expect(claimed?.files.claimed).toEqual([{ path: 'src/new.test.ts', suites: ['unit'] }])
    expect(claimed?.files.orphans).toEqual([])
    expect(claimed?.files).not.toHaveProperty('unregistered')
    expect(claimed?.blockers.map((item) => item.code)).not.toContain('test-file-unregistered')
    expect(claimed?.blockers.map((item) => item.code)).not.toContain('test-file-orphan')

    await writeFiles(h.cwd, { 'tools/x.spec.js': '// nobody claims this\n' })
    const orphan = (await policyOf(h))?.blockers.find((item) => item.code === 'test-file-orphan')
    expect(orphan).toMatchObject({ subject: 'tools/x.spec.js' })
    expect(orphan?.fix).toBe('tenon test register demo --auto')
  }, 120_000)

  test('不是 git 仓库：读不到 diff，以 files-diff-unavailable 阻塞，不当作没有改动', async () => {
    const h = await project({ git: false })
    await writeFiles(h.cwd, { 'src/new.test.ts': '// new in this task\n' })
    const policy = await policyOf(h)
    expect(policy?.blockers.map((item) => item.code)).toContain('files-diff-unavailable')
    expect(policy?.files.checked).toBe(false)
  }, 120_000)
})
