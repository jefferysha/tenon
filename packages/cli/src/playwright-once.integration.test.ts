/**
 * 验收审计 F12：Playwright 在一次 verify 里不跑两遍。
 *
 * 根因（v0.2.0 的验收）：frontend 轨道的 Verify 既把目录里的 Playwright 套件放进策略（`run`），又留着内联步骤测试
 * `playwright`（`npx playwright test`），`tenon test run --stage` 与 `tenon test run <c> playwright` 各跑一遍。
 * 内联的 unit / typecheck / playwright / integration 在零豁免默认流程里已经去掉（目录套件取代它们）；这里钉死两件事：
 *   1. 结构：默认工作流任何分支的任何步骤，都没有与目录套件种类重复的内联测试；
 *   2. 行为：frontend 任务走到 verify，目录里有 Playwright 套件时，`--stage` 把它只跑一次，`next` 之后不再要求
 *      `run-tests` / `run-test`，套件命令的执行次数全程为 1。
 * 套件命令是一个计数的假 Playwright（写计数文件和合法的 JSON 报告），零 mock 的是其余一切：真项目、真仓库、真 CLI。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_WORKFLOW_SOURCE, STANDARD_WORKFLOW_SOURCE, parseWorkflow } from '@tenon/kernel'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const CHANGE = 'web'

const FAKE_PLAYWRIGHT = [
  "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
  "mkdirSync('test-results', { recursive: true })",
  "appendFileSync('test-results/pw-count.log', 'run\\n')",
  'const report = {',
  "  config: { rootDir: process.cwd() + '/e2e', projects: [{ name: 'chromium', testDir: process.cwd() + '/e2e' }] },",
  "  suites: [{ title: 'home.spec.js', file: 'home.spec.js', specs: [{",
  "    title: 'home page', file: 'home.spec.js', line: 1,",
  "    tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed', duration: 5, attachments: [] }] }],",
  '  }] }],',
  '}',
  "writeFileSync('test-results/results.json', JSON.stringify(report))",
  '',
].join('\n')

const PROJECT: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "web", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  'src/add.js': 'export const add = (a, b) => a + b\n',
  'test/add.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.js'\ntest('adds', () => { assert.equal(add(1, 2), 3) })\n",
  'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] }\n",
  'e2e/home.spec.js': "// executed by the counting fake runner below\n",
  'fake-playwright.mjs': FAKE_PLAYWRIGHT,
}

/** 冻结计划 / 模板里所有内联步骤测试的 direction。 */
function inlineDirections(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) inlineDirections(item, found)
    return found
  }
  if (typeof value !== 'object' || value === null) return found
  const record = value as Record<string, unknown>
  if (Array.isArray(record.tests)) {
    for (const test of record.tests) {
      const direction = (test as { direction?: unknown }).direction
      if (typeof direction === 'string') found.push(direction)
    }
  }
  for (const item of Object.values(record)) inlineDirections(item, found)
  return found
}

describe('Playwright 一次 verify 只执行一次（审计 F12）', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const text = (): string => `${(h as Harness).out.join('\n')}\n${(h as Harness).err.join('\n')}`
  const executions = async (): Promise<number> => {
    const log = await readFile(join((h as Harness).cwd, 'test-results', 'pw-count.log'), 'utf8').catch(() => '')
    return log.split('\n').filter((line) => line === 'run').length
  }

  test('结构：默认工作流与 standard 没有任何与目录套件种类重复的内联测试（只剩 code-size / design-system / diff-risk 这类探针）', () => {
    const directions = new Set<string>()
    for (const source of [DEFAULT_WORKFLOW_SOURCE, STANDARD_WORKFLOW_SOURCE]) {
      const workflow = parseWorkflow(source)
      const branches = [workflow.steps, ...Object.values(workflow.tracks ?? {}).map((track) => track.steps)]
      for (const steps of branches) for (const step of steps) for (const test of step.tests ?? []) directions.add(test.direction)
    }
    expect([...directions].sort()).toEqual(['code-size', 'design-system', 'diff-risk'])
  })

  test('行为：frontend 任务 verify 里目录 Playwright 套件被 --stage 跑一次，之后 next 不再要求跑，全程执行次数为 1', async () => {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, PROJECT)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await tenon('init', CHANGE, '--track', 'frontend', '--preset', 'full'), text()).toBe(0)
    // 目录里有 Playwright 套件（discover 认出 playwright.config）；命令换成计数的假 Playwright。
    expect(await tenon('test', 'catalog', 'show', '--json'), text()).toBe(0)
    const suites = (JSON.parse(harness.out.join('\n')) as { suites: { id: string; kind: string }[] }).suites
    const playwright = suites.find((suite) => suite.kind === 'playwright')
    expect(playwright, JSON.stringify(suites)).toBeDefined()
    expect(await tenon('test', 'catalog', 'set', playwright?.id ?? 'e2e', '--command', 'node fake-playwright.mjs'), text()).toBe(0)
    expect(await tenon('test', 'plan', CHANGE, '--seed'), text()).toBe(0)
    await harness.seedPhase(CHANGE, 'verify')

    // 冻结计划：verify 的内联测试只有 code-size，没有 playwright / e2e。
    const frozen: unknown = JSON.parse(await readFile(join(harness.cwd, 'openspec', 'changes', CHANGE, '.pipeline-workflow-plan.json'), 'utf8'))
    const directions = inlineDirections(frozen)
    expect(directions).not.toContain('playwright')
    expect(directions).not.toContain('e2e')

    expect(await executions()).toBe(0)
    expect(await tenon('test', 'run', CHANGE, '--stage'), text()).toBe(0)
    expect(await executions()).toBe(1)

    expect(await tenon('status', CHANGE, '--json'), text()).toBe(0)
    const step = JSON.parse(harness.out.join('\n')).step as { tests: { id: string }[]; next: { action: string; test?: string }[] }
    expect(step.tests.map((item) => item.id)).toEqual(['code-size'])
    expect(step.next.filter((action) => action.action === 'run-tests' || (action.action === 'run-test' && action.test !== 'code-size'))).toEqual([])
    expect(await executions(), '读状态不执行套件').toBe(1)

    // 策略层也只认这一次运行：Playwright 套件已通过且新鲜，不再有「没运行」的阻塞。
    await tenon('test', 'status', CHANGE, '--step', 'verify', '--json') // 还有别的阻塞（评审者等）时退出码非 0，只读 JSON
    const report = JSON.parse(harness.out.join('\n')) as { policy?: { blockers: { code: string; subject?: string }[] } }
    const pending = (report.policy?.blockers ?? [])
      .filter((blocker) => (blocker.code === 'test-not-run' || blocker.code === 'test-stale') && !blocker.subject?.startsWith('step:'))
    expect(pending, '目录套件（含 Playwright）都已通过且新鲜；剩下的只有内联探针 code-size').toEqual([])
    expect(await executions()).toBe(1)
  })
})
