/**
 * 测试证据可信根的端到端场景（v0.3 evidence-trust）：克隆来的仓库首次执行要用户信任、伪造报告、伪造记录、
 * 已知失败自助白名单、基线改写、指纹藏文件。
 * 每个场景都走真的 buildProgram 与真落盘的记录、封存文件和临时 git 仓库；套件命令是项目里一小段 node 脚本，
 * 按 mode.txt / bench.txt 的内容产出报告，所以不依赖任何测试框架。
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeTestRunRecordV2, recordV2Digest, type TestRunRecordV2 } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
/** 关掉测试装配默认的「已信任」：像刚克隆下来的仓库一样，用户还没确认过里面的命令。 */
const UNTRUSTED = { ...USER, TENON_TEST_TRUST: '' }
const SLUG = 'a-at-x.io'
const SESSION = 'session-trust'
/** 滴答时钟从 FIXED_CLOCK 起每读一次走一秒；回执要晚于步骤访问的进入时间。 */
const RECEIPT_AT = new Date(Date.parse(FIXED_CLOCK) + 3_600_000).toISOString()
const KNOWN_PATH = '.tenon/tests/known-failures.yaml'
const CATALOG_PATH = '.tenon/tests/catalog.yaml'

const WORKFLOW = `name: trusted
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: review
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          run: [unit, benchmark]
          scope: full
        transitions:
          - event: build-done
            to: verify
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

function catalog(command = 'node gen-report.mjs', label = '单测'): string {
  return `schema: tenon-test-catalog/v1
suites:
  - id: unit
    label: ${label}
    kind: unit
    runner: custom
    command: ${command}
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
  - id: bench
    kind: benchmark
    runner: custom
    command: node gen-bench.mjs
    report: { format: benchmark-json, path: test-results/bench.json }
    artifacts: [test-results/bench.json]
    benchmark:
      runs: 1
      warmup: 0
      metrics:
        - { name: p95_ms, better: lower, max_regression_pct: 10, max: 250 }
`
}

const GEN_REPORT = `import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
const mode = readFileSync('mode.txt', 'utf8').trim()
const bad = mode === 'known'
mkdirSync('test-results', { recursive: true })
const failure = bad ? '<failure message="boom">boom</failure>' : ''
writeFileSync('test-results/unit.xml', '<?xml version="1.0"?><testsuites><testsuite name="t" tests="2" failures="' + (bad ? 1 : 0) + '">'
  + '<testcase name="good" classname="t" file="src/a.test.js"/><testcase name="bad" classname="t" file="src/a.test.js">' + failure + '</testcase></testsuite></testsuites>')
if (mode === 'stale') {
  const old = new Date(Date.now() - 2 * 86_400_000)
  utimesSync('test-results/unit.xml', old, old)
}
process.exit(bad ? 1 : 0)
`

const GEN_BENCH = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/bench.json', JSON.stringify({ metrics: { p95_ms: [Number(readFileSync('bench.txt', 'utf8'))] } }))
`

interface PolicyJson {
  pass: boolean
  blockers: string[]
  policy?: { blockers: Array<{ code: string; blocking: boolean; message: string; fix?: string; subject?: string }> }
}

describe('测试证据可信根', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  /** 仓库已提交：目录、工作流、脚本；任务在提交之后创建，所以「本任务 diff」起点干净。 */
  async function project(): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      '.gitignore': 'test-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n',
      'mode.txt': 'pass\n',
      'bench.txt': '100\n',
      'gen-report.mjs': GEN_REPORT,
      'gen-bench.mjs': GEN_BENCH,
      'src/a.test.js': 'export {}\n',
      '.tenon/tests/catalog.yaml': catalog(),
      '.pipeline/workflows/trusted.yaml': WORKFLOW,
    })
    git(harness.cwd, ['init', '-q', '-b', 'main'])
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    return harness
  }

  const tenon = (env: Record<string, string>, ...args: string[]): Promise<number> => (h as Harness).run(args, { env })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  const recordsDir = (): string => join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo')

  /** 像宿主那样加载 tenon skill：历史里有 Skill 工具行，再留回执；之后 `step.next` 才会走到评审门。 */
  async function loadTenonSkill(): Promise<void> {
    await appendFile(join(cwd(), 'openspec/changes/demo/.pipeline-history.jsonl'), `${JSON.stringify({ ts: RECEIPT_AT, kind: 'tool', raw: 'Skill: tenon' })}\n`, 'utf8')
    expect(await tenon(USER, 'internal-native-skill-receipt', 'demo', 'tenon', 'trust-session', 'tool-1', RECEIPT_AT), err()).toBe(0)
  }

  async function status(step = 'build'): Promise<{ code: number; json: PolicyJson }> {
    const code = await tenon(USER, 'test', 'status', 'demo', '--step', step, '--json')
    return { code, json: JSON.parse(out()) as PolicyJson }
  }
  const codes = (json: PolicyJson): string[] => (json.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)

  async function registerBoth(): Promise<void> {
    expect(await tenon(USER, 'test', 'register', 'demo', '--suite', 'unit'), err()).toBe(0)
    expect(await tenon(USER, 'test', 'register', 'demo', '--suite', 'bench'), err()).toBe(0)
  }

  type Stored = TestRunRecordV2 & { suites: Array<{ reasons: Array<{ code: string }> }> }
  async function allRecords(): Promise<Stored[]> {
    const files = (await readdir(recordsDir())).filter((name) => name.endsWith('.json')).sort()
    return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(recordsDir(), file), 'utf8')) as Stored))
  }
  /** 最近一次 `tenon test run` 写的记录（伪造的记录时间在 2099，按链序取链尾不可靠，所以取写得最晚的本机运行）。 */
  async function lastRecord(): Promise<Stored> {
    const records = (await allRecords()).filter((record) => record.finished_at < '2090')
    return records.sort((left, right) => (left.finished_at < right.finished_at ? -1 : 1)).at(-1) as Stored
  }

  test('R6 克隆来的仓库：首次执行目录里的命令要用户在本机确认；命令改了再问，标签改了不问；CI 显式信任放行', async () => {
    await project()
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('还没有得到你的信任')
    expect(err()).toContain('node gen-report.mjs')
    expect(err()).toContain('tenon test trust demo')
    expect(existsSync(recordsDir())).toBe(false)
    expect(existsSync(join(cwd(), 'test-results'))).toBe(false)

    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)
    expect(out()).toContain('未信任')
    // 非交互又没有 --yes：不替人确认。
    expect(await tenon(UNTRUSTED, 'test', 'trust')).toBe(1)
    expect(err()).toContain('信任需要你本人确认')
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)

    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    expect(out()).toContain('node gen-report.mjs')
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit'), `${out()}\n${err()}`).toBe(0)

    // 只改标签：可执行文字没变，信任仍然有效。
    await writeFile(join(cwd(), '.tenon/tests/catalog.yaml'), catalog('node gen-report.mjs', '新名字'), 'utf8')
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit'), err()).toBe(0)
    // 命令变了：摘要变了，要重新确认，什么都不会执行。
    await writeFile(join(cwd(), '.tenon/tests/catalog.yaml'), catalog('node gen-report.mjs --quiet'), 'utf8')
    const before = (await readdir(recordsDir())).length
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('node gen-report.mjs --quiet')
    expect((await readdir(recordsDir())).length).toBe(before)
    // CI：运行器显式设置环境变量；每次运行在 stderr 留一行说明。
    expect(await tenon({ ...USER, TENON_TEST_TRUST: '1' }, 'test', 'run', 'demo', '--suite', 'unit'), err()).toBe(0)
    expect(err()).toContain('TENON_TEST_TRUST=1')
    // 只有字面 1 才算。
    expect(await tenon({ ...USER, TENON_TEST_TRUST: 'true' }, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
  }, 120_000)

  test('R2 伪造报告：命令把旧文件回填进来（mtime 早于运行开始）→ report-untrusted，门禁挡住', async () => {
    await project()
    await registerBoth()
    await writeFile(join(cwd(), 'mode.txt'), 'stale\n', 'utf8')
    expect(await tenon(USER, 'test', 'run', 'demo', '--suite', 'unit')).toBe(2)
    expect(out()).toContain('report-untrusted')
    expect(out()).toContain('早于本次运行开始')
    // 磁盘上是上一个发行版读得了的写法（report-unreadable + detail 前缀）；读盘解码后还原成 report-untrusted，判定不变。
    const stored = await lastRecord()
    expect(stored.suites[0]?.reasons).toEqual([expect.objectContaining({ code: 'report-unreadable', detail: expect.stringMatching(/^\[report-untrusted\] /u) })])
    expect(decodeTestRunRecordV2(stored)?.suites[0]?.reasons.map((reason) => reason.code)).toContain('report-untrusted')
    const current = await status()
    expect(current.code).toBe(2)
    expect(codes(current.json)).toContain('report-untrusted')

    // 诚实地重跑（报告是这次生成的，产物目录里有同摘要的副本）就放行。
    await writeFile(join(cwd(), 'mode.txt'), 'pass\n', 'utf8')
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(codes((await status()).json)).not.toContain('report-untrusted')
  }, 120_000)

  test('R4 伪造记录：绕开命令补写一条重算过摘要的记录 → record-unsealed（无人工出口）；再跑一次命令另起新链取代它', async () => {
    await project()
    await registerBoth()
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect((await status()).code).toBe(0)

    const files = (await readdir(recordsDir())).filter((name) => name.endsWith('.json')).sort()
    const last = JSON.parse(await readFile(join(recordsDir(), files.at(-1) ?? ''), 'utf8')) as TestRunRecordV2
    const { digest: _digest, ...body } = { ...last, run_id: '20990101T000000Z-ffffff', prev_digest: last.digest, finished_at: '2099-01-01T00:00:00Z' }
    const forged = { ...body, digest: recordV2Digest(body as Omit<TestRunRecordV2, 'digest'>) }
    await writeFile(join(recordsDir(), `${forged.run_id}.json`), JSON.stringify(forged, null, 2), 'utf8')

    const current = await status()
    expect(current.code).toBe(2)
    expect(codes(current.json)).toContain('record-unsealed')
    expect(current.json.policy?.blockers.find((item) => item.code === 'record-unsealed')?.fix).toBe('tenon test run demo --stage')
    expect(await tenon(USER, 'transition', 'demo', 'build-done')).not.toBe(0)

    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), err()).toBe(0)
    expect(out()).toContain('来源不明')
    expect((await allRecords()).find((record) => record.chain_reset !== undefined)?.chain_reset?.superseded).toContain(`${forged.run_id}.json`)
    expect(codes((await status()).json)).not.toContain('record-unsealed')
  }, 120_000)

  test('R1/R3 已知失败自助白名单：只写文件、超过 30 天都拒；新增条目在评审门等人确认，确认绑定内容，事后改动重新挡', async () => {
    await project()
    await registerBoth()
    await writeFile(join(cwd(), 'mode.txt'), 'known\n', 'utf8')
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage')).toBe(2)

    expect(await tenon(USER, 'test', 'known', 'add', '--suite', 'unit', '--test', 'src/a.test.js', '--reason', 'r', '--expires', '2026-07-20')).toBe(1)
    expect(err()).toContain('只指向文件')
    expect(await tenon(USER, 'test', 'known', 'add', '--suite', 'unit', '--test', 'src/a.test.js › bad', '--reason', 'r', '--expires', '2099-01-01')).toBe(1)
    expect(err()).toContain('最长 30 天')
    expect(existsSync(join(cwd(), KNOWN_PATH))).toBe(false)

    expect(await tenon(USER, 'test', 'known', 'add', '--suite', 'unit', '--test', 'src/a.test.js › bad', '--reason', '等上游修复', '--expires', '2026-07-20'), err()).toBe(0)
    expect(out()).toContain('评审门确认')
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)

    // 新增的条目出现在任务 diff 里：评审门挡住，直到用户确认。
    let current = await status()
    expect(codes(current.json)).toEqual(['protected-file-unapproved'])
    expect(current.json.policy?.blockers[0]).toMatchObject({ subject: KNOWN_PATH, fix: 'tenon review request demo --event build-done' })

    expect(await tenon(USER, 'session', 'activate', 'demo', '--continuous', '--host-session', SESSION), err()).toBe(0)
    await loadTenonSkill()

    // `tenon status` 的下一步：评审门上只剩待确认的配置改动时，下发 request-review（把它们连同摘要展示给用户），而不是回退或 fix。
    expect(await tenon(USER, 'status', 'demo', '--json'), err()).toBe(0)
    const next = (JSON.parse(out()) as { step: { next: Array<{ action: string; event?: string; waivers?: string[] }> } }).step.next
    expect(next).toEqual([expect.objectContaining({ action: 'request-review', event: 'build-done', waivers: [KNOWN_PATH] })])

    expect(await tenon(USER, 'review', 'request', 'demo', '--event', 'build-done'), err()).toBe(0)
    expect(out()).toContain('待确认的测试配置改动 1 项')
    expect(out()).toContain('新增已知失败 unit / src/a.test.js › bad（到期 2026-07-20；等上游修复）')
    // 委托确认（持续授权）不批准测试配置改动。
    expect(await tenon({ ...USER, TENON_HOST_SESSION_ID: SESSION }, 'review', 'acknowledge', 'demo', '--delegated')).toBe(1)
    expect(err()).toContain('委托确认不批准测试配置改动')
    expect(codes((await status()).json)).toEqual(['protected-file-unapproved'])

    expect(await tenon(USER, 'review', 'acknowledge', 'demo'), err()).toBe(0)
    expect(out()).toContain('已批准测试配置改动 1 项')
    current = await status()
    expect(current.code, JSON.stringify(current.json.policy?.blockers)).toBe(0)

    // 批准绑定的是内容：事后多塞一条，哪怕是手改也重新挡，并标出这不是 Tenon 命令写出的。
    const approved = await readFile(join(cwd(), KNOWN_PATH), 'utf8')
    await writeFile(join(cwd(), KNOWN_PATH), `${approved}  - suite: unit\n    test: "src/a.test.js › good"\n    reason: 顺手加的\n    expires: 2026-07-20\n    added_by: a@x.io\n`, 'utf8')
    current = await status()
    expect(codes(current.json)).toEqual(['protected-file-tampered'])
    expect(current.json.policy?.blockers[0]?.message).toContain('台账外改动')
    expect(await tenon(USER, 'transition', 'demo', 'build-done')).not.toBe(0)

    // 还原成批准过的内容就放行，转换成功。
    await writeFile(join(cwd(), KNOWN_PATH), approved, 'utf8')
    expect((await status()).code).toBe(0)
    expect(await tenon(USER, 'transition', 'demo', 'build-done'), err()).toBe(0)
  }, 180_000)

  test('R1 一次人工确认只批准冻结的那一组：目录改动 + 目录里的不适用声明 + 已知失败条目一起列出、一起批准；委托确认整体被拒；批准后目录再改又挡', async () => {
    await project()
    await registerBoth()
    await writeFile(join(cwd(), 'mode.txt'), 'known\n', 'utf8')
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage')).toBe(2)
    expect(await tenon(USER, 'test', 'known', 'add', '--suite', 'unit', '--test', 'src/a.test.js › bad', '--reason', '等上游修复', '--expires', '2026-07-20'), err()).toBe(0)
    expect(await tenon(USER, 'test', 'catalog', 'not-applicable', 'typecheck', '--reason', '纯 JavaScript 项目'), err()).toBe(0)
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)

    // 目录与已知失败清单的改动都挡在评审门上（不适用声明本身不是阻塞，它随目录改动一起列出）。
    let current = await status()
    expect(current.json.policy?.blockers.filter((item) => item.code === 'protected-file-unapproved').map((item) => item.subject).sort())
      .toEqual([CATALOG_PATH, KNOWN_PATH])

    expect(await tenon(USER, 'session', 'activate', 'demo', '--continuous', '--host-session', SESSION), err()).toBe(0)
    await loadTenonSkill()
    expect(await tenon(USER, 'review', 'request', 'demo', '--event', 'build-done'), err()).toBe(0)
    expect(out()).toContain('待批准的豁免 1 项')
    expect(out()).toContain('not-applicable:typecheck — 纯 JavaScript 项目')
    expect(out()).toContain('待确认的测试配置改动 2 项')
    expect(out()).toContain(CATALOG_PATH)
    expect(out()).toContain(KNOWN_PATH)

    // 委托确认（持续授权）什么都不批准，receipt 保持待确认，两类待批准项都没动。
    expect(await tenon({ ...USER, TENON_HOST_SESSION_ID: SESSION }, 'review', 'acknowledge', 'demo', '--delegated')).toBe(1)
    expect(err()).toContain('待人工批准')
    expect(await readFile(join(cwd(), CATALOG_PATH), 'utf8')).not.toContain('a@x.io')
    expect(codes((await status()).json)).toEqual(['protected-file-unapproved', 'protected-file-unapproved'])

    // 人工确认：不适用声明写上批准人，目录与已知失败清单按「批准后的内容」封存批准；门禁放行。
    expect(await tenon(USER, 'review', 'acknowledge', 'demo'), err()).toBe(0)
    expect(out()).toContain('已批准豁免 1 项：not-applicable:typecheck')
    expect(out()).toContain('已批准测试配置改动 2 项')
    expect(await readFile(join(cwd(), CATALOG_PATH), 'utf8')).toContain('a@x.io')
    current = await status()
    expect(current.code, JSON.stringify(current.json.policy?.blockers)).toBe(0)

    // 批准绑定的是内容：之后目录里多一个字，也要重新确认。
    await appendFile(join(cwd(), CATALOG_PATH), '# 事后加的\n', 'utf8')
    current = await status()
    expect(codes(current.json)).toEqual(['protected-file-unapproved'])
    expect(current.json.policy?.blockers[0]).toMatchObject({ subject: CATALOG_PATH })
  }, 180_000)

  test('R1/R4 基线改写：baseline 命令写出的基线要人确认；事后绕开命令改写（放宽阈值）被标为台账外改动', async () => {
    await project()
    await registerBoth()
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    const run = (await lastRecord()).run_id
    expect(await tenon(USER, 'test', 'baseline', 'demo', '--suite', 'bench', '--run', run), err()).toBe(0)
    const profiles = await readdir(join(cwd(), '.tenon/tests/baselines/bench'))
    expect(profiles).toHaveLength(1)
    const baselinePath = `.tenon/tests/baselines/bench/${profiles[0]}`

    let current = await status()
    expect(codes(current.json)).toEqual(['protected-file-unapproved'])
    expect(current.json.policy?.blockers[0]?.subject).toBe(baselinePath)

    expect(await tenon(USER, 'review', 'request', 'demo', '--event', 'build-done'), err()).toBe(0)
    expect(out()).toContain(`基线 ${baselinePath}`)
    expect(await tenon(USER, 'review', 'acknowledge', 'demo'), err()).toBe(0)
    expect((await status()).code).toBe(0)

    // 把基线中位数改大，让退化判定放行：绕开 tenon test baseline 直接写文件。
    const baseline = JSON.parse(await readFile(join(cwd(), baselinePath), 'utf8')) as { metrics: Record<string, { median: number }> }
    const loosened = { ...baseline, metrics: { p95_ms: { ...baseline.metrics.p95_ms, median: 100_000 } } }
    await writeFile(join(cwd(), baselinePath), `${JSON.stringify(loosened, null, 2)}\n`, 'utf8')
    current = await status()
    expect(codes(current.json)).toEqual(['protected-file-tampered'])
    expect(current.json.policy?.blockers[0]).toMatchObject({ subject: baselinePath, fix: 'tenon review request demo --event build-done' })
  }, 180_000)

  test('R7 指纹：未声明的 coverage/ 目录里塞文件会让已有记录过期；声明的报告与产物不会', async () => {
    await project()
    await registerBoth()
    expect(await tenon(USER, 'test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect((await status()).code).toBe(0)

    // 目录声明的报告被重写（内容变了）：不动候选。
    await writeFile(join(cwd(), 'test-results', 'unit.xml'), '<testsuites/>', 'utf8')
    expect((await status()).code).toBe(0)
    // 藏在 coverage/、test-results/ 里的未声明文件：属于候选，记录过期。
    await mkdir(join(cwd(), 'src', 'coverage'), { recursive: true })
    await writeFile(join(cwd(), 'src', 'coverage', 'payload.js'), 'export const smuggled = true\n', 'utf8')
    let current = await status()
    expect(codes(current.json)).toContain('test-stale')
    await rm(join(cwd(), 'src', 'coverage'), { recursive: true })
    expect((await status()).code).toBe(0)
    await writeFile(join(cwd(), 'test-results', 'notes.txt'), 'not declared\n', 'utf8')
    current = await status()
    expect(codes(current.json)).toContain('test-stale')
  }, 180_000)
})
