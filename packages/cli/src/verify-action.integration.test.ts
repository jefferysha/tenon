/**
 * `.github/actions/tenon-verify`：composite action 的逻辑全在 run.sh，这里在示例仓库（开发者仓库 → 克隆成 CI）上用伪造的
 * GITHUB_* 环境真跑它：干净的 PR 通过并产出 SARIF 与作业摘要；伪造记录的 PR 让 exit-code 非 0 且 SARIF 带对应规则。
 * 另做 action.yml 的静态检查：每个 uses 固定到提交 SHA，run.sh 只通过 env 取输入。
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { REPO_ROOT } from './integration-harness.js'
import { validateAgainst } from './schema-validation-fixture.js'
import { ciCheckout, devProject, rewriteRecords, stageTenonCheckout, type CiCheckout } from './verify-ci-fixture.js'

const ACTION_DIR = join(REPO_ROOT, '.github', 'actions', 'tenon-verify')
const CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'main.js')

interface Run {
  status: number | null
  stdout: string
  outputs: Map<string, string>
  summary: string
}

async function runAction(ci: CiCheckout, cleanups: Array<() => Promise<void>>, env: Record<string, string> = {}): Promise<Run> {
  const temp = await mkdtemp(join(tmpdir(), 'verify-action-'))
  cleanups.push(() => rm(temp, { recursive: true, force: true }))
  const outputFile = join(temp, 'github-output')
  const summaryFile = join(temp, 'step-summary')
  spawnSync('sh', ['-c', `: > "${outputFile}"; : > "${summaryFile}"`])
  const result = spawnSync('bash', [join(ACTION_DIR, 'run.sh')], {
    cwd: ci.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: ci.dir,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_BASE_REF: 'main',
      RUNNER_TEMP: temp,
      TENON_ACTION_PATH: ACTION_DIR,
      TENON_VERIFY_CLI: CLI,
      TENON_VERIFY_FETCH_NOTES: 'false',
      TENON_USER: '',
      ...env,
    },
  })
  const outputs = new Map<string, string>()
  for (const line of (await readFile(outputFile, 'utf8')).split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs.set(line.slice(0, eq), line.slice(eq + 1))
  }
  const summary = await readFile(summaryFile, 'utf8')
  return { status: result.status, stdout: `${result.stdout}${result.stderr}`, outputs, summary }
}

describe('tenon-verify action', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function ci(): Promise<CiCheckout> {
    const dev = await devProject()
    cleanups.push(dev.cleanup)
    const checkout = await ciCheckout(dev)
    cleanups.push(checkout.cleanup)
    return checkout
  }

  test('干净的 PR：exit-code 0，SARIF 只有提示级结果且符合 schema，作业摘要写出信任边界', async () => {
    const checkout = await ci()
    const run = await runAction(checkout, cleanups)
    expect(run.status, run.stdout).toBe(0)
    expect(run.outputs.get('exit-code')).toBe('0')
    const sarifPath = run.outputs.get('sarif-path') ?? ''
    expect(sarifPath).not.toBe('')
    const sarif = JSON.parse(await readFile(sarifPath, 'utf8')) as { runs: Array<{ results: Array<{ level: string }> }> }
    expect(validateAgainst('sarif', sarif).errors).toBe('')
    // 干净的提交只可能带提示级的结果（夹具里的 task:1.1 映射没有对应的 tasks.md 条目）。
    expect(sarif.runs[0]?.results.every((item) => item.level === 'note')).toBe(true)
    expect(run.stdout).toContain('Tenon CI 校验 通过')
    expect(run.summary).toContain('## PASS')
    expect(run.summary).toContain('CI 里无法证明')
  }, 180_000)

  test('伪造记录的 PR：exit-code 2，SARIF 带 record-chain-broken 且符合 schema，摘要列出发现', async () => {
    const checkout = await ci()
    await rewriteRecords(checkout.dir, (record) => ({ ...record, result: 'pass', machine_label: 'forged' }), { rechain: false })
    checkout.commit('forge a record')
    const run = await runAction(checkout, cleanups)
    expect(run.status, run.stdout).toBe(0)
    expect(run.outputs.get('exit-code')).toBe('2')
    const sarif = JSON.parse(await readFile(run.outputs.get('sarif-path') ?? '', 'utf8')) as { runs: Array<{ results: Array<{ ruleId: string; level: string }> }> }
    const verdict = validateAgainst('sarif', sarif)
    expect(verdict.valid, verdict.errors).toBe(true)
    expect(sarif.runs[0]?.results.map((item) => item.ruleId)).toContain('tenon/record-chain-broken')
    expect(sarif.runs[0]?.results.every((item) => item.level === 'error' || item.level === 'warning' || item.level === 'note')).toBe(true)
    expect(run.summary).toContain('## FAIL')
    expect(run.summary).toContain('record-chain-broken')
    const report = JSON.parse(await readFile(run.outputs.get('report-path') ?? '', 'utf8')) as unknown
    expect(validateAgainst('verifyReport', report).errors).toBe('')
  }, 180_000)

  /**
   * 用户的用法：`uses: <owner>/<repo>/.github/actions/tenon-verify@<ref>`，不传 `cli`。GitHub 把那个 ref 的整个仓库放在
   * `<runner>/work/_actions/<owner>/<repo>/<ref>/`，工作区是用户自己的项目（另一个目录）。run.sh 在 action 目录往上三级找
   * `packages/cli/dist/tenon.mjs`，CLI 再从自己所在的位置往上三级找 `templates/manifest.yaml`：两处都是那份 action 检出。
   */
  async function releaseCheckout(paths?: readonly string[]): Promise<{ actionPath: string; release: string }> {
    const runner = await mkdtemp(join(tmpdir(), 'verify-action-runner-'))
    cleanups.push(() => rm(runner, { recursive: true, force: true }))
    const release = join(runner, 'home', 'runner', 'work', '_actions', 'jefferysha', 'tenon', 'v0.3.2')
    stageTenonCheckout(release, paths)
    return { actionPath: join(release, '.github', 'actions', 'tenon-verify'), release }
  }

  test('用户的用法：action 在 _actions/<owner>/<repo>/<ref>/，不传 cli，项目是工作区：用的是那份检出里的 bundle，插件根也在那里，exit-code 0', async () => {
    const checkout = await ci()
    const { actionPath, release } = await releaseCheckout()
    const version = (JSON.parse(await readFile(join(release, '.codex-plugin', 'plugin.json'), 'utf8')) as { version: string }).version
    const run = await runAction(checkout, cleanups, { TENON_ACTION_PATH: actionPath, TENON_VERIFY_CLI: '', TENON_VERIFY_EXPECTED_VERSION: version })
    expect(run.outputs.get('exit-code'), run.stdout).toBe('0')
    expect(run.outputs.get('sarif-path') ?? '').not.toBe('')
    expect(run.summary).toContain('## PASS')
    // 期望版本按那份检出里的插件清单读：不符就由脚本报告，说明它读的确实是那份检出。
    const wrong = await runAction(checkout, cleanups, { TENON_ACTION_PATH: actionPath, TENON_VERIFY_CLI: '', TENON_VERIFY_EXPECTED_VERSION: '9.9.9' })
    expect(wrong.outputs.get('exit-code')).toBe('1')
    expect(wrong.stdout).toContain(`expected Tenon 9.9.9 but the pinned CLI is ${version}`)
  }, 240_000)

  test('用户的用法的反面：action 的检出里没有 templates（只有 bundle 与 action 目录），CLI 起不来，exit-code 1，不会当作通过', async () => {
    const checkout = await ci()
    const { actionPath } = await releaseCheckout(['packages/cli/dist/tenon.mjs', '.github/actions/tenon-verify'])
    const run = await runAction(checkout, cleanups, { TENON_ACTION_PATH: actionPath, TENON_VERIFY_CLI: '' })
    expect(run.outputs.get('exit-code'), run.stdout).toBe('1')
    expect(run.outputs.has('sarif-path')).toBe(false)
    expect(run.stdout).toContain('templates/manifest.yaml')
  }, 240_000)

  test('选择器与输入：--change、浅克隆之外的 since、期望版本不符、缺 CLI 都由脚本报告', async () => {
    const checkout = await ci()
    const named = await runAction(checkout, cleanups, { TENON_VERIFY_CHANGE: 'demo' })
    expect(named.outputs.get('exit-code')).toBe('0')
    const unknown = await runAction(checkout, cleanups, { TENON_VERIFY_CHANGE: 'nope' })
    expect(unknown.outputs.get('exit-code')).toBe('1')
    expect(unknown.outputs.has('sarif-path')).toBe(false)
    const wrongVersion = await runAction(checkout, cleanups, { TENON_VERIFY_EXPECTED_VERSION: '9.9.9' })
    expect(wrongVersion.outputs.get('exit-code')).toBe('1')
    expect(wrongVersion.stdout).toContain('expected Tenon 9.9.9')
    const noCli = await runAction(checkout, cleanups, { TENON_VERIFY_CLI: join(checkout.dir, 'missing.mjs') })
    expect(noCli.outputs.get('exit-code')).toBe('1')
    expect(noCli.stdout).toContain('Tenon CLI not found')
  }, 240_000)

  test('language 输入：en 让摘要、SARIF 与日志都是英文，zh 与缺省是中文，非法值由脚本报告', async () => {
    const checkout = await ci()
    const cjk = /[㐀-鿿＀-￯　-〿]/u
    const en = await runAction(checkout, cleanups, { TENON_VERIFY_LANGUAGE: 'en', TENON_LANG: '' })
    expect(en.outputs.get('exit-code')).toBe('0')
    expect(en.stdout).toContain('Tenon CI verification passed')
    expect(cjk.test(en.summary), en.summary).toBe(false)
    expect(en.summary).toContain('## PASS')
    expect(en.summary).toContain('Not provable in CI')
    expect(cjk.test(await readFile(en.outputs.get('sarif-path') ?? '', 'utf8'))).toBe(false)
    expect(cjk.test(await readFile(en.outputs.get('report-path') ?? '', 'utf8'))).toBe(false)
    const zh = await runAction(checkout, cleanups, { TENON_VERIFY_LANGUAGE: 'zh', LANG: 'en_US.UTF-8', TENON_LANG: '' })
    expect(zh.stdout).toContain('Tenon CI 校验 通过')
    // 缺省：没有输入时沿用 CLI 的缺省（没有语言信号 = 中文）；输入不是 zh / en 时脚本直接失败。
    const fallback = await runAction(checkout, cleanups, { TENON_VERIFY_LANGUAGE: '', TENON_LANG: '', LC_ALL: 'C' })
    expect(fallback.stdout).toContain('Tenon CI 校验 通过')
    const invalid = await runAction(checkout, cleanups, { TENON_VERIFY_LANGUAGE: 'fr' })
    expect(invalid.outputs.get('exit-code')).toBe('1')
    expect(invalid.stdout).toContain("language must be zh or en (got 'fr')")
  }, 240_000)

  test('action.yml：每个 uses 固定到提交 SHA；输入只经 env 进入脚本；最后一步按 exit-code 失败', async () => {
    const yaml = await readFile(join(ACTION_DIR, 'action.yml'), 'utf8')
    const uses = [...yaml.matchAll(/^\s*uses:\s*(\S+)\s*(?:#.*)?$/gmu)].map((match) => match[1] ?? '')
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const reference of uses) expect(reference, `未固定到 SHA: ${reference}`).toMatch(/@[0-9a-f]{40}$/u)
    expect(yaml).toContain('using: composite')
    // run: 块里不直接展开 ${{ inputs.* }}（命令注入面）；输入全部走 env。
    const runBlocks = [...yaml.matchAll(/^\s+run:\s*(?:\|\s*\n((?:\s{8,}.*\n?)+)|(.*))$/gmu)].map((match) => match[1] ?? match[2] ?? '')
    for (const block of runBlocks) expect(block).not.toContain('${{ inputs.')
    expect(yaml).toContain("steps.verify.outputs.exit-code != '0'")
    const script = await readFile(join(ACTION_DIR, 'run.sh'), 'utf8')
    expect(script).toContain('--require-anchor')
    expect(script).toContain('refs/notes/tenon')
    // language 输入：声明在 action.yml，只经 env（TENON_VERIFY_LANGUAGE）进脚本，脚本再交给 CLI 的 TENON_LANG。
    expect(yaml).toMatch(/^  language:\n    description:[\s\S]*?default: ''/mu)
    expect(yaml).toContain('TENON_VERIFY_LANGUAGE: ${{ inputs.language }}')
    expect(script).toContain('export TENON_LANG="$TENON_VERIFY_LANGUAGE"')
  })
})
