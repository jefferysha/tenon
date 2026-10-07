/**
 * 已经被已发布版本卡死的任务有没有出路（验收记录 2026-10-v0.3，F19；修复见 catalog-na-pre-declared.integration.test.ts）。
 *
 * 卡死的状态由真正发布的 CLI（v0.3.0 与 v0.3.1，`not_applicable` 从 v0.3.0 起有）造出来：目录里先于任务提交的「不适用」声明还没批准，
 * 任务里评审确认之后，批准人被写回 catalog.yaml，这次改写没有批准行，于是 `tenon test status` / `tenon transition`
 * 报 protected-file-unapproved，而 `tenon review request` 因为这个 event 已获确认被拒。当前版本不再造出这种状态，
 * 但不会自动修好已有的：这里在当前版本的 CLI 上走一遍，记下什么不行、什么行：
 *   · 重新 request：被拒；把目录里的批准人改回 null：仍卡死（声明回到「未批准」，request 照样被拒）；
 *   · 归档卡死的任务、新建一个任务：目录里的声明已经带着批准人，只剩那次目录改写要在新任务里
 *     确认一次（待确认的测试配置改动），确认后 transition 通过；归档的任务还在，可以取回。
 *
 * 零 mock：真临时 git 仓库、两个真 CLI 子进程（已发布版本取自它的 git 标签，当前版本取自本仓的 dist 包）。
 * 没有对应标签的检出（浅克隆）里该版本的一组整体跳过；CI 的 verify 作业是完整克隆，会跑。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { REPO_ROOT, rm } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

/** 带 `not_applicable` 批准写回缺陷的已发布版本。 */
const RELEASE_TAGS = ['v0.3.0', 'v0.3.1'] as const
const CATALOG_PATH = '.tenon/tests/catalog.yaml'
const REASON = '纯 JavaScript 项目，没有类型检查'
const CURRENT_BUNDLE = join(REPO_ROOT, 'packages', 'cli', 'dist', 'tenon.mjs')
/** 旧版 CLI 从自己所在的载荷根读模板与技能，所以不能只取单个包文件。 */
const PAYLOAD_ENTRIES = ['packages/cli/dist/tenon.mjs', 'templates', 'skills', 'adapters', 'hooks', '.claude-plugin', '.codex-plugin']

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
          run: [unit, typecheck]
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

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

interface PolicyJson {
  policy?: { blockers: Array<{ code: string; blocking: boolean; subject?: string }> }
}

function releaseTagPresent(tag: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd: REPO_ROOT }).status === 0
}

describe.each(RELEASE_TAGS)('%s 留下的卡死任务：当前版本上的出路', (tag) => {
  const it = test.skipIf(!releaseTagPresent(tag))
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  interface Stuck {
    readonly cwd: string
    readonly approvedCatalog: string
    readonly released: (...args: string[]) => Run
    readonly current: (...args: string[]) => Run
  }

  /** 已发布版本把任务走到「评审已确认、目录被批准改写、transition 被拦」：这就是用户手里卡死的状态。 */
  async function stuckTask(): Promise<Stuck> {
    const root = await mkdtemp(join(tmpdir(), 'na-stuck-'))
    dirs.push(root)
    const payload = join(root, 'payload')
    await mkdir(payload, { recursive: true })
    const archive = spawnSync('git', ['archive', tag, '--', ...PAYLOAD_ENTRIES], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 })
    expect(archive.status, String(archive.stderr)).toBe(0)
    expect(spawnSync('tar', ['-x', '-C', payload], { input: archive.stdout }).status).toBe(0)
    const released = join(payload, 'packages', 'cli', 'dist', 'tenon.mjs')

    const cwd = join(root, 'project')
    await writeFiles(cwd, {
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      '.gitignore': 'test-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n',
      'gen-report.mjs': GEN_REPORT,
      'src/a.test.js': 'export {}\n',
      [CATALOG_PATH]: CATALOG,
      '.pipeline/workflows/trusted.yaml': WORKFLOW,
    })
    git(cwd, ['init', '-q', '-b', 'main'])
    commitAll(cwd, 'base', '2026-01-01T00:00:00Z')

    const env = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'C.UTF-8',
      TENON_LANG: 'zh',
      TENON_USER: 'a@x.io',
      TENON_USER_NAME: 'A',
      TENON_TEST_TRUST: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    const via = (bundle: string) => (...args: string[]): Run => {
      const result = spawnSync(process.execPath, [bundle, ...args], { cwd, env, encoding: 'utf8' })
      return { code: result.status ?? -1, out: result.stdout, err: result.stderr }
    }
    const old = via(released)
    const step = (...args: string[]): void => {
      const run = old(...args)
      expect(run.code, `${tag} ${args.join(' ')}\n${run.out}\n${run.err}`).toBe(0)
    }
    step('init', 'demo', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full')
    step('test', 'register', 'demo', '--suite', 'unit')
    step('test', 'run', 'demo', '--stage')
    step('review', 'request', 'demo', '--event', 'build-done')
    step('review', 'acknowledge', 'demo')
    return { cwd, approvedCatalog: await readFile(join(cwd, CATALOG_PATH), 'utf8'), released: old, current: via(CURRENT_BUNDLE) }
  }

  function blockers(run: Run): Array<{ code: string; subject?: string }> {
    return ((JSON.parse(run.out) as PolicyJson).policy?.blockers ?? []).filter((item) => item.blocking)
  }

  it('已发布版本造出卡死的状态：批准人被写回目录，目录改写没有批准行，transition 被拦，再次 request 被拒', async () => {
    const stuck = await stuckTask()
    expect(stuck.approvedCatalog).toContain('approved_by: a@x.io')

    for (const run of [stuck.released('transition', 'demo', 'build-done'), stuck.current('transition', 'demo', 'build-done')]) {
      expect(run.code).toBe(1)
      expect(run.err).toContain(CATALOG_PATH)
      expect(run.err).toContain('需要你在评审里确认')
    }
    const status = stuck.current('test', 'status', 'demo', '--step', 'build', '--json')
    expect(status.code).toBe(2)
    expect(blockers(status)).toEqual([expect.objectContaining({ code: 'protected-file-unapproved', subject: CATALOG_PATH })])
    const again = stuck.current('review', 'request', 'demo', '--event', 'build-done')
    expect(again.code).toBe(1)
    expect(again.err).toContain('已获确认')
  }, 120_000)

  it('把目录里的批准人改回 null 不是出路：声明回到未批准，transition 照样被拦，request 照样被拒', async () => {
    const stuck = await stuckTask()
    git(stuck.cwd, ['checkout', '--', CATALOG_PATH])
    expect(await readFile(join(stuck.cwd, CATALOG_PATH), 'utf8')).toContain('approved_by: null')

    const status = stuck.current('test', 'status', 'demo', '--step', 'build', '--json')
    expect(blockers(status)).toEqual([expect.objectContaining({ code: 'waiver-unapproved', subject: 'typecheck' })])
    expect(stuck.current('transition', 'demo', 'build-done').code).toBe(1)
    const request = stuck.current('review', 'request', 'demo', '--event', 'build-done')
    expect(request.code).toBe(1)
    expect(request.err).toContain('已获确认')
  }, 120_000)

  it('出路：归档卡死的任务、新建一个任务；新任务里只确认一次目录改写，之后 transition 通过', async () => {
    const stuck = await stuckTask()
    const { current } = stuck
    const must = (run: Run, label: string): Run => {
      expect(run.code, `${label}\n${run.out}\n${run.err}`).toBe(0)
      return run
    }

    must(current('task', 'archive', 'demo', '--yes'), 'task archive demo --yes')
    must(current('init', 'demo2', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full'), 'init demo2')
    must(current('test', 'register', 'demo2', '--suite', 'unit'), 'test register demo2')
    must(current('test', 'run', 'demo2', '--stage'), 'test run demo2 --stage')

    // 目录里的声明已经带着批准人，不再列为待批准的豁免；新任务的起点是提交，目录相对它仍有那次改写，
    // 在新任务里它只是一项普通的待确认配置改动。
    const before = current('test', 'status', 'demo2', '--step', 'build', '--json')
    expect(before.code).toBe(2)
    expect(blockers(before)).toEqual([expect.objectContaining({ code: 'protected-file-unapproved', subject: CATALOG_PATH })])
    const request = must(current('review', 'request', 'demo2', '--event', 'build-done'), 'review request demo2')
    expect(request.out).toContain('待确认的测试配置改动 1 项')
    expect(request.out).not.toContain('待批准的豁免')
    const acknowledge = must(current('review', 'acknowledge', 'demo2'), 'review acknowledge demo2')
    expect(acknowledge.out).toContain(`已批准测试配置改动 1 项：${CATALOG_PATH}`)

    const after = must(current('test', 'status', 'demo2', '--step', 'build', '--json'), 'test status demo2')
    expect(blockers(after)).toEqual([])
    must(current('transition', 'demo2', 'build-done'), 'transition demo2 build-done')
    // 目录里的批准人是旧任务里确认过的那位，新任务没有重写它。
    expect(await readFile(join(stuck.cwd, CATALOG_PATH), 'utf8')).toBe(stuck.approvedCatalog)
    // 归档不是删除：卡死的任务还在，可以取回。
    must(current('task', 'unarchive', 'demo', '--yes'), 'task unarchive demo --yes')
    expect(current('status', 'demo', '--json').code).toBe(0)
  }, 180_000)
})
