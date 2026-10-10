/**
 * `tenon verify --ci` 与证据导出集成用例的夹具：在临时 git 仓库里走一遍真实的开发流程（init → 登记 → `tenon test run`），
 * 把所有受版本管理的产物提交，再克隆成「CI」——没有 gitignore 的本机目录（HMAC 密钥与封存）、没有用户身份、
 * 只有已提交的内容。只给集成测试用；不进 dist（tsconfig 排除）。
 */
import { cpSync, mkdirSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decodeTestRunRecordV2, recordV2Digest, type TestRunRecordV2 } from '@tenon/kernel'
import { FIXED_CLOCK, REPO_ROOT, freshHarness, makeHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

/**
 * tenon 检出里 `tenon verify --ci` 与 action 真正用到的那几处。CLI 从自己所在的位置（`packages/cli/dist/tenon.mjs` 往上三级）
 * 找插件根：`templates/manifest.yaml` 与两份插件清单；action 目录、夹具工具与它引用的 `tools/lib/runtime-roots.mjs` 各在自己的路径。GitHub 上这是整个仓库的检出
 * （用户的 `_actions/<owner>/<repo>/<ref>/`，自测工作流的 `tenon-src`），这里只拷这几处：缺了哪一处，就和真实检出缺它一样起不来。
 */
export const TENON_CHECKOUT_PATHS = [
  'packages/cli/dist/tenon.mjs',
  'templates',
  '.codex-plugin',
  '.claude-plugin',
  '.github/actions/tenon-verify',
  'tools/verify-action-selftest.mjs',
  'tools/lib/runtime-roots.mjs',
] as const

/** 把当前工作树里的 `paths` 拷成 `dest` 下的一份 tenon 检出（真实拷贝，不是符号链接：bundle 的位置决定它找到的插件根）。 */
export function stageTenonCheckout(dest: string, paths: readonly string[] = TENON_CHECKOUT_PATHS): void {
  for (const path of paths) {
    mkdirSync(dirname(join(dest, path)), { recursive: true })
    cpSync(join(REPO_ROOT, path), join(dest, path), { recursive: true })
  }
}

export const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
export const SLUG = 'a-at-x.io'
export const SESSION = 'session-verify-ci'
const RECEIPT_AT = new Date(Date.parse(FIXED_CLOCK) + 3_600_000).toISOString()

export const CATALOG_PATH = '.tenon/tests/catalog.yaml'

/** 目录里只有 v0.3 才认识的两个选项（v0.2.1 会判整份目录无效）。 */
export interface CatalogOptions {
  /** 目录顶层 `profile: coarse`：机器画像用粗口径。 */
  readonly profile?: 'coarse'
  /** 项目级「不适用」声明；写进目录时都还没批准（approved_by 为 null），批准要经评审确认。 */
  readonly notApplicable?: ReadonlyArray<{ readonly kind: string; readonly reason: string }>
}

export function catalog(label = '单测', options: CatalogOptions = {}): string {
  const declared = (options.notApplicable ?? []).map((item) => `  - { kind: ${item.kind}, reason: ${item.reason}, approved_by: null }\n`).join('')
  return `schema: tenon-test-catalog/v1
${options.profile === 'coarse' ? 'profile: coarse\n' : ''}suites:
  - id: unit
    label: ${label}
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
${declared === '' ? '' : `not_applicable:\n${declared}`}`
}

/** 测试完整性策略：缺省不写（= notice），否则写进 build 步骤的 test_policy。 */
export type IntegrityPolicy = 'unset' | 'notice' | 'block'

function workflow(integrity: IntegrityPolicy, run: readonly string[]): string {
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
          run: [${run.join(', ')}]
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
export const LEGACY_TEST_PATH = 'src/legacy.test.js'
export const LEGACY_TEST = `import { test } from 'node:test'
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
  /**
   * 作者的工作区里有宿主本地文件（`.claude/settings.local.json`、`CLAUDE.local.md`），都被 .gitignore 忽略、不进提交；
   * 测试在它们存在时运行，所以绑定的候选指纹要么算进它们（0.3.0），要么不算（可移植版）。
   */
  readonly hostLocalFiles?: boolean
  /**
   * 基线提交里有一份被 git 跟踪的代码 `.claude/worktrees/x.js`（在宿主本地清单的路径下，但提交进了仓库），
   * 测试命令（gen-report.mjs）会 import 它：它是被测代码的一部分，改了就必须让记录过期。
   */
  readonly trackedHostLocalCode?: boolean
  /** 交付前把任务走完：评审确认 → build-done → archived（任务落在终态 verify，已归档）。 */
  readonly finish?: boolean
  /** 目录里的 v0.3 选项（`profile: coarse`、`not_applicable`），写在基线提交的目录里。 */
  readonly catalog?: CatalogOptions
  /** `catalogEdit` 时任务里把目录改成什么样；缺省沿用 `catalog`（只改了套件标签）。 */
  readonly catalogInTask?: CatalogOptions
  /** build 步骤测试策略要求的种类；缺省只要求 `unit`。 */
  readonly policyRun?: readonly string[]
}

export async function devProject(options: DevProjectOptions = {}): Promise<Dev> {
  const h = await freshHarness()
  const dev = makeDev(h)
  await writeFiles(h.cwd, {
    'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
    '.gitignore': `test-results\nnode_modules\n.pipeline/cache\n.pipeline/.gitignore\n${options.hostLocalFiles === true ? '.claude/settings.local.json\nCLAUDE.local.md\n' : ''}`,
    'gen-report.mjs': options.trackedHostLocalCode === true ? `import './${TRACKED_HOST_LOCAL_CODE}'\n${GEN_REPORT}` : GEN_REPORT,
    ...(options.trackedHostLocalCode === true ? { [TRACKED_HOST_LOCAL_CODE]: 'export const marker = 1\n' } : {}),
    'src/a.test.js': 'export {}\n',
    ...(options.deleteLegacyTest === true ? { [LEGACY_TEST_PATH]: LEGACY_TEST } : {}),
    [CATALOG_PATH]: catalog('单测', options.catalog),
    '.pipeline/workflows/trusted.yaml': workflow(options.integrity ?? 'unset', options.policyRun ?? ['unit']),
  })
  git(h.cwd, ['init', '-q', '-b', 'main'])
  commitAll(h.cwd, 'base', '2026-01-01T00:00:00Z')
  git(h.cwd, ['checkout', '-q', '-b', 'pr'])
  if (options.hostLocalFiles === true) await writeHostLocalFiles(h.cwd)
  await expectOk(dev.tenon(['init', 'demo', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full']), dev, 'init')
  await writeFiles(h.cwd, { 'src/feature.js': 'export const feature = () => 1\n' })
  if (options.deleteLegacyTest === true) await rm(join(h.cwd, LEGACY_TEST_PATH))
  if (options.catalogEdit === 'unapproved' || options.catalogEdit === 'approved') {
    await writeFile(join(h.cwd, CATALOG_PATH), catalog('单测（改过）', options.catalogInTask ?? options.catalog), 'utf8')
  }
  await expectOk(dev.tenon(['test', 'register', 'demo', '--suite', 'unit']), dev, 'register suite')
  await expectOk(dev.tenon(['test', 'register', 'demo', '--file', 'src/a.test.js', '--suite', 'unit']), dev, 'register file')
  await expectOk(dev.tenon(['test', 'register', 'demo', '--case', 'task:1.1', '--test', 'src/a.test.js › bad']), dev, 'register case')
  await expectOk(dev.tenon(['test', 'run', 'demo', '--stage']), dev, 'test run')
  if (options.catalogEdit === 'approved' || options.finish === true) await approveCatalog(dev)
  if (options.finish === true) {
    await expectOk(dev.tenon(['transition', 'demo', 'build-done']), dev, 'transition build-done')
    await expectOk(dev.tenon(['transition', 'demo', 'archived']), dev, 'transition archived')
  }
  dev.commit('deliver demo')
  return dev
}

/** 宿主本地清单路径下、却被 git 跟踪的代码文件（见 DevProjectOptions.trackedHostLocalCode）。 */
export const TRACKED_HOST_LOCAL_CODE = '.claude/worktrees/x.js'

/** Claude Code 在项目里自己写的、被忽略的宿主本地文件（权限允许列表、个人记忆）。 */
export const HOST_LOCAL_SETTINGS_PATH = '.claude/settings.local.json'
export const HOST_LOCAL_SETTINGS = '{ "permissions": { "allow": ["Bash(ls)"] } }\n'

export async function writeHostLocalFiles(dir: string, settings = HOST_LOCAL_SETTINGS): Promise<void> {
  await writeFiles(dir, { [HOST_LOCAL_SETTINGS_PATH]: settings, 'CLAUDE.local.md': 'private notes\n' })
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
