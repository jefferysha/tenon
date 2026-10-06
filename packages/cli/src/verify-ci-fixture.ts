/**
 * `tenon verify --ci` 与证据导出集成用例的夹具：在临时 git 仓库里走一遍真实的开发流程（init → 登记 → `tenon test run`），
 * 把所有受版本管理的产物提交，再克隆成「CI」——没有 gitignore 的本机目录（HMAC 密钥与封存）、没有用户身份、
 * 只有已提交的内容。只给集成测试用；不进 dist（tsconfig 排除）。
 */
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeTestRunRecordV2, recordV2Digest, type TestRunRecordV2 } from '@tenon/kernel'
import { FIXED_CLOCK, freshHarness, makeHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

export const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
export const SLUG = 'a-at-x.io'
export const SESSION = 'session-verify-ci'
const RECEIPT_AT = new Date(Date.parse(FIXED_CLOCK) + 3_600_000).toISOString()

export const CATALOG_PATH = '.tenon/tests/catalog.yaml'

export function catalog(label = '单测'): string {
  return `schema: tenon-test-catalog/v1
suites:
  - id: unit
    label: ${label}
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
`
}

/** 测试完整性策略：缺省不写（= notice），否则写进 build 步骤的 test_policy。 */
export type IntegrityPolicy = 'unset' | 'notice' | 'block'

function workflow(integrity: IntegrityPolicy): string {
  return `name: trusted
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
${integrity === 'unset' ? '' : `          integrity: ${integrity}\n`}        transitions:
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
}

/** 基线提交里的一个旧测试文件；`deleteLegacyTest` 时开发者在交付前删掉它（任务内没有登记它）。 */
const LEGACY_TEST_PATH = 'src/legacy.test.js'
const LEGACY_TEST = `import { test } from 'node:test'
test('legacy one', () => {})
test('legacy two', () => {})
`

const GEN_REPORT = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/unit.xml', '<?xml version="1.0"?><testsuites><testsuite name="t" tests="2" failures="0">'
  + '<testcase name="good" classname="t" file="src/a.test.js"/><testcase name="bad" classname="t" file="src/a.test.js"/></testsuite></testsuites>')
`

export interface Dev {
  readonly h: Harness
  readonly dir: string
  tenon: (args: readonly string[], env?: Record<string, string>) => Promise<number>
  out: () => string
  err: () => string
  commit: (message: string) => void
  /** 用户记录目录（绝对路径）。 */
  recordsDir: () => string
  records: () => Promise<TestRunRecordV2[]>
  cleanup: () => Promise<void>
}

export interface CiCheckout {
  readonly h: Harness
  readonly dir: string
  /** `tenon verify --ci …`，不带用户身份；`env` 覆盖本次命令的环境（例如 TENON_LANG）；返回 exit code 与输出。 */
  verify: (args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => Promise<{ code: number; out: string; err: string }>
  commit: (message: string) => void
  cleanup: () => Promise<void>
}

async function readRecord(path: string): Promise<TestRunRecordV2> {
  const record = decodeTestRunRecordV2(JSON.parse(await readFile(path, 'utf8')))
  if (record === undefined) throw new Error(`fixture: 记录无法解码: ${path}`)
  return record
}

function makeDev(h: Harness): Dev {
  const dev: Dev = {
    h, dir: h.cwd,
    tenon: (args, env = USER) => h.run([...args], { env }),
    out: () => h.out.join('\n'),
    err: () => h.err.join('\n'),
    commit: (message) => commitAll(h.cwd, message, '2026-08-01T00:00:00Z'),
    recordsDir: () => join(h.cwd, '.tenon', 'users', SLUG, 'tests', 'demo'),
    records: async () => {
      const dir = join(h.cwd, '.tenon', 'users', SLUG, 'tests', 'demo')
      const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
      return Promise.all(names.map(async (name) => readRecord(join(dir, name))))
    },
    cleanup: () => rm(h.cwd, { recursive: true, force: true }),
  }
  return dev
}

/**
 * 开发者的仓库：main 上有基线提交（目录、工作流、脚本），分支 pr 上是交付提交（任务状态、实现、记录）。
 * 任务在基线提交之后创建，所以「自任务起点以来的改动」干净可测。
 * `catalogEdit` 为真时，任务里改了测试目录（受保护文件），并经评审确认批准。
 */
export interface DevProjectOptions {
  readonly catalogEdit?: 'none' | 'unapproved' | 'approved'
  /** build 步骤测试策略的 `integrity`；缺省不写（= notice）。 */
  readonly integrity?: IntegrityPolicy
  /** 基线里有一个旧测试文件，开发者在交付前把它删了（测试完整性的 `test-file-deleted` 信号）。 */
  readonly deleteLegacyTest?: boolean
}

export async function devProject(options: DevProjectOptions = {}): Promise<Dev> {
  const h = await freshHarness()
  const dev = makeDev(h)
  await writeFiles(h.cwd, {
    'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
    '.gitignore': 'test-results\nnode_modules\n.pipeline/cache\n.pipeline/.gitignore\n',
    'gen-report.mjs': GEN_REPORT,
    'src/a.test.js': 'export {}\n',
    ...(options.deleteLegacyTest === true ? { [LEGACY_TEST_PATH]: LEGACY_TEST } : {}),
    [CATALOG_PATH]: catalog(),
    '.pipeline/workflows/trusted.yaml': workflow(options.integrity ?? 'unset'),
  })
  git(h.cwd, ['init', '-q', '-b', 'main'])
  commitAll(h.cwd, 'base', '2026-01-01T00:00:00Z')
  git(h.cwd, ['checkout', '-q', '-b', 'pr'])
  await expectOk(dev.tenon(['init', 'demo', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full']), dev, 'init')
  await writeFiles(h.cwd, { 'src/feature.js': 'export const feature = () => 1\n' })
  if (options.deleteLegacyTest === true) await rm(join(h.cwd, LEGACY_TEST_PATH))
  if (options.catalogEdit === 'unapproved' || options.catalogEdit === 'approved') {
    await writeFile(join(h.cwd, CATALOG_PATH), catalog('单测（改过）'), 'utf8')
  }
  await expectOk(dev.tenon(['test', 'register', 'demo', '--suite', 'unit']), dev, 'register suite')
  await expectOk(dev.tenon(['test', 'register', 'demo', '--file', 'src/a.test.js', '--suite', 'unit']), dev, 'register file')
  await expectOk(dev.tenon(['test', 'register', 'demo', '--case', 'task:1.1', '--test', 'src/a.test.js › bad']), dev, 'register case')
  await expectOk(dev.tenon(['test', 'run', 'demo', '--stage']), dev, 'test run')
  if (options.catalogEdit === 'approved') await approveCatalog(dev)
  dev.commit('deliver demo')
  return dev
}

async function expectOk(result: Promise<number>, dev: Dev, what: string): Promise<void> {
  const code = await result
  if (code !== 0) throw new Error(`fixture: ${what} exit=${code}\n${dev.out()}\n${dev.err()}`)
}

/** 像宿主那样加载 tenon skill：历史里有 Skill 工具行，再留回执；之后评审请求才可用。 */
async function approveCatalog(dev: Dev): Promise<void> {
  await expectOk(dev.tenon(['session', 'activate', 'demo', '--continuous', '--host-session', SESSION]), dev, 'session activate')
  await appendFile(join(dev.dir, 'openspec/changes/demo/.pipeline-history.jsonl'), `${JSON.stringify({ ts: RECEIPT_AT, kind: 'tool', raw: 'Skill: tenon' })}\n`, 'utf8')
  await expectOk(dev.tenon(['internal-native-skill-receipt', 'demo', 'tenon', 'trust-session', 'tool-1', RECEIPT_AT]), dev, 'skill receipt')
  await expectOk(dev.tenon(['review', 'request', 'demo', '--event', 'build-done']), dev, 'review request')
  await expectOk(dev.tenon(['review', 'acknowledge', 'demo']), dev, 'review acknowledge')
}

/** 把开发者仓库克隆成 CI 的样子：干净检出，没有 gitignore 的本机目录，没有用户身份。 */
export async function ciCheckout(dev: Dev, options: { readonly shallow?: boolean } = {}): Promise<CiCheckout> {
  const dir = await mkdtemp(join(tmpdir(), 'verify-ci-'))
  // 克隆进已存在的空目录：根目录权限位与开发者的临时目录一致（候选指纹把目录权限位算进去）。
  git(dir, options.shallow === true ? ['clone', '-q', '--depth', '1', `file://${dev.dir}`, '.'] : ['clone', '-q', dev.dir, '.'])
  const h = makeHarness(dir)
  return {
    h, dir,
    verify: async (args, env = {}) => {
      const code = await h.run(['verify', '--ci', ...args], { env: { TENON_USER: undefined, TENON_USER_NAME: undefined, ...env } })
      return { code, out: h.out.join('\n'), err: h.err.join('\n') }
    },
    commit: (message) => {
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-q', '-m', message, '--allow-empty'], '2026-08-02T00:00:00Z')
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** 改一条记录并（可选地）重算它与后续记录的摘要——模拟「改了记录」与「改了记录还重算了整条链」。 */
export async function rewriteRecords(
  dir: string,
  mutate: (record: TestRunRecordV2, index: number) => TestRunRecordV2,
  options: { readonly rechain: boolean },
): Promise<void> {
  const base = join(dir, '.tenon', 'users', SLUG, 'tests', 'demo')
  const names = (await readdir(base)).filter((name) => name.endsWith('.json')).sort()
  let previous: string | null = null
  for (const [index, name] of names.entries()) {
    let next = mutate(await readRecord(join(base, name)), index)
    if (options.rechain) {
      const { digest: _digest, ...body } = { ...next, prev_digest: previous === null ? next.prev_digest : previous }
      next = { ...body, digest: recordV2Digest(body) }
    }
    previous = next.digest
    await writeFile(join(base, name), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }
}
