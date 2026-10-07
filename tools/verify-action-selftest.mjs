#!/usr/bin/env node
/**
 * `.github/workflows/verify-action-selftest.yml` 的两个小工具，也被 packages/cli/src/verify-action-selftest.integration.test.ts
 * 在本机原样跑一遍，所以工作流里用到的每一步在 GitHub 上跑之前都已经在本机验证过：
 *
 *   fixture --cli <tenon.mjs> --out <dir> [--exclude <dir>]... [--tamper]
 *       在 <dir> 里建一个小的 git 仓库：基线提交（测试目录、工作流、测试脚本、被测文件），分支 pr 上是交付提交（任务状态、
 *       实现、`tenon test run` 写出的真实运行记录）。`--tamper` 再加一个提交，改掉一条记录的内容而不重算摘要——记录链断，
 *       `tenon verify --ci` 必须失败。运行记录由真实的 CLI 用 TENON_TEST_TRUST=1 产出（CI 的用法：运行器显式信任这个检出里的
 *       目录命令）；HOME 与运行时根都换成临时目录，不碰运行器 / 开发机上的真实状态。
 *       `--cli` 必须是 tenon 检出里的那份 bundle：CLI 从自己所在的位置（`packages/cli/dist/tenon.mjs` 往上三级）找
 *       `templates/manifest.yaml`，单独拷到别处的 bundle 起不来。夹具可以直接建在工作区根上、tenon 检出放在其中的子目录里：
 *       `--exclude <dir>` 把这个子目录写进夹具的 .gitignore，不进提交。候选指纹按文件系统遍历（不看 .gitignore），
 *       所以那个检出里的文件在建夹具到校验之间不能变。
 *   assert --scenario clean|tampered --exit-code <code> [--sarif <file>]
 *       断言 action 的输出：clean 要 exit-code 0 且 SARIF 里没有任何结果；tampered 要 exit-code 2 且 SARIF 里有 error 级的
 *       tenon/record-chain-broken。不符就退出 1 并说明是哪一条。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHANGE = 'demo'
export const TAMPERED_RULE = 'tenon/record-chain-broken'
const AUTHOR = { TENON_USER: 'ci@tenon.test', TENON_USER_NAME: 'CI' }
const GIT_IDENTITY = ['-c', 'user.name=Tenon selftest', '-c', 'user.email=selftest@tenon.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    label: unit
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
`

const WORKFLOW = `name: selftest
tracks:
  backend:
    steps:
      - id: build
        label: build
        gate: null
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
        label: verify
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

/** 套件命令：写一份两个用例都通过的 JUnit 报告（不依赖任何测试框架）。 */
const GEN_REPORT = `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/unit.xml', '<?xml version="1.0"?><testsuites><testsuite name="t" tests="2" failures="0">'
  + '<testcase name="first" classname="t" file="src/a.test.js"/><testcase name="second" classname="t" file="src/a.test.js"/></testsuite></testsuites>')
`

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  return result
}

function must(result, what) {
  if (result.status !== 0) throw new Error(`${what} 失败（退出 ${result.status}）\n${result.stdout}\n${result.stderr}`)
  return result
}

function write(root, path, text) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

/** 改一条记录的内容，不重算摘要：这就是「伪造记录」。返回被改的文件（仓库相对路径）。 */
function tamperWithRecord(root) {
  const users = join(root, '.tenon', 'users')
  for (const user of readdirSync(users)) {
    const dir = join(users, user, 'tests', CHANGE)
    const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    const first = names[0]
    if (first === undefined) continue
    const file = join(dir, first)
    const record = JSON.parse(readFileSync(file, 'utf8'))
    record.machine_label = 'forged'
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
    return join('.tenon', 'users', user, 'tests', CHANGE, first)
  }
  throw new Error('没有找到可以篡改的运行记录')
}

/** `--exclude` 的值：夹具根下的相对目录名（可带子目录），不含 `..`、通配符与换行，所以只会写成 .gitignore 里的一行。 */
const EXCLUDE_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u

export function buildFixture({ cli, out, tamper = false, exclude = [] }) {
  for (const name of exclude) {
    if (!EXCLUDE_PATTERN.test(name) || name.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error(`--exclude 要夹具根下的相对目录名，收到 ${JSON.stringify(name)}`)
    }
  }
  const cliPath = resolve(cli)
  const outDir = resolve(out)
  const scratch = mkdtempSync(join(tmpdir(), 'tenon-selftest-state-'))
  try {
    mkdirSync(outDir, { recursive: true })
    const git = (...args) => must(run('git', [...GIT_IDENTITY, ...args], { cwd: outDir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }), `git ${args.join(' ')}`)
    // 真实 CLI 的环境：声明的作者、运行器对这个检出里目录命令的显式信任；HOME 与运行时根是临时的。
    const env = {
      ...process.env,
      ...AUTHOR,
      TENON_TEST_TRUST: '1',
      HOME: join(scratch, 'home'),
      TENON_RUNTIME_HOME: join(scratch, 'runtime'),
      TENON_TEST_REAL_DIFF: '1',
    }
    mkdirSync(env.HOME, { recursive: true })
    mkdirSync(env.TENON_RUNTIME_HOME, { recursive: true })
    const tenon = (...args) => must(run(process.execPath, [cliPath, ...args], { cwd: outDir, env }), `tenon ${args.join(' ')}`)

    write(outDir, 'package.json', '{ "name": "tenon-verify-selftest", "private": true, "type": "module" }\n')
    write(outDir, '.gitignore', `${['test-results', 'node_modules', '.pipeline/cache', '.pipeline/.gitignore', ...exclude.map((name) => `/${name}/`)].join('\n')}\n`)
    write(outDir, 'gen-report.mjs', GEN_REPORT)
    write(outDir, 'src/a.test.js', 'export {}\n')
    write(outDir, '.tenon/tests/catalog.yaml', CATALOG)
    write(outDir, '.pipeline/workflows/selftest.yaml', WORKFLOW)
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'pr')

    tenon('init', CHANGE, '--track', 'backend', '--workflow', 'selftest', '--preset', 'full')
    write(outDir, 'src/feature.js', 'export const feature = () => 1\n')
    tenon('test', 'register', CHANGE, '--suite', 'unit')
    tenon('test', 'register', CHANGE, '--file', 'src/a.test.js', '--suite', 'unit')
    tenon('test', 'run', CHANGE, '--stage')
    git('add', '-A')
    git('commit', '-q', '-m', 'deliver demo')
    let tampered = null
    if (tamper) {
      tampered = tamperWithRecord(outDir)
      git('add', '-A')
      git('commit', '-q', '-m', 'tamper with a run record')
    }
    return { dir: outDir, head: git('rev-parse', 'HEAD').stdout.trim(), change: CHANGE, tampered }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function assertOutcome({ scenario, exitCode, sarifText }) {
  const problems = []
  if (scenario !== 'clean' && scenario !== 'tampered') return [`未知场景 ${scenario}（要么 clean 要么 tampered）`]
  const expectedExit = scenario === 'clean' ? '0' : '2'
  if (exitCode !== expectedExit) problems.push(`exit-code 应为 ${expectedExit}，实际是 ${exitCode === '' ? '（空）' : exitCode}`)
  if (sarifText === undefined) {
    problems.push('没有 SARIF 报告（sarif-path 为空或文件读不出）')
    return problems
  }
  let results
  try {
    results = JSON.parse(sarifText).runs.flatMap((run) => run.results ?? [])
  } catch (error) {
    return [...problems, `SARIF 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`]
  }
  if (scenario === 'clean' && results.length !== 0) {
    problems.push(`干净的夹具不该有任何发现，SARIF 里有 ${results.length} 条：${results.map((item) => `${item.level}:${item.ruleId}`).join(', ')}`)
  }
  if (scenario === 'tampered' && !results.some((item) => item.ruleId === TAMPERED_RULE && item.level === 'error')) {
    problems.push(`篡改过的夹具应有 error 级的 ${TAMPERED_RULE}，SARIF 里是：${results.map((item) => `${item.level}:${item.ruleId}`).join(', ') || '（没有结果）'}`)
  }
  return problems
}

function option(args, name) {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

function main(argv) {
  const [command, ...args] = argv
  if (command === 'fixture') {
    const [cli, out] = ['cli', 'out'].map((name) => option(args, name))
    if (cli === undefined || out === undefined) throw new Error('用法：fixture --cli <tenon.mjs> --out <dir> [--exclude <dir>]... [--tamper]')
    const exclude = args.flatMap((arg, at) => (arg === '--exclude' && args[at + 1] !== undefined ? [args[at + 1]] : []))
    process.stdout.write(`${JSON.stringify(buildFixture({ cli, out, tamper: args.includes('--tamper'), exclude }))}\n`)
    return 0
  }
  if (command === 'assert') {
    const scenario = option(args, 'scenario') ?? ''
    const exitCode = option(args, 'exit-code') ?? ''
    const sarif = option(args, 'sarif')
    let sarifText
    try {
      sarifText = sarif === undefined || sarif === '' ? undefined : readFileSync(sarif, 'utf8')
    } catch {
      sarifText = undefined
    }
    const problems = assertOutcome({ scenario, exitCode, sarifText })
    for (const problem of problems) process.stderr.write(`[verify-action-selftest] ${problem}\n`)
    if (problems.length === 0) process.stdout.write(`[verify-action-selftest] ${scenario}: exit-code ${exitCode}，SARIF 符合预期\n`)
    return problems.length === 0 ? 0 : 1
  }
  throw new Error('用法：verify-action-selftest.mjs fixture|assert …')
}

/** 直接运行（而不是被 import）：入口路径取真实路径再比，经符号链接（macOS 的 /var → /private/var）调用也不会静默什么都不做就 exit 0。 */
function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[verify-action-selftest] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
