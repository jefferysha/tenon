import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const USER_A = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const USER_B = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }
const SLUG_A = 'a-at-x.io'
const SLUG_B = 'b-at-x.io'

/** build 步骤声明两项必需测试：unit 通过，bad 退出 3；verify 步骤声明一项带必需输出的测试。 */
const TESTED_WF = `name: tested
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: unit
            direction: unit
            command: node -e 'process.exit(0)'
            label: 单测
            timeout_s: 60
          - id: bad
            direction: unit
            command: node -e 'process.exit(Number(process.env.TENON_BAD ?? 3))'
            timeout_s: 60
        guards: []
        transitions:
          - event: build-done
            to: verify
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: report
            direction: playwright
            command: node -e 'process.exit(0)'
            timeout_s: 60
            outputs:
              - path: test-results/junit.xml
                kind: report
                required: true
        guards: []
        transitions: []
`

describe('真实 e2e —— 每步测试登记', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  async function seed(workflow = TESTED_WF): Promise<void> {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'tested.yaml'), workflow, 'utf8')
    expect(await h.run(
      ['init', 'demo', '--track', 'backend', '--workflow', 'tested', '--preset', 'full'],
      { env: USER_A },
    ), h.err.join('\n')).toBe(0)
  }

  async function runIds(slug: string): Promise<string[]> {
    try {
      return (await readdir(join(h.cwd, '.tenon', 'users', slug, 'tests', 'demo'))).sort()
    } catch {
      return []
    }
  }

  async function record(slug: string, runId: string): Promise<Record<string, unknown>> {
    const raw = await readFile(join(h.cwd, '.tenon', 'users', slug, 'tests', 'demo', runId), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  }

  test('通过的测试 exit 0 并在当前用户目录下落一条记录，日志可读', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A }), h.err.join('\n')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain('[TEST] demo unit run=')
    expect(text).toContain('result: pass exit=0')
    expect(text).toContain('.tenon/users/a-at-x.io/tests/demo/')

    const ids = await runIds(SLUG_A)
    expect(ids).toHaveLength(1)
    const stored = await record(SLUG_A, ids[0] ?? '')
    expect(stored).toMatchObject({
      schema: 'tenon-test-run-v1', change: 'demo', test_id: 'unit', direction: 'unit', label: '单测',
      step: 'build', track: 'backend', required: true, result: 'pass', exit_code: 0, reasons: [],
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' },
    })
    // 尚未冻结构建版本时是 JSON null，不是 state 里的字面 'null' 字符串。
    expect(stored.build_sha).toBeNull()
    expect(String(stored.candidate)).toMatch(/^workspace:sha256:[a-f0-9]{64}$/u)
    expect(String(stored.test_digest)).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const runId = String(stored.run_id)
    const log = join(h.cwd, '.tenon', 'users', SLUG_A, 'local', 'artifacts', 'demo', runId, 'output.log')
    expect(await readFile(log, 'utf8')).toBe('')
  })

  test('失败的测试 exit 2 并记录退出码原因', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A })).toBe(2)
    expect(h.out.join('\n')).toContain('result: fail exit=3')
    const ids = await runIds(SLUG_A)
    const stored = await record(SLUG_A, ids[0] ?? '')
    expect(stored.result).toBe('fail')
    expect(stored.exit_code).toBe(3)
    expect(stored.reasons).toEqual([{ code: 'exit-code', detail: '退出码 3，期望 0' }])
  })

  test('未声明的测试 id 报可选项；--json 输出记录全文与路径', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'nope'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain("未声明的测试 'nope'；可选：unit, bad, report")

    expect(await h.run(['test', 'run', 'demo', 'unit', '--json'], { env: USER_A }), h.err.join('\n')).toBe(0)
    const json = JSON.parse(h.out.join('\n')) as Record<string, unknown>
    expect(json.test_id).toBe('unit')
    expect(String(json.record_path).startsWith('.tenon/users/a-at-x.io/tests/demo/')).toBe(true)
    expect(String(json.log_path)).toContain('/local/artifacts/demo/')
  })

  test('必需输出缺失判失败；产出后通过并登记输出摘要与副本', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'report'], { env: USER_A })).toBe(2)
    const missingIds = await runIds(SLUG_A)
    let stored = await record(SLUG_A, missingIds[0] ?? '')
    expect(stored.reasons).toEqual([{ code: 'output-missing', detail: 'test-results/junit.xml' }])

    await mkdir(join(h.cwd, 'test-results'), { recursive: true })
    await writeFile(join(h.cwd, 'test-results', 'junit.xml'), '<testsuite/>', 'utf8')
    expect(await h.run(['test', 'run', 'demo', 'report'], { env: USER_A }), h.err.join('\n')).toBe(0)
    const ids = await runIds(SLUG_A)
    expect(ids).toHaveLength(2)
    stored = await record(SLUG_A, ids.find((id) => !missingIds.includes(id)) ?? '')
    expect(stored.result).toBe('pass')
    expect(stored.outputs).toMatchObject([{
      path: 'test-results/junit.xml', kind: 'report', required: true, present: true, files: 1,
      artifact: 'outputs/test-results/junit.xml',
    }])
    const copy = join(
      h.cwd, '.tenon', 'users', SLUG_A, 'local', 'artifacts', 'demo', String(stored.run_id),
      'outputs', 'test-results', 'junit.xml',
    )
    expect(await readFile(copy, 'utf8')).toBe('<testsuite/>')
  })

  test('另一个用户在同一仓库执行 → 记录分别落在各自目录，互不覆盖', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect(await h.run(['owner', 'take', 'demo'], { env: USER_B }), h.err.join('\n')).toBe(0)
    expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_B }), h.err.join('\n')).toBe(0)
    expect(await runIds(SLUG_A)).toHaveLength(1)
    expect(await runIds(SLUG_B)).toHaveLength(1)
    expect((await record(SLUG_B, (await runIds(SLUG_B))[0] ?? '')).actor).toEqual({
      id: 'b@x.io', name: 'B', trust: 'declared',
    })
  })

  test('非负责人被拒；身份缺失被拒；两种情况都不落记录', async () => {
    await seed()
    expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_B })).toBe(1)
    expect(h.err.join('\n')).toContain('先接手：tenon owner take demo')
    expect(await h.run(['test', 'run', 'demo', 'unit'], {
      // CI 上开发者身份不存在，本机上存在；三条来源全部中和，两边都走「身份缺失」这条路。
      env: {
        TENON_USER: undefined, TENON_USER_NAME: undefined, HOME: h.cwd,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      },
    })).toBe(1)
    expect(await runIds(SLUG_A)).toEqual([])
  })

  test('同一用户同一测试并发运行被运行中标记拦截', async () => {
    await seed()
    const marker = join(h.cwd, '.tenon', 'users', SLUG_A, 'local', 'running', 'demo')
    await mkdir(marker, { recursive: true })
    await writeFile(join(marker, 'unit.json'), JSON.stringify({
      run_id: '20990101T000000Z-abcdef',
      pid: process.pid,
      started_at: '2099-01-01T00:00:00Z',
      deadline_at: '2099-01-01T00:10:00Z',
    }), 'utf8')
    expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain("测试 'unit' 正在运行（run 20990101T000000Z-abcdef")
    expect(await runIds(SLUG_A)).toEqual([])
  })

  test('工作目录非法时不启动进程，记 cwd-invalid', async () => {
    await seed(TESTED_WF.replace("            label: 单测\n", "            cwd: nope\n"))
    expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })).toBe(2)
    const stored = await record(SLUG_A, (await runIds(SLUG_A))[0] ?? '')
    expect(stored.reasons).toEqual([{ code: 'cwd-invalid', detail: 'nope' }])
    expect(stored.exit_code).toBeNull()
  })

  /** 基准测试项：指标从 stdout 最后一行 JSON 读，声明相对基线的退化上限。 */
  const BENCH_WF = TESTED_WF.replace(`          - id: bad
            direction: unit
            command: node -e 'process.exit(Number(process.env.TENON_BAD ?? 3))'
            timeout_s: 60
`, `          - id: bench
            direction: benchmark
            command: node -e 'console.log(JSON.stringify({ p95_ms: Number(process.env.TENON_BENCH ?? 100) }))'
            timeout_s: 60
            pass:
              metrics:
                - name: p95_ms
                  max_regression_pct: 10
                  better: lower
`)

  test('status 的文本与 JSON：未运行 → 通过 → 过期', async () => {
    await seed()
    expect(await h.run(['test', 'status', 'demo'], { env: USER_A })).toBe(2)
    expect(h.out.join('\n')).toContain('[TEST] demo step=build')
    expect(h.out.join('\n')).toContain('未运行 unit 单测')
    expect(h.out.join('\n')).toContain('[FAIL] test: 测试 单测（unit）未运行')

    await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })
    await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A })
    expect(await h.run(['test', 'status', 'demo', '--json'], { env: USER_A })).toBe(2)
    const report = JSON.parse(h.out.join('\n')) as {
      change: string
      step: string
      pass: boolean
      items: { id: string; status: string; required: boolean; run?: { result: string; reasons: string[] } }[]
      blockers: string[]
    }
    expect(report).toMatchObject({ change: 'demo', step: 'build', pass: false })
    expect(report.items.map((item) => [item.id, item.status])).toEqual([['unit', 'passed'], ['bad', 'failed']])
    expect(report.items[1]?.run?.reasons).toEqual(['exit-code'])
    expect(report.blockers).toHaveLength(1)

    await writeFile(join(h.cwd, 'source.ts'), 'export const a = 1\n', 'utf8')
    expect(await h.run(['test', 'status', 'demo', '--json'], { env: USER_A })).toBe(2)
    const stale = JSON.parse(h.out.join('\n')) as { items: { id: string; status: string }[] }
    expect(stale.items.map((item) => item.status)).toEqual(['stale', 'stale'])
  })

  test('基准：登记基线后退化超阈值判失败，记录里带基线与差异', async () => {
    await seed(BENCH_WF)
    process.env.TENON_BENCH = '100'
    expect(await h.run(['test', 'run', 'demo', 'bench'], { env: USER_A }), h.err.join('\n')).toBe(0)
    const first = (await runIds(SLUG_A))[0] ?? ''
    const baseRecord = await record(SLUG_A, first)
    expect(baseRecord.metrics).toMatchObject([{ name: 'p95_ms', value: 100, baseline: null, ok: true }])
    expect(baseRecord.reasons).toEqual([{ code: 'baseline-missing', detail: "指标 'p95_ms' 没有基线" }])

    expect(await h.run(['test', 'baseline', 'demo', 'bench', '--run', first.replace('.json', '')], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('[BASELINE] bench 1 项指标 ← run ')
    const previous = await runIds(SLUG_A)

    // 固定时钟下 run-id 只靠随机后缀区分，所以按内容找这次的记录，不按文件名排序。
    process.env.TENON_BENCH = '130'
    expect(await h.run(['test', 'run', 'demo', 'bench'], { env: USER_A })).toBe(2)
    const after = await runIds(SLUG_A)
    const worseId = after.find((id) => !previous.includes(id)) ?? ''
    const worse = await record(SLUG_A, worseId)
    expect(worse.result).toBe('fail')
    expect(worse.metrics).toMatchObject([{ name: 'p95_ms', value: 130, baseline: 100, delta_pct: 30, ok: false }])
    expect(worse.reasons).toEqual([{
      code: 'metric-regression', detail: "指标 'p95_ms' 相对基线退化 30.00%，上限 10%",
    }])

    process.env.TENON_BENCH = '105'
    expect(await h.run(['test', 'run', 'demo', 'bench'], { env: USER_A }), h.err.join('\n')).toBe(0)
    delete process.env.TENON_BENCH
  })

  test('report 生成测试段：--write 幂等替换，缺区间时追加一节', async () => {
    await seed()
    await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })
    expect(await h.run(['test', 'report', 'demo'], { env: USER_A }), h.err.join('\n')).toBe(0)
    const region = h.out.join('\n')
    expect(region).toContain('<!-- tenon:tests:start digest=sha256:')
    expect(region).toContain('| 实现 | 单测 `unit` | unit | 通过 | 0 |')

    await writeFile(join(h.cwd, 'report.md'), '# 验证报告\n\n结论：通过\n', 'utf8')
    expect(await h.run(['test', 'report', 'demo', '--write', 'report.md'], { env: USER_A }), h.err.join('\n')).toBe(0)
    const once = await readFile(join(h.cwd, 'report.md'), 'utf8')
    expect(once).toContain('## 测试')
    expect(await h.run(['test', 'report', 'demo', '--write', 'report.md'], { env: USER_A })).toBe(0)
    const twice = await readFile(join(h.cwd, 'report.md'), 'utf8')
    expect(twice.split('<!-- tenon:tests:start')).toHaveLength(2)

    expect(await h.run(['test', 'report', 'demo', '--locale', 'en'], { env: USER_A })).toBe(0)
    expect(h.out.join('\n')).toContain('| Step | Test | Direction | Status |')
    expect(await h.run(['test', 'report', 'demo', '--write', 'missing.md'], { env: USER_A })).toBe(1)
  })

  test('保留策略：7 次运行只留最近 5 个产物目录，摘要全留', async () => {
    await seed(TESTED_WF.replace('            label: 单测', '            keep_runs: 5'))
    for (let index = 0; index < 7; index++) {
      expect(await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A }), h.err.join('\n')).toBe(0)
    }
    const summaries = await runIds(SLUG_A)
    expect(summaries).toHaveLength(7)
    const artifacts = (await readdir(join(h.cwd, '.tenon', 'users', SLUG_A, 'local', 'artifacts', 'demo'))).sort()
    expect(artifacts).toHaveLength(5)
    const kept = new Set(summaries.map((name) => name.replace('.json', '')))
    expect(artifacts.every((runId) => kept.has(runId))).toBe(true)
  })

  test('code-size 在非 git 项目里明确报错（git 行为由单测覆盖）', async () => {
    await seed()
    expect(await h.run(['test', 'code-size'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain('无法读取 git 规模信息（base=HEAD）')
  })

  test('必需测试未通过时转换被拦截，check 同步报告；全部通过后放行', async () => {
    await seed()
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain('ERROR: 测试证据未通过（step=build）：')
    expect(h.err.join('\n')).toContain('测试 单测（unit）未运行')
    expect(h.err.join('\n')).toContain('测试 bad（bad）未运行')
    expect(await h.read('demo')).toMatch(/^phase: build$/mu)

    expect(await h.run(['check', 'demo'], { env: USER_A })).toBe(2)
    expect(h.out.join('\n')).toContain('[FAIL] test: 测试 单测（unit）未运行')

    await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })
    expect(await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A })).toBe(2)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain('测试 bad（bad）失败：exit-code')

    process.env.TENON_BAD = '0'
    expect(await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A }), h.err.join('\n')).toBe(0)
    delete process.env.TENON_BAD
    expect(await h.run(['check', 'demo'], { env: USER_A }), h.out.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: verify$/mu)
  })

  test('改代码后已通过的结果过期并再次拦截，重跑后放行', async () => {
    await seed()
    process.env.TENON_BAD = '0'
    await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })
    await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A })
    await writeFile(join(h.cwd, 'src.ts'), 'export const a = 1\n', 'utf8')
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A })).toBe(1)
    expect(h.err.join('\n')).toContain('过期：代码已变化')

    await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })
    await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A })
    delete process.env.TENON_BAD
    expect(await h.run(['transition', 'demo', 'build-done'], { env: USER_A }), h.err.join('\n')).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: verify$/mu)
  })

  test('review request 在必需测试未通过时被拦截且不写 review marker', async () => {
    await seed(TESTED_WF.replace('        label: 实现\n        gate: null', '        label: 实现\n        gate: review'))
    await h.run(['test', 'run', 'demo', 'unit'], { env: USER_A })
    await h.run(['test', 'run', 'demo', 'bad'], { env: USER_A })
    expect(await h.run(['review', 'request', 'demo', '--event', 'build-done'], { env: USER_A })).not.toBe(0)
    expect(`${h.out.join('\n')}\n${h.err.join('\n')}`).toContain('测试 bad（bad）失败')
    await expect(readFile(join(h.cwd, '.pipeline-pending-review'), 'utf8')).rejects.toThrow()
  })
})
