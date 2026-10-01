/**
 * Dashboard 快照 × 目录里的项目级「不适用」：策略判定的报告带出 `notApplicable`（种类、原因、是否已批准），
 * 工作台据此把已批准的种类显示成「不适用」、未批准的显示成「待批准」，而不是当作缺种类。
 * 真临时项目、真 CLI 建任务并生成计划、真快照扫描，零 mock。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStateStore, testSystemPaths, type TenonUser } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from '../../cli/src/integration-harness.js'
import { buildSnapshot, scanChangeDetail } from './snapshot.js'

const FIXED = '2026-09-30T10:00:00Z'
const USER: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const ENV = { TENON_USER: USER.id, TENON_USER_NAME: USER.name }
const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: vitest
    command: npx vitest run
    files: ["src/**/*.test.ts"]
    report: { format: junit, path: test-results/unit.xml }
`
const WORKFLOW = `name: naflow
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    test_policy:
      kinds: [unit, playwright]
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

async function project(declaration: string): Promise<Harness> {
  const h = await freshHarness()
  harness = h
  await mkdir(join(h.cwd, 'src'), { recursive: true })
  await writeFile(join(h.cwd, 'src', 'a.test.ts'), '// unit\n', 'utf8')
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, '.pipeline', 'workflows', 'naflow.yaml'), WORKFLOW, 'utf8')
  expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'naflow', '--preset', 'full'], { env: ENV }), h.err.join('\n')).toBe(0)
  const paths = testSystemPaths(h.cwd)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.catalog, `${CATALOG}${declaration}`, 'utf8')
  expect(await h.run(['test', 'plan', 'demo', '--seed'], { env: ENV }), h.err.join('\n')).toBe(0)
  return h
}

function deps(h: Harness) {
  return { registry: () => [h.cwd], store: createStateStore(), version: '1', clock: () => FIXED, resolveUser: () => USER }
}

async function policyOf(h: Harness) {
  const snapshot = await buildSnapshot(deps(h))
  return snapshot.projects[0]?.changes.find((candidate) => candidate.name === 'demo')?.testPolicy?.find((report) => report.stepId === 'build')
}

const kindBlockers = (policy: Awaited<ReturnType<typeof policyOf>>) =>
  (policy?.blockers ?? []).filter((item) => item.subject === 'playwright').map((item) => item.code)

describe('快照里的策略报告带着目录的 not_applicable', () => {
  test('已批准：报告标出 approved，该种类不再产生缺种类阻塞', async () => {
    const h = await project('not_applicable:\n  - { kind: playwright, reason: 本项目没有浏览器界面, approved_by: r@x.io }\n')
    const policy = await policyOf(h)
    expect(policy?.notApplicable).toEqual([{ kind: 'playwright', reason: '本项目没有浏览器界面', approved: true }])
    expect(kindBlockers(policy)).toEqual([])
  }, 120_000)

  test('未批准：报告标出待批准，阻塞是 waiver-unapproved（不是缺种类）', async () => {
    const h = await project('not_applicable:\n  - { kind: playwright, reason: 本项目没有浏览器界面, approved_by: null }\n')
    const policy = await policyOf(h)
    expect(policy?.notApplicable).toEqual([{ kind: 'playwright', reason: '本项目没有浏览器界面', approved: false }])
    expect(kindBlockers(policy)).toEqual(['waiver-unapproved'])
  }, 120_000)

  test('没有声明：notApplicable 为空，缺的种类仍是缺种类阻塞；任务详情读到同一份报告', async () => {
    const h = await project('')
    const policy = await policyOf(h)
    expect(policy?.notApplicable).toEqual([])
    expect(kindBlockers(policy)).toEqual(['test-kind-missing'])
    const detail = await scanChangeDetail(deps(h), h.cwd, 'demo', Date.parse(FIXED))
    expect(detail?.change.testPolicy?.find((report) => report.stepId === 'build')?.notApplicable).toEqual([])
  }, 120_000)
})
