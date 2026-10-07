/**
 * `.github/workflows/verify-action-selftest.yml` 在 GitHub 的运行器上跑之前，把它里面每一步能在本机验证的都验证一遍：
 * 夹具工具（tools/verify-action-selftest.mjs）用刚构建的 bundle 真建出干净与被篡改的两个仓库，action 调用的 run.sh 在它们上面
 * 给出工作流断言的 exit-code 与 SARIF，断言工具对对的结论放行、对错的结论失败。另外静态检查工作流本身：动作固定到提交 SHA、
 * 没有 continue-on-error、权限最小、必需的输入都在、tampered 作业用的环境变量名都出自 action.yml。
 * 真正只有运行器才有的东西（composite action 的接线、setup-node、SARIF 上传）由工作流在 GitHub 上验证，见文件头。
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { REPO_ROOT } from './integration-harness.js'

const TOOL = join(REPO_ROOT, 'tools', 'verify-action-selftest.mjs')
const ACTION_DIR = join(REPO_ROOT, '.github', 'actions', 'tenon-verify')
const BUNDLE = join(REPO_ROOT, 'packages', 'cli', 'dist', 'tenon.mjs')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'verify-action-selftest.yml')

interface Fixture {
  dir: string
  head: string
  change: string
  tampered: string | null
}

const cleanups: string[] = []
afterAll(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

function node(args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...args], { encoding: 'utf8', cwd: options.cwd, env: options.env ?? process.env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function fixture(scenario: 'clean' | 'tampered'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `verify-action-selftest-${scenario}-`))
  cleanups.push(root)
  const out = join(root, 'fixture')
  const built = node([TOOL, 'fixture', ...(scenario === 'tampered' ? ['--tamper'] : []), '--cli', BUNDLE, '--action', ACTION_DIR, '--out', out])
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0)
  return JSON.parse(built.stdout) as Fixture
}

interface ActionOutputs {
  status: number | null
  log: string
  outputs: Map<string, string>
}

/** 工作流 tampered 作业对 run.sh 的调用方式（环境变量名与 action.yml 一致），工作区就是夹具。 */
async function runScript(dir: string): Promise<ActionOutputs> {
  const temp = await mkdtemp(join(tmpdir(), 'verify-action-selftest-run-'))
  cleanups.push(temp)
  const outputFile = join(temp, 'github-output')
  const summaryFile = join(temp, 'step-summary')
  const prepared = spawnSync('sh', ['-c', `: > "${outputFile}"; : > "${summaryFile}"`])
  expect(prepared.status).toBe(0)
  const result = spawnSync('bash', [join(dir, '.github', 'actions', 'tenon-verify', 'run.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: dir,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      RUNNER_TEMP: temp,
      TENON_ACTION_PATH: join(dir, '.github', 'actions', 'tenon-verify'),
      TENON_VERIFY_CLI: BUNDLE,
      TENON_VERIFY_CHANGE: 'demo',
      TENON_VERIFY_CANDIDATE: 'error',
    },
  })
  const outputs = new Map<string, string>()
  for (const line of (await readFile(outputFile, 'utf8')).split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return { status: result.status, log: `${result.stdout}${result.stderr}`, outputs }
}

function assertOutcome(scenario: string, run: ActionOutputs): { status: number | null; stderr: string } {
  const assertion = node([TOOL, 'assert', '--scenario', scenario, '--exit-code', run.outputs.get('exit-code') ?? '', '--sarif', run.outputs.get('sarif-path') ?? ''])
  return { status: assertion.status, stderr: assertion.stderr }
}

describe('verify-action-selftest：夹具工具与断言', () => {
  test('干净的夹具：真实 CLI 建出来，action 目录随基线提交；run.sh 给 exit-code 0、SARIF 没有任何发现，断言放行', async () => {
    const built = await fixture('clean')
    // 记录是 `tenon test run` 写出的真实记录，已提交；action 目录在基线提交里（之后不会有未跟踪文件改变候选指纹）。
    const tracked = spawnSync('git', ['ls-files'], { cwd: built.dir, encoding: 'utf8' }).stdout.split('\n')
    expect(tracked).toContain('.github/actions/tenon-verify/run.sh')
    expect(tracked.filter((path) => /^\.tenon\/users\/[^/]+\/tests\/demo\/.+\.json$/u.test(path))).toHaveLength(1)
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: built.dir, encoding: 'utf8' }).stdout.trim()).toBe('')
    expect(spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: built.dir, encoding: 'utf8' }).stdout.trim()).toBe('false')

    const run = await runScript(built.dir)
    expect(run.outputs.get('exit-code'), run.log).toBe('0')
    expect(assertOutcome('clean', run)).toMatchObject({ status: 0 })
    // 干净的结论不能被拿去冒充「被篡改」：断言工具对错的场景失败。
    const wrong = assertOutcome('tampered', run)
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain('exit-code 应为 2')
  }, 240_000)

  test('被篡改的夹具：一条记录改了内容没重算摘要；run.sh 不让步骤失败，给 exit-code 2，SARIF 带 error 级 tenon/record-chain-broken，断言放行', async () => {
    const built = await fixture('tampered')
    expect(built.tampered).toMatch(/^\.tenon\/users\/[^/]+\/tests\/demo\/.+\.json$/u)
    const run = await runScript(built.dir)
    expect(run.status, '脚本自己永远 exit 0：失败由后面的断言步骤判').toBe(0)
    expect(run.outputs.get('exit-code'), run.log).toBe('2')
    expect(assertOutcome('tampered', run)).toMatchObject({ status: 0 })
    const wrong = assertOutcome('clean', run)
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain('exit-code 应为 0')
  }, 240_000)

  test('断言工具：缺 SARIF、SARIF 不是 JSON、未知场景都是失败，不会当作通过', () => {
    expect(node([TOOL, 'assert', '--scenario', 'clean', '--exit-code', '0']).status).toBe(1)
    expect(node([TOOL, 'assert', '--scenario', 'clean', '--exit-code', '0', '--sarif', join(REPO_ROOT, 'package.json')]).status).toBe(1)
    expect(node([TOOL, 'assert', '--scenario', 'other', '--exit-code', '0']).status).toBe(1)
    expect(node([TOOL, 'assert', '--scenario', 'tampered', '--exit-code', '']).status).toBe(1)
  })
})

/** 一个作业的文本：从 `  <id>:` 到下一个作业或文件尾。 */
function jobText(workflow: string, id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  expect(start, `缺作业 ${id}`).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(2).search(/\n {2}[A-Za-z0-9_-]+:\n/u)
  return next === -1 ? rest : rest.slice(0, next + 2)
}

describe('verify-action-selftest.yml：静态约束', () => {
  test('每个远程 uses 固定到提交 SHA，只有本地 action 例外；没有 continue-on-error（含注释之外的任何位置）', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)].map((match) => match[1] ?? '')
    expect(uses.length).toBeGreaterThanOrEqual(5)
    for (const reference of uses) {
      if (reference.startsWith('./')) expect(reference).toBe('./.github/actions/tenon-verify')
      else expect(reference, `未固定到 SHA: ${reference}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u)
    }
    // 与 ci.yml 用的是同一份固定（同一个动作同一个 SHA）。
    const ci = await readFile(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    for (const reference of uses.filter((item) => !item.startsWith('./'))) expect(ci, reference).toContain(reference)
    expect(workflow).not.toMatch(/continue-on-error/u)
  })

  test('触发：手动与会碰到 action 或 verify-ci 命令的 PR；每个检出都是完整历史；权限最小', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n {2}pull_request:\n/mu)
    const paths = workflow.slice(workflow.indexOf('    paths:'), workflow.indexOf('\npermissions:'))
    for (const path of ['.github/actions/tenon-verify/**', 'packages/cli/src/commands/verify-ci*']) expect(paths).toContain(`'${path}'`)
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/gu)].length
    expect(checkouts).toBe(2)
    expect([...workflow.matchAll(/fetch-depth: 0/gu)]).toHaveLength(checkouts)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/mu)
    // 只有会上传 SARIF 的作业拿 security-events: write。
    expect(jobText(workflow, 'clean')).toContain('security-events: write')
    expect(jobText(workflow, 'tampered')).not.toContain('security-events')
  })

  test('clean 作业：用本地 action 跑，cli 指向刚构建的 bundle，上传 SARIF 用自己的 category，断言 exit-code 0；夹具由真实 CLI 以 TENON_TEST_TRUST=1 建', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    const clean = jobText(workflow, 'clean')
    expect(clean).toContain('npm run build')
    expect(clean).toContain('uses: ./.github/actions/tenon-verify')
    expect(clean).toMatch(/cli: \$\{\{ runner\.temp \}\}\/selftest\/tenon\.mjs/u)
    expect(clean).toContain("upload-sarif: 'true'")
    expect(clean).toContain('sarif-category: tenon-verify-selftest')
    expect(clean).toMatch(/assert\n? *--scenario clean --exit-code "\$EXIT_CODE"/u)
    expect(clean).not.toContain('--tamper')
    // action 的默认 category 是 tenon-verify（仓库自己的 PR 检查用）：自测的上传必须用另一个，否则会互相关闭对方的告警。
    expect(await readFile(join(ACTION_DIR, 'action.yml'), 'utf8')).toMatch(/sarif-category:\n {4}description:[^\n]*\n {4}default: tenon-verify\n/u)
    const tool = await readFile(TOOL, 'utf8')
    expect(tool).toMatch(/TENON_TEST_TRUST: '1'/u)
    expect(tool).toMatch(/tenon\('test', 'run', CHANGE, '--stage'\)/u)
  })

  test('tampered 作业：夹具带 --tamper，不经 action 的失败步骤（那会让作业变红），直接跑 run.sh；环境变量名都出自 action.yml；断言 exit-code 2', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    const tampered = jobText(workflow, 'tampered')
    expect(tampered).toContain('fixture --tamper')
    expect(tampered).not.toContain('uses: ./.github/actions/tenon-verify')
    expect(tampered).toContain('run: bash "$TENON_ACTION_PATH/run.sh"')
    expect(tampered).toMatch(/assert\n? *--scenario tampered --exit-code "\$EXIT_CODE"/u)
    const verifyStep = tampered.slice(tampered.indexOf('id: verify'), tampered.indexOf('- name: Assert'))
    const names = [...verifyStep.matchAll(/^\s+(TENON_[A-Z_]+):/gmu)].map((match) => match[1] ?? '')
    expect(names.length).toBeGreaterThanOrEqual(3)
    const action = await readFile(join(ACTION_DIR, 'action.yml'), 'utf8')
    for (const name of names) expect(action, `${name} 不在 action.yml 的 env 里`).toMatch(new RegExp(`^\\s+${name}: `, 'mu'))
  })
})
