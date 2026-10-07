/**
 * `.github/workflows/verify-action-selftest.yml` 在 GitHub 的运行器上跑之前，把它里面每一步能在本机验证的都验证一遍。
 * 本机造一份运行器形状的目录（工作区 `…/work/tenon/tenon`、`RUNNER_TEMP` `…/work/_temp`，tenon 检出放在工作区的 `tenon-src`），
 * 然后把工作流里的 `run:` 命令原样取出来跑：夹具工具用检出里的 bundle 在工作区根上建出干净与被篡改的两个仓库，
 * action 调用的 run.sh（composite 的输入到环境变量的接线按 action.yml 本机还原）给出工作流断言的 exit-code 与 SARIF，
 * 断言步骤对对的结论放行、对错的结论失败。另外静态检查工作流本身：动作固定到提交 SHA、没有 continue-on-error、权限最小、
 * 检出不被搬动、tampered 作业用的环境变量名都出自 action.yml。
 * 第一次在 GitHub 上跑就失败的布局（bundle 单独拷到检出之外）也有一例：CLI 找不到 `templates/manifest.yaml`。
 * 真正只有运行器才有的东西（composite action 的步骤编排、setup-node、SARIF 上传）由工作流在 GitHub 上验证，见文件头。
 */
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { REPO_ROOT } from './integration-harness.js'
import { stageTenonCheckout } from './verify-ci-fixture.js'

const TOOL = join(REPO_ROOT, 'tools', 'verify-action-selftest.mjs')
const ACTION_DIR = join(REPO_ROOT, '.github', 'actions', 'tenon-verify')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'verify-action-selftest.yml')
const CHECKOUT_DIR = 'tenon-src'
const CHECKOUT_ACTION = `./${CHECKOUT_DIR}/.github/actions/tenon-verify`

interface Fixture {
  dir: string
  head: string
  change: string
  tampered: string | null
}

/** 运行器的目录形状：`workspace` 是 GITHUB_WORKSPACE（夹具的根），`src` 是工作区里的 tenon 检出。 */
interface Runner {
  readonly root: string
  readonly workspace: string
  readonly temp: string
  readonly src: string
}

const cleanups: string[] = []
afterAll(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

function node(args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...args], { encoding: 'utf8', cwd: options.cwd, env: options.env ?? process.env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function runner(): Promise<Runner> {
  const root = await mkdtemp(join(tmpdir(), 'verify-action-selftest-runner-'))
  cleanups.push(root)
  const workspace = join(root, 'home', 'runner', 'work', 'tenon', 'tenon')
  const temp = join(root, 'home', 'runner', 'work', '_temp')
  const src = join(workspace, CHECKOUT_DIR)
  await mkdir(temp, { recursive: true })
  stageTenonCheckout(src)
  return { root, workspace, temp, src }
}

/** 工作流里的一步在运行器上怎么跑：bash，工作区为当前目录，GITHUB_WORKSPACE 与 RUNNER_TEMP 是真的环境变量。 */
function shell(on: Runner, command: string, env: Readonly<Record<string, string>> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', command], {
    cwd: on.workspace,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKSPACE: on.workspace, RUNNER_TEMP: on.temp, ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 一个作业的文本：从 `  <id>:` 到下一个作业或文件尾。 */
function jobText(workflow: string, id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  expect(start, `缺作业 ${id}`).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(2).search(/\n {2}[A-Za-z0-9_-]+:\n/u)
  return next === -1 ? rest : rest.slice(0, next + 2)
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** `- name: <name>` 开头的一步（工作流或 action.yml 里），不含注释行。 */
function stepText(yaml: string, name: string): string[] {
  const lines = yaml.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  const start = lines.findIndex((line) => line.trimStart() === `- name: ${name}`)
  expect(start, `缺步骤 ${name}`).toBeGreaterThan(-1)
  const indent = indentOf(lines[start] ?? '')
  const end = lines.findIndex((line, at) => at > start && line.trim() !== '' && indentOf(line) <= indent)
  return lines.slice(start, end === -1 ? lines.length : end)
}

/** 一步的键所在的缩进（`- name:` 那行的破折号之后两格）。 */
function keyLines(step: readonly string[], key: string): { value: string; body: string[] } | undefined {
  const keyIndent = indentOf(step[0] ?? '') + 2
  const at = step.findIndex((line) => indentOf(line) === keyIndent && line.trimStart().startsWith(`${key}:`))
  if (at === -1) return undefined
  const value = (step[at] ?? '').trimStart().slice(key.length + 1).trim()
  const body: string[] = []
  for (const line of step.slice(at + 1)) {
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break
    body.push(line)
  }
  return { value, body }
}

/** 一步的 `run:` 文本：`>-` 折叠成一行，`|` 保留换行，内联的就是它自己。 */
function runOf(step: readonly string[]): string {
  const run = keyLines(step, 'run')
  expect(run, `步骤 ${step[0]?.trim()} 没有 run`).toBeDefined()
  if (run === undefined) return ''
  const trimmed = run.body.map((line) => line.trim())
  if (run.value === '>-') return trimmed.filter((line) => line !== '').join(' ')
  if (run.value === '|') return `${trimmed.join('\n')}\n`
  return run.value
}

/** 一步的 `env:` 或 `with:` 映射；`${{ github.workspace }}` 换成运行器的工作区。 */
function mappingOf(step: readonly string[], key: 'env' | 'with', workspace: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of keyLines(step, key)?.body ?? []) {
    const match = /^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line)
    if (match === null) continue
    out[match[1] ?? ''] = (match[2] ?? '').replaceAll('${{ github.workspace }}', workspace).replace(/^'(.*)'$/u, '$1')
  }
  return out
}

/** action.yml 的输入默认值（`default: ''` 是空串）。 */
function inputDefaults(action: string): Map<string, string> {
  const inputs = action.slice(action.indexOf('\ninputs:\n'), action.indexOf('\noutputs:\n'))
  const defaults = new Map<string, string>()
  for (const block of inputs.split(/\n {2}(?=[a-z-]+:\n)/u).slice(1)) {
    const id = /^([a-z-]+):/u.exec(block)?.[1]
    const value = /^ {4}default: (.*)$/mu.exec(block)?.[1]
    if (id !== undefined && value !== undefined) defaults.set(id, value.trim().replace(/^'(.*)'$/u, '$1'))
  }
  return defaults
}

/** composite action 的「Verify committed evidence」一步拿到的环境：每个变量按 action.yml 里的接线取输入（或 action_path）。 */
function compositeEnv(action: string, withInputs: Readonly<Record<string, string>>, actionPath: string): Record<string, string> {
  const defaults = inputDefaults(action)
  for (const id of Object.keys(withInputs)) expect(defaults.has(id), `工作流给了 action 没有的输入 ${id}`).toBe(true)
  const env: Record<string, string> = {}
  for (const [name, expression] of Object.entries(mappingOf(stepText(action, 'Verify committed evidence'), 'env', ''))) {
    if (expression === '${{ github.action_path }}') {
      env[name] = actionPath
      continue
    }
    const id = /^\$\{\{ inputs\.([a-z-]+) \}\}$/u.exec(expression)?.[1]
    expect(id, `${name} 的接线不认识：${expression}`).toBeDefined()
    env[name] = withInputs[id ?? ''] ?? defaults.get(id ?? '') ?? ''
  }
  return env
}

async function readOutputs(file: string): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return outputs
}

interface ActionOutputs {
  status: number | null
  log: string
  outputs: Map<string, string>
}

/** 工作流里「Build the <scenario> fixture repository」那一步，在运行器的工作区里原样跑。 */
async function fixture(scenario: 'clean' | 'tampered'): Promise<{ on: Runner; built: Fixture }> {
  const on = await runner()
  const workflow = await readFile(WORKFLOW, 'utf8')
  const step = stepText(jobText(workflow, scenario), `Build the ${scenario} fixture repository with the built CLI`)
  const result = shell(on, runOf(step))
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  return { on, built: JSON.parse(result.stdout) as Fixture }
}

/** 工作流里校验的那一步：clean 用本地 action（输入接线按 action.yml 还原），tampered 直接跑 run.sh。 */
async function verifyStep(on: Runner, scenario: 'clean' | 'tampered'): Promise<ActionOutputs> {
  const workflow = await readFile(WORKFLOW, 'utf8')
  const job = jobText(workflow, scenario)
  const step = stepText(job, scenario === 'clean' ? 'Run the tenon-verify action against the clean fixture' : "Run the action's verify script against the tampered fixture")
  const outputFile = join(on.temp, 'github-output')
  const summaryFile = join(on.temp, 'step-summary')
  expect(spawnSync('sh', ['-c', `: > "${outputFile}"; : > "${summaryFile}"`]).status).toBe(0)
  const uses = keyLines(step, 'uses')?.value
  let env: Record<string, string>
  let command: string
  if (uses !== undefined) {
    const action = await readFile(join(on.workspace, uses, 'action.yml'), 'utf8')
    const actionPath = join(on.workspace, uses)
    env = compositeEnv(action, mappingOf(step, 'with', on.workspace), actionPath)
    command = runOf(stepText(action, 'Verify committed evidence'))
  } else {
    env = mappingOf(step, 'env', on.workspace)
    command = runOf(step)
  }
  const result = shell(on, command, { ...env, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile })
  return { status: result.status, log: `${result.stdout}${result.stderr}`, outputs: await readOutputs(outputFile) }
}

/** 工作流里的断言步骤，输入就是校验那一步的输出。 */
async function assertStep(on: Runner, scenario: 'clean' | 'tampered', run: ActionOutputs): Promise<{ status: number | null; stderr: string }> {
  const workflow = await readFile(WORKFLOW, 'utf8')
  const step = stepText(jobText(workflow, scenario), scenario === 'clean' ? 'Assert exit-code 0 and a SARIF report without findings' : 'Assert exit-code 2 and an error-level record-chain-broken in the SARIF report')
  const result = shell(on, runOf(step), { EXIT_CODE: run.outputs.get('exit-code') ?? '', SARIF_PATH: run.outputs.get('sarif-path') ?? '' })
  return { status: result.status, stderr: result.stderr }
}

/** 断言工具直接对一个场景下结论（用来证明它对错的结论失败）。 */
function assertOutcome(scenario: string, run: ActionOutputs): { status: number | null; stderr: string } {
  const assertion = node([TOOL, 'assert', '--scenario', scenario, '--exit-code', run.outputs.get('exit-code') ?? '', '--sarif', run.outputs.get('sarif-path') ?? ''])
  return { status: assertion.status, stderr: assertion.stderr }
}

describe('verify-action-selftest：运行器形状里的夹具工具与断言', () => {
  test('干净的夹具：建在工作区根上，tenon 检出在 tenon-src 且不进提交；action 的 run.sh 给 exit-code 0、SARIF 没有任何发现，断言步骤放行', async () => {
    const { on, built } = await fixture('clean')
    expect(built.dir).toBe(on.workspace)
    // 记录是 `tenon test run` 写出的真实记录，已提交；tenon 检出被夹具忽略，所以不在任何提交里，也不会留下未跟踪的改动。
    const tracked = spawnSync('git', ['ls-files'], { cwd: built.dir, encoding: 'utf8' }).stdout.split('\n')
    expect(tracked.filter((path) => /^\.tenon\/users\/[^/]+\/tests\/demo\/.+\.json$/u.test(path))).toHaveLength(1)
    expect(tracked.some((path) => path.startsWith(`${CHECKOUT_DIR}/`))).toBe(false)
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: built.dir, encoding: 'utf8' }).stdout.trim()).toBe('')
    expect(spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: built.dir, encoding: 'utf8' }).stdout.trim()).toBe('false')

    const run = await verifyStep(on, 'clean')
    expect(run.outputs.get('exit-code'), run.log).toBe('0')
    // 没有 cli 输入：action 自己找到的就是 tenon-src 里的那份 bundle，插件根是那份检出。
    expect(run.outputs.get('sarif-path'), run.log).toContain(join(on.temp, 'tenon-verify'))
    expect(await assertStep(on, 'clean', run)).toMatchObject({ status: 0 })
    // 干净的结论不能被拿去冒充「被篡改」：断言工具对错的场景失败。
    const wrong = assertOutcome('tampered', run)
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain('exit-code 应为 2')
  }, 240_000)

  test('被篡改的夹具：一条记录改了内容没重算摘要；run.sh 不让步骤失败，给 exit-code 2，SARIF 带 error 级 tenon/record-chain-broken，断言步骤放行', async () => {
    const { on, built } = await fixture('tampered')
    expect(built.tampered).toMatch(/^\.tenon\/users\/[^/]+\/tests\/demo\/.+\.json$/u)
    const run = await verifyStep(on, 'tampered')
    expect(run.status, '脚本自己永远 exit 0：失败由后面的断言步骤判').toBe(0)
    expect(run.outputs.get('exit-code'), run.log).toBe('2')
    expect(await assertStep(on, 'tampered', run)).toMatchObject({ status: 0 })
    const wrong = assertOutcome('clean', run)
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain('exit-code 应为 0')
  }, 240_000)

  test('tenon-src 计入夹具的候选指纹：建夹具之后检出里多了一个文件，校验就判候选对不上（工作流在这两步之间不能写检出）', async () => {
    const { on } = await fixture('clean')
    await writeFile(join(on.src, 'written-after-the-fixture.txt'), 'x\n')
    const run = await verifyStep(on, 'clean')
    expect(run.outputs.get('exit-code'), run.log).toBe('2')
    expect(await assertStep(on, 'clean', run)).toMatchObject({ status: 1 })
  }, 240_000)

  test('第一次在 GitHub 上失败的布局：bundle 单独拷到检出之外，CLI 在它往上三级找 templates/manifest.yaml，找不到，夹具建不起来', async () => {
    const on = await runner()
    const lone = join(on.temp, 'selftest')
    await mkdir(lone, { recursive: true })
    await copyFile(join(on.src, 'packages', 'cli', 'dist', 'tenon.mjs'), join(lone, 'tenon.mjs'))
    const built = shell(on, `node "$GITHUB_WORKSPACE/${CHECKOUT_DIR}/tools/verify-action-selftest.mjs" fixture --cli "$RUNNER_TEMP/selftest/tenon.mjs" --out "$RUNNER_TEMP/selftest/fixture"`)
    expect(built.status).toBe(1)
    expect(built.stderr).toContain('ENOENT')
    // Node 解析入口文件的真实路径（macOS 的 /var 是 /private/var 的链接），报错里的路径是真实路径。
    expect(built.stderr).toContain(join(await realpath(on.root), 'home', 'runner', 'templates', 'manifest.yaml'))
  }, 120_000)

  test('断言工具：缺 SARIF、SARIF 不是 JSON、未知场景都是失败，不会当作通过', () => {
    expect(node([TOOL, 'assert', '--scenario', 'clean', '--exit-code', '0']).status).toBe(1)
    expect(node([TOOL, 'assert', '--scenario', 'clean', '--exit-code', '0', '--sarif', join(REPO_ROOT, 'package.json')]).status).toBe(1)
    expect(node([TOOL, 'assert', '--scenario', 'other', '--exit-code', '0']).status).toBe(1)
    expect(node([TOOL, 'assert', '--scenario', 'tampered', '--exit-code', '']).status).toBe(1)
  })

  test('夹具工具：--exclude 只收夹具根下的相对目录名，别的写法在建任何东西之前就失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verify-action-selftest-exclude-'))
    cleanups.push(root)
    for (const bad of ['../outside', '/abs', 'a/../b', 'a b', 'a\nb', '*', '.']) {
      const result = node([TOOL, 'fixture', '--cli', join(root, 'none.mjs'), '--out', join(root, 'out'), '--exclude', bad])
      expect(result.status, `--exclude ${JSON.stringify(bad)}`).toBe(1)
      expect(result.stderr).toContain('--exclude')
    }
  })
})

describe('verify-action-selftest.yml：静态约束', () => {
  test('每个远程 uses 固定到提交 SHA，只有 tenon 检出里的本地 action 例外；没有 continue-on-error（含注释之外的任何位置）', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)].map((match) => match[1] ?? '')
    expect(uses.length).toBeGreaterThanOrEqual(5)
    for (const reference of uses) {
      if (reference.startsWith('./')) expect(reference).toBe(CHECKOUT_ACTION)
      else expect(reference, `未固定到 SHA: ${reference}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u)
    }
    // 与 ci.yml 用的是同一份固定（同一个动作同一个 SHA）。
    const ci = await readFile(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    for (const reference of uses.filter((item) => !item.startsWith('./'))) expect(ci, reference).toContain(reference)
    expect(workflow).not.toMatch(/continue-on-error/u)
  })

  test('触发：手动与会碰到 action 或 verify-ci 命令的 PR；每个检出都是完整历史、放进 tenon-src；权限最小', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n {2}pull_request:\n/mu)
    const paths = workflow.slice(workflow.indexOf('    paths:'), workflow.indexOf('\npermissions:'))
    for (const path of ['.github/actions/tenon-verify/**', 'packages/cli/src/commands/verify-ci*']) expect(paths).toContain(`'${path}'`)
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/gu)].length
    expect(checkouts).toBe(2)
    expect([...workflow.matchAll(/fetch-depth: 0/gu)]).toHaveLength(checkouts)
    expect([...workflow.matchAll(/^ {10}path: tenon-src$/gmu)]).toHaveLength(checkouts)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/mu)
    // 只有会上传 SARIF 的作业拿 security-events: write。
    expect(jobText(workflow, 'clean')).toContain('security-events: write')
    expect(jobText(workflow, 'tampered')).not.toContain('security-events')
  })

  test('tenon 检出不被搬动：依赖、缓存与构建都在 tenon-src 里，没有把 bundle 或工具拷到检出之外的暂存步骤', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    for (const id of ['clean', 'tampered']) {
      const job = jobText(workflow, id)
      expect(job, id).toContain('cache-dependency-path: tenon-src/package-lock.json')
      for (const command of ['npm ci', 'npm run build']) {
        const step = stepText(job, command === 'npm ci' ? 'Install dependencies' : 'Build complete plugin runtime (tsc + CLI/server bundles + dashboard SPA)')
        expect(runOf(step), id).toBe(command)
        expect(keyLines(step, 'working-directory')?.value, `${id}: ${command}`).toBe(CHECKOUT_DIR)
      }
      expect(job).not.toMatch(/\bcp\b|\bmv\b|\brm\b|find "\$GITHUB_WORKSPACE"/u)
      expect(job).not.toContain('RUNNER_TEMP')
      // 夹具建在工作区根上，用检出里的 bundle 与工具，tenon-src 不进夹具的提交。
      const fixtureStep = runOf(stepText(job, `Build the ${id} fixture repository with the built CLI`))
      expect(fixtureStep).toContain('--cli "$GITHUB_WORKSPACE/tenon-src/packages/cli/dist/tenon.mjs"')
      expect(fixtureStep).toContain('--out "$GITHUB_WORKSPACE"')
      expect(fixtureStep).toContain('--exclude tenon-src')
    }
  })

  test('clean 作业：用 tenon-src 里的本地 action 跑，不传 cli（用的是 action 自己的 bundle，和用户的默认路径一致），上传 SARIF 用自己的 category，断言 exit-code 0；夹具由真实 CLI 以 TENON_TEST_TRUST=1 建', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    const clean = jobText(workflow, 'clean')
    expect(clean).toContain('npm run build')
    expect(clean).toContain(`uses: ${CHECKOUT_ACTION}`)
    expect(clean).not.toMatch(/^\s+cli:/mu)
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

  test('tampered 作业：夹具带 --tamper，不经 action 的失败步骤（那会让作业变红），直接跑 run.sh；环境变量名都出自 action.yml，不设 TENON_VERIFY_CLI；断言 exit-code 2', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8')
    const tampered = jobText(workflow, 'tampered')
    expect(tampered).toContain('fixture --tamper')
    expect(tampered).not.toContain(`uses: ${CHECKOUT_ACTION}`)
    expect(tampered).toContain('run: bash "$TENON_ACTION_PATH/run.sh"')
    expect(tampered).toContain('TENON_ACTION_PATH: ${{ github.workspace }}/tenon-src/.github/actions/tenon-verify')
    expect(tampered).toMatch(/assert\n? *--scenario tampered --exit-code "\$EXIT_CODE"/u)
    const verifyStep = tampered.slice(tampered.indexOf('id: verify'), tampered.indexOf('- name: Assert'))
    const names = [...verifyStep.matchAll(/^\s+(TENON_[A-Z_]+):/gmu)].map((match) => match[1] ?? '')
    expect(names.length).toBeGreaterThanOrEqual(3)
    expect(names).not.toContain('TENON_VERIFY_CLI')
    const action = await readFile(join(ACTION_DIR, 'action.yml'), 'utf8')
    for (const name of names) expect(action, `${name} 不在 action.yml 的 env 里`).toMatch(new RegExp(`^\\s+${name}: `, 'mu'))
  })
})
