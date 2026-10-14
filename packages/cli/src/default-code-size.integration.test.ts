import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyTestPlan, readTestPlanState, type TestPlan } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, REPO_ROOT, rm, type Harness } from './integration-harness.js'
import { commitAll, initGit } from './integration-harness-tests.js'

interface FrozenTest { readonly id: string; readonly pass?: { readonly metrics?: readonly { readonly name: string; readonly max?: number }[] } }

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_TICKING_CLOCK: '1' }
const NEW_LINES = 5000
const LIMITED = 'limited'

interface RunRecord {
  readonly result: string
  readonly reasons: readonly { readonly code: string; readonly detail?: string }[]
  readonly metrics: readonly { readonly name: string; readonly value: number | null }[]
  readonly record_path: string
}

/** 冻结计划里逐步骤的内联测试（不同快照版本把它放在 steps 或 tracks 分支里，这里只按结构找）。 */
function inlineTests(value: unknown, found: FrozenTest[] = []): FrozenTest[] {
  if (Array.isArray(value)) {
    for (const item of value) inlineTests(item, found)
    return found
  }
  if (typeof value !== 'object' || value === null) return found
  const record = value as Record<string, unknown>
  if (record.direction === 'code-size' && typeof record.id === 'string') found.push(record as unknown as FrozenTest)
  for (const item of Object.values(record)) inlineTests(item, found)
  return found
}

describe('默认工作流的 code-size 没有缺省上限（simplify-test-settings，取代真机验收 F11 的 2000 行阈值）', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  test('新建 default 任务的冻结计划里 code-size 不带任何指标门槛', async () => {
    h = await freshHarness()
    expect(await h.run(['init', 'sized', '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
    const plan: unknown = JSON.parse(await readFile(join(h.cwd, 'openspec', 'changes', 'sized', '.pipeline-workflow-plan.json'), 'utf8'))
    const tests = inlineTests(plan)
    expect(tests.length).toBeGreaterThan(0)
    for (const test of tests) expect(test.pass?.metrics ?? [], test.id).toEqual([])
  })
})

describe('code-size 在真 git 仓库里统计 5000 行新增（harness 默认的通过桩换成真探针）', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  /** default 模板原文，只在 backend 轨道（模板里最后一条轨道）验证步的 code-size 测试下写回 pass.metrics。 */
  async function limitedWorkflow(): Promise<string> {
    const source = await readFile(join(REPO_ROOT, 'templates', 'workflows', 'default.yaml'), 'utf8')
    const backendAt = source.indexOf('\n  backend:\n')
    expect(backendAt, 'default.yaml 里找不到 backend 轨道').toBeGreaterThan(0)
    const probe = '            label: 代码规模\n            timeout_s: 120\n            required: true\n'
    const limit = '            pass:\n              metrics:\n                - name: lines_added\n                  max: 3000\n'
    const backend = source.slice(backendAt)
    expect(backend.split(probe), 'backend 轨道应恰有一条 code-size 测试').toHaveLength(2)
    return `${source.slice(0, backendAt).replace('name: default\n', `name: ${LIMITED}\n`)}${backend.replace(probe, `${probe}${limit}`)}`
  }

  /** 基线提交后立后端任务、再新增 5000 行源码文件（每行一条语句）。给了 `workflow` 就用项目工作流。 */
  async function sizedChange(options: { readonly workflow?: string } = {}): Promise<void> {
    h = await freshHarness()
    initGit(h.cwd)
    commitAll(h.cwd, 'base', '2026-01-01T00:00:00Z')
    if (options.workflow !== undefined) {
      await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
      await writeFile(join(h.cwd, '.pipeline', 'workflows', `${LIMITED}.yaml`), options.workflow, 'utf8')
    }
    const workflowArgs = options.workflow === undefined ? [] : ['--workflow', LIMITED]
    expect(await h.run(['init', 'sized', ...workflowArgs, '--track', 'backend', '--preset', 'full'], { env: USER }), h.err.join('\n')).toBe(0)
    await mkdir(join(h.cwd, 'src'), { recursive: true })
    const big = Array.from({ length: NEW_LINES }, (_, index) => `export const value${index} = ${index}\n`).join('')
    await writeFile(join(h.cwd, 'src', 'big.ts'), big, 'utf8')
  }

  /** 运行验证步的 code-size 测试。子进程继承本进程环境，所以开关要设在 process.env 上。 */
  async function runCodeSize(): Promise<{ readonly code: number; readonly record: RunRecord }> {
    const previous = process.env.TENON_TEST_REAL_CODE_SIZE
    process.env.TENON_TEST_REAL_CODE_SIZE = '1'
    try {
      const code = await h.run(['test', 'run', 'sized', 'code-size', '--json'], { env: USER })
      return { code, record: JSON.parse(h.out.join('\n')) as RunRecord }
    } finally {
      if (previous === undefined) delete process.env.TENON_TEST_REAL_CODE_SIZE
      else process.env.TENON_TEST_REAL_CODE_SIZE = previous
    }
  }

  const linesAdded = (record: RunRecord): number | null | undefined => record.metrics.find((metric) => metric.name === 'lines_added')?.value

  async function waivers(): Promise<TestPlan['waivers']> {
    const state = await readTestPlanState(join(h.cwd, 'openspec', 'changes', 'sized'), 'sized')
    return (state.state === 'ok' ? state.plan : emptyTestPlan('sized')).waivers
  }

  test('后端任务新增 5000 行：验证步 code-size 以退出码 0 通过，没有豁免也没有 metric-threshold（大改动不被代码规模挡住）', async () => {
    await sizedChange()
    const { code, record } = await runCodeSize()
    expect(code, `${h.err.join('\n')}\n${JSON.stringify(record)}`).toBe(0)
    expect(record.result).toBe('pass')
    expect(record.reasons).toEqual([])
    expect(await waivers()).toEqual([])
  }, 120_000)

  test('后端任务新增 5000 行：code-size 的运行记录里有 lines_added（落盘的记录与命令输出一致）', async () => {
    await sizedChange()
    const { record } = await runCodeSize()
    // 口径：真探针数的是整个工作区里的代码文件，所以是下界；5000 行全部来自 src/big.ts。
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: 'lines_added', value: expect.any(Number) }))
    expect(linesAdded(record)).toBeGreaterThanOrEqual(NEW_LINES)
    const stored = JSON.parse(await readFile(join(h.cwd, record.record_path), 'utf8')) as RunRecord
    expect(linesAdded(stored)).toBe(linesAdded(record))
  }, 120_000)

  test('项目工作流给 code-size 写回 pass.metrics（lines_added 上限 3000）：同样新增 5000 行就失败，原因 metric-threshold（按需启用上限）', async () => {
    await sizedChange({ workflow: await limitedWorkflow() })
    const { code, record } = await runCodeSize()
    expect(code, `${h.err.join('\n')}\n${JSON.stringify(record)}`).toBe(2)
    expect(record.result).toBe('fail')
    const threshold = record.reasons.find((reason) => reason.code === 'metric-threshold')
    expect(threshold?.detail).toContain('lines_added')
    expect(threshold?.detail).toContain('3000')
    expect(linesAdded(record)).toBeGreaterThanOrEqual(NEW_LINES)
    expect(await waivers()).toEqual([])
  }, 120_000)
})

/** 两条测试输出同一行 JSON、都没有门槛，只有方向不同。 */
const PROBE_OUTPUT = '{"lines_added":7}'
const NO_LIMIT_WORKFLOW = `name: nolimit
tracks:
  backend:
    steps:
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: plain
            direction: unit
            command: echo '${PROBE_OUTPUT}'
            label: 普通
            timeout_s: 60
          - id: sized
            direction: code-size
            command: echo '${PROBE_OUTPUT}'
            label: 规模
            timeout_s: 60
        guards: []
        transitions:
          - event: verify-done
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

describe('没有门槛时哪些测试把指标记进运行记录', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  async function runTest(testId: string): Promise<RunRecord> {
    expect(await h.run(['test', 'run', 'nolimit-change', testId, '--json'], { env: USER }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)
    return JSON.parse(h.out.join('\n')) as RunRecord
  }

  async function seed(): Promise<void> {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'nolimit.yaml'), NO_LIMIT_WORKFLOW, 'utf8')
    expect(await h.run(['init', 'nolimit-change', '--track', 'backend', '--workflow', 'nolimit', '--preset', 'full'], { env: USER }), h.err.join('\n')).toBe(0)
  }

  test('code-size 方向：没有门槛也读探针输出的指标，运行记录里有值且通过', async () => {
    await seed()
    const record = await runTest('sized')
    expect(record.result).toBe('pass')
    expect(record.reasons).toEqual([])
    expect(record.metrics).toEqual([expect.objectContaining({ name: 'lines_added', value: 7, ok: true })])
  })

  test('其他方向：没有门槛、没有 metrics_path 就不读输出里的 JSON，运行记录的指标为空', async () => {
    await seed()
    const record = await runTest('plain')
    expect(record.result).toBe('pass')
    expect(record.metrics).toEqual([])
  })
})
