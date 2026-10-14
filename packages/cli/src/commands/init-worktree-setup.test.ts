import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  catalogExecDigest, parseTestCatalog, readTestSeal, sealSharedWrite, updateTestSeal, userSlug,
  type TestCatalog,
} from '@tenon/kernel'
import { cmdInit } from './init.js'
import { BACKEND, useWorktreeInitFixture } from './init-worktree-test-support.js'
import { catalogTrustTarget, ensureTrusted } from './test-trust.js'
import { writeFiles } from '../integration-harness-tests.js'

/** 测试目录的工作区准备：信任从主检出继承，受信任才在新 worktree 里执行 setup。临时仓、临时封存，不碰真实用户目录。 */
describe('init —— 新 worktree 的信任继承与 setup', () => {
  const fx = useWorktreeInitFixture()
  const SLUG = userSlug('tester@tenon.test')
  const CATALOG = '.tenon/tests/catalog.yaml'
  const MARKER_SETUP = `node -e "require('fs').writeFileSync('setup-ran','1')"`
  const TRUSTED = { digest: `sha256:${'a'.repeat(64)}`, by: 'tester@tenon.test', at: '2026-01-01T00:00:00Z' }

  function catalogYaml(opts: { setup?: string; command?: string } = {}): string {
    return [
      'schema: tenon-test-catalog/v1',
      ...(opts.setup === undefined ? [] : [`setup: ${JSON.stringify(opts.setup)}`]),
      'suites:',
      '  - id: unit',
      '    kind: unit',
      '    runner: custom',
      `    command: ${opts.command ?? 'node run.mjs'}`,
      '    report: { format: junit, path: test-results/unit.xml }',
      '    artifacts: [test-results/unit.xml]',
      '',
    ].join('\n')
  }

  function execDigest(text: string): string {
    const parsed = parseTestCatalog(text)
    if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join('；'))
    return catalogExecDigest(parsed.catalog)
  }

  /** 在主检出里记一条「本用户信任了这份目录」。 */
  async function trustInMain(cwd: string, text: string): Promise<void> {
    await updateTestSeal(cwd, SLUG, (seal) => ({ ...seal, trusted: [...seal.trusted, { ...TRUSTED, digest: execDigest(text) }] }))
  }

  /** 换掉真执行器：记录调用，不起子进程。 */
  function fakeRunner(code = 0) {
    return vi.fn(async (_input: { command: string; cwd: string; log: (line: string) => void }) => code)
  }

  test('主检出的信任条目带进新 worktree：trusted 含同一摘要，approvals 与 writes 为空，主检出的封存不变', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml() })
    await updateTestSeal(cwd, SLUG, (seal) => ({
      ...seal,
      trusted: [TRUSTED],
      approvals: [{ change: 'old', path: '.tenon/tests/known-failures.yaml', digest: 'sha256:x', by: 'tester@tenon.test', at: '2026-01-02T00:00:00Z' }],
    }))
    await sealSharedWrite(cwd, SLUG, [{ path: '.tenon/tests/baselines/b.json', digest: 'sha256:w' }], '2026-01-03T00:00:00Z')
    const before = await readTestSeal(cwd, SLUG)
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const inherited = await readTestSeal(join(cwd, '.worktrees', 'demo'), SLUG)
    expect(inherited.state).toBe('ok')
    expect(inherited.seal.trusted).toEqual([TRUSTED])
    expect(inherited.seal.approvals).toEqual([])
    expect(inherited.seal.writes).toEqual({})
    expect(await readTestSeal(cwd, SLUG)).toEqual(before)
  })

  test('目录受信任且声明了 setup：在新 worktree 里执行（主检出不受影响），输出在 stderr，最后两行仍是 worktree 路径与切换做法', async () => {
    const text = catalogYaml({ setup: MARKER_SETUP })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(await readFile(join(worktree, 'setup-ran'), 'utf8')).toBe('1')
    expect(existsSync(join(cwd, 'setup-ran'))).toBe(false)
    expect(out).toEqual([])
    expect(err.some((line) => line.includes('[SETUP]') && line.includes(MARKER_SETUP))).toBe(true)
    expect(err.slice(-2)[0]).toBe(`worktree: ${worktree}`)
  })

  test('setup 经注入的执行器在 worktree 里执行：收到命令原文与 worktree 路径', async () => {
    const text = catalogYaml({ setup: 'npm ci' })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    const { deps, err } = fx.realIn(cwd)
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toMatchObject({ command: 'npm ci', cwd: join(cwd, '.worktrees', 'demo') })
  })

  test('--json：setup 往 stdout 和 stderr 各写一行，stdout 仍只有那一行 JSON（setup 的输出转到 stderr）', async () => {
    const setup = `node -e "console.log('NOISE-ON-STDOUT'); console.error('NOISE-ON-STDERR')"`
    const text = catalogYaml({ setup })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { ...BACKEND, json: true }), err.join('\n')).toBe(0)
    expect(out).toHaveLength(1)
    expect(out[0]).not.toContain('\n')
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ change: 'demo', worktree: join(cwd, '.worktrees', 'demo') })
    expect(err.join('\n')).toContain('NOISE-ON-STDOUT')
    expect(err.join('\n')).toContain('NOISE-ON-STDERR')
  })

  test('目录未受信任：不执行 setup，提示「未受信任」与 tenon test trust，init 仍成功', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: MARKER_SETUP }) })
    const { deps, err } = fx.realIn(cwd)
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(worktree, 'setup-ran'))).toBe(false)
    const text = err.join('\n')
    expect(text).toContain('未受信任')
    expect(text).toContain(`cd ${worktree} && tenon test trust`)
    expect(text).toContain(`cd ${worktree} && ${MARKER_SETUP}`)
  })

  test('目录没有 setup：跳过，不报错，不执行', async () => {
    const text = catalogYaml()
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    const { deps, err } = fx.realIn(cwd)
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('没有声明 setup')
    expect(err.some((line) => line.startsWith('WARN') || line.startsWith('ERROR'))).toBe(false)
  })

  test('项目没有测试目录：不提 setup，不执行', async () => {
    const { cwd } = await fx.repoWithCommit()
    const { deps, err } = fx.realIn(cwd)
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(err.some((line) => line.includes('[SETUP]'))).toBe(false)
  })

  test('setup 退出码 1：init 仍返回 0、任务已建好，输出 WARN 与在 worktree 里重跑的命令；--json 的 stdout 仍是一行', async () => {
    const setup = 'node -e "process.exit(1)"'
    const text = catalogYaml({ setup })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { ...BACKEND, json: true })).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(existsSync(join(worktree, 'openspec', 'changes', 'demo', '.pipeline.yaml'))).toBe(true)
    expect(err.some((line) => line.startsWith('WARN') && line.includes(`cd ${worktree} && ${setup}`))).toBe(true)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ worktree })
  })

  test('在 worktree 里改了套件命令：该 worktree 里判为未信任，主检出的封存不变', async () => {
    const text = catalogYaml({ setup: 'npm ci' })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    const { deps, err } = fx.realIn(cwd)
    deps.setupRunner = fakeRunner()
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    const mainSeal = await readTestSeal(cwd, SLUG)
    // 环境显式信任（TENON_TEST_TRUST）关掉：只看封存。
    const at = fx.realIn(worktree, { ...process.env, TENON_TEST_TRUST: '' })
    const parse = (source: string): TestCatalog => {
      const parsed = parseTestCatalog(source)
      if (!parsed.ok) throw new Error('catalog 无效')
      return parsed.catalog
    }
    expect(await ensureTrusted(at.deps, SLUG, catalogTrustTarget(parse(text)), 'demo')).toBe(true)
    await writeFiles(worktree, { [CATALOG]: catalogYaml({ setup: 'npm ci', command: 'node evil.mjs' }) })
    const changed = parse(await readFile(join(worktree, CATALOG), 'utf8'))
    expect(await ensureTrusted(at.deps, SLUG, catalogTrustTarget(changed), 'demo')).toBe(false)
    expect(at.err.join('\n')).toContain('tenon test trust demo')
    expect(await readTestSeal(cwd, SLUG)).toEqual(mainSeal)
  })

  test('主检出的目录有未提交改动并已在主检出信任：新 worktree 里是 HEAD 版本，判为未信任，setup 不执行并提示', async () => {
    const committed = catalogYaml({ setup: MARKER_SETUP })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: committed })
    const edited = catalogYaml({ setup: MARKER_SETUP, command: 'node run-edited.mjs' })
    await writeFiles(cwd, { [CATALOG]: edited })
    await trustInMain(cwd, edited)
    const { deps, err } = fx.realIn(cwd)
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(await readFile(join(worktree, CATALOG), 'utf8')).toBe(committed)
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(worktree, 'setup-ran'))).toBe(false)
    expect(err.join('\n')).toContain('未受信任')
  })

  test('原地建立（TENON_INIT_IN_PLACE=1）：没有新 worktree，不继承信任也不执行 setup', async () => {
    const text = catalogYaml({ setup: MARKER_SETUP })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd, text)
    process.env.TENON_INIT_IN_PLACE = '1'
    const { deps, err } = fx.realIn(cwd)
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, 'setup-ran'))).toBe(false)
    expect(err.some((line) => line.includes('[SETUP]'))).toBe(false)
  })
})
