/**
 * 目录里的「不适用」声明在任务起点之前就已提交、还没批准（验收记录 2026-10-v0.3，F19）。
 *
 * 任务里的评审确认批准它时，Tenon 把批准人写回 catalog.yaml。声明不在任务 diff 里，评审请求冻结清单里没有目录的摘要，
 * 所以以前这次改写没有任何批准行，目录相对任务起点成了「没批准的受保护改动」：`tenon test status` 与 `tenon transition`
 * 报 protected-file-unapproved 并让人重新 review request，而 request 因为 receipt 已获确认被拒——任务从此卡死。
 * 现在批准写入的那次改写按批准后的内容封存、留审计行；手写的 approved_by 与批准之外的目录改动照旧挡。
 *
 * 零 mock：真临时 git 仓库、真 CLI、真封存文件。
 */
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const CATALOG_PATH = '.tenon/tests/catalog.yaml'
const REASON = '纯 JavaScript 项目，没有类型检查'

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
          run: [unit]
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

/** 基线提交里的目录：一个单测套件，加一条还没批准的 typecheck「不适用」声明。 */
const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    label: 单测
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
not_applicable:
  - { kind: typecheck, reason: ${REASON}, approved_by: null }
`

const GEN_REPORT = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/unit.xml', '<?xml version="1.0"?><testsuites><testsuite name="t" tests="1" failures="0">'
  + '<testcase name="good" classname="t" file="src/a.test.js"/></testsuite></testsuites>')
`

interface PolicyJson {
  policy?: { blockers: Array<{ code: string; blocking: boolean; subject?: string }> }
}

describe('目录里先于任务提交的「不适用」声明', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  /** 声明已提交；任务在提交之后创建，所以目录不在本任务的 diff 里。 */
  async function project(): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      '.gitignore': 'test-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n',
      'gen-report.mjs': GEN_REPORT,
      'src/a.test.js': 'export {}\n',
      [CATALOG_PATH]: CATALOG,
      '.pipeline/workflows/trusted.yaml': WORKFLOW,
    })
    git(harness.cwd, ['init', '-q', '-b', 'main'])
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    expect(await harness.run(['test', 'register', 'demo', '--suite', 'unit'], { env: USER }), harness.err.join('\n')).toBe(0)
    expect(await harness.run(['test', 'run', 'demo', '--stage'], { env: USER }), harness.err.join('\n')).toBe(0)
    return harness
  }

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd

  async function blockers(): Promise<Array<{ code: string; subject?: string }>> {
    await tenon('test', 'status', 'demo', '--step', 'build', '--json')
    return ((JSON.parse(out()) as PolicyJson).policy?.blockers ?? []).filter((item) => item.blocking)
  }

  test('声明还没批准、也不在任务 diff 里：评审请求只列出它；人工确认之后目录的改写是被批准的内容，出口放行', async () => {
    await project()
    expect(await blockers()).toEqual([])

    expect(await tenon('review', 'request', 'demo', '--event', 'build-done'), err()).toBe(0)
    expect(out()).toContain('待批准的豁免 1 项')
    expect(out()).toContain(`not-applicable:typecheck — ${REASON}`)
    expect(out()).not.toContain('待确认的测试配置改动')

    expect(await tenon('review', 'acknowledge', 'demo'), err()).toBe(0)
    expect(out()).toContain('已批准豁免 1 项：not-applicable:typecheck')
    expect(await readFile(join(cwd(), CATALOG_PATH), 'utf8')).toContain('approved_by: a@x.io')

    // 以前这里是 protected-file-unapproved（目录相对任务起点多了批准人），request 又因为已获确认被拒。
    expect(await blockers(), 'the approval rewrite of catalog.yaml must not be an unapproved protected change').toEqual([])
    expect(await tenon('transition', 'demo', 'build-done'), `${out()}\n${err()}`).toBe(0)

    // 审计行记下了批准后的目录摘要，CI 的 `tenon verify --ci` 用它核对。
    const history = await readFile(join(cwd(), 'openspec/changes/demo/.pipeline-history.jsonl'), 'utf8')
    expect(history).toMatch(new RegExp(`test:protected-approve files=${CATALOG_PATH.replaceAll('.', '\\.')} digests=${CATALOG_PATH.replaceAll('.', '\\.')}@sha256:[0-9a-f]{64} by=a@x\\.io`, 'u'))
  }, 180_000)

  test('批准绑定的是批准写出的那份内容：之后再改目录一个字，照旧要重新确认', async () => {
    await project()
    expect(await tenon('review', 'request', 'demo', '--event', 'build-done'), err()).toBe(0)
    expect(await tenon('review', 'acknowledge', 'demo'), err()).toBe(0)
    expect(await blockers()).toEqual([])

    await appendFile(join(cwd(), CATALOG_PATH), '# 事后加的\n', 'utf8')
    expect(await blockers()).toEqual([expect.objectContaining({ code: 'protected-file-unapproved', subject: CATALOG_PATH })])
  }, 180_000)

  test('手写 approved_by 不是批准：没有经过评审确认的改写，目录改动仍然是没批准的受保护改动', async () => {
    await project()
    const path = join(cwd(), CATALOG_PATH)
    await writeFile(path, (await readFile(path, 'utf8')).replace('approved_by: null', 'approved_by: someone@x.io'), 'utf8')

    expect(await blockers()).toEqual([expect.objectContaining({ code: 'protected-file-unapproved', subject: CATALOG_PATH })])
  }, 180_000)

  test('评审请求之后目录里另有改动：这次确认只批准声明，不顺带批准用户没看过的那处改动', async () => {
    await project()
    expect(await tenon('review', 'request', 'demo', '--event', 'build-done'), err()).toBe(0)
    const path = join(cwd(), CATALOG_PATH)
    // 请求之后多了一条用户没见过的声明：冻结清单里没有它，这次确认不批准它，目录里这处改动也不能被顺带封存。
    await writeFile(path, (await readFile(path, 'utf8')).replace('not_applicable:\n', 'not_applicable:\n  - { kind: lint, reason: 请求之后才加的, approved_by: null }\n'), 'utf8')

    expect(await tenon('review', 'acknowledge', 'demo'), err()).toBe(0)
    const catalog = await readFile(path, 'utf8')
    expect(catalog).toContain('approved_by: a@x.io')
    expect(catalog.match(/approved_by: null/gu), 'only the late lint declaration stays unapproved').toHaveLength(1)
    expect(await blockers()).toEqual([expect.objectContaining({ code: 'protected-file-unapproved', subject: CATALOG_PATH })])
  }, 180_000)
})
