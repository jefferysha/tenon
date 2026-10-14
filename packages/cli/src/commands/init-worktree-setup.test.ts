import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { parseTestCatalog, readTestSeal, readTrustStore, resolveProductPaths, userSlug, type TestCatalog } from '@tenon/kernel'
import { cmdInit } from './init.js'
import { BACKEND, useWorktreeInitFixture } from './init-worktree-test-support.js'
import { catalogTrustTarget, cmdTestTrust, ensureTrusted } from './test-trust.js'
import { writeFiles } from '../integration-harness-tests.js'

/**
 * 测试目录的工作区准备：信任按「用户 + 仓库 + 单条命令」记在用户级状态目录，同一仓库的所有 worktree 共享，
 * 所以主检出里信任过的 `setup` 在新 worktree 里直接生效、受信任才执行。临时仓、临时用户级状态目录，不碰真实用户目录。
 */
describe('init —— 新 worktree 的信任共享与 setup', () => {
  const fx = useWorktreeInitFixture()
  const SLUG = userSlug('tester@tenon.test')
  const CATALOG = '.tenon/tests/catalog.yaml'
  const MARKER_SETUP = `node -e "require('fs').writeFileSync('setup-ran','1')"`
  /** 关掉环境显式信任（TENON_TEST_TRUST）：只看用户级信任存储。 */
  const untrustedEnvDef = (): NodeJS.ProcessEnv => ({ ...process.env, TENON_TEST_TRUST: '' })
  const stateRoot = (): string => resolveProductPaths({ env: process.env }).stateRoot

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

  /** 在主检出里用户本人确认一次：`tenon test trust --yes`，信任写进用户级存储（不碰检出）。 */
  async function trustInMain(cwd: string): Promise<void> {
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    expect(await cmdTestTrust(deps, undefined, { yes: true }), err.join('\n')).toBe(0)
  }

  /** 换掉真执行器：记录调用，不起子进程。 */
  function fakeRunner(code = 0) {
    return vi.fn(async (_input: { command: string; cwd: string; log: (line: string) => void }) => code)
  }

  const parse = (source: string): TestCatalog => {
    const parsed = parseTestCatalog(source)
    if (!parsed.ok) throw new Error('catalog 无效')
    return parsed.catalog
  }

  test('信任只记在用户级存储里，同一仓库的 worktree 共享：init 之后存储不变，新 worktree 里不会出现检出旧封存', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: 'npm ci' }) })
    await trustInMain(cwd)
    const before = await readTrustStore(stateRoot(), SLUG)
    expect(before.length).toBeGreaterThan(0)
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    deps.setupRunner = fakeRunner()
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(await readTrustStore(stateRoot(), SLUG)).toEqual(before)
    expect((await readTestSeal(worktree, SLUG)).seal.trusted).toEqual([])
  })

  test('目录受信任且声明了 setup：在新 worktree 里执行（主检出不受影响），输出在 stderr，最后两行仍是 worktree 路径与切换做法', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: MARKER_SETUP }) })
    await trustInMain(cwd)
    const { deps, out, err } = fx.realIn(cwd, untrustedEnvDef())
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(await readFile(join(worktree, 'setup-ran'), 'utf8')).toBe('1')
    expect(existsSync(join(cwd, 'setup-ran'))).toBe(false)
    expect(out).toEqual([])
    expect(err.some((line) => line.includes('[SETUP]') && line.includes(MARKER_SETUP))).toBe(true)
    expect(err.slice(-2)[0]).toBe(`worktree: ${worktree}`)
  })

  test('setup 经注入的执行器在 worktree 里执行：收到命令原文与 worktree 路径', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: 'npm ci' }) })
    await trustInMain(cwd)
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toMatchObject({ command: 'npm ci', cwd: join(cwd, '.worktrees', 'demo') })
  })

  test('环境显式信任（TENON_TEST_TRUST=1，CI）：不需要用户级信任也执行 setup', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: 'npm ci' }) })
    const { deps, err } = fx.realIn(cwd, { ...process.env, TENON_TEST_TRUST: '1' })
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  test('--json：setup 往 stdout 和 stderr 各写一行，stdout 仍只有那一行 JSON（setup 的输出转到 stderr）', async () => {
    const setup = `node -e "console.log('NOISE-ON-STDOUT'); console.error('NOISE-ON-STDERR')"`
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup }) })
    await trustInMain(cwd)
    const { deps, out, err } = fx.realIn(cwd, untrustedEnvDef())
    expect(await cmdInit(deps, 'demo', { ...BACKEND, json: true }), err.join('\n')).toBe(0)
    expect(out).toHaveLength(1)
    expect(out[0]).not.toContain('\n')
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ change: 'demo', worktree: join(cwd, '.worktrees', 'demo') })
    expect(err.join('\n')).toContain('NOISE-ON-STDOUT')
    expect(err.join('\n')).toContain('NOISE-ON-STDERR')
  })

  test('目录未受信任：不执行 setup，提示「未受信任」与 tenon test trust，init 仍成功', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: MARKER_SETUP }) })
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
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
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml() })
    await trustInMain(cwd)
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('没有声明 setup')
    expect(err.some((line) => line.startsWith('WARN') || line.startsWith('ERROR'))).toBe(false)
  })

  test('项目没有测试目录：不提 setup，不执行', async () => {
    const { cwd } = await fx.repoWithCommit()
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(err.some((line) => line.includes('[SETUP]'))).toBe(false)
  })

  test('setup 退出码 1：init 仍返回 0、任务已建好，输出 WARN 与在 worktree 里重跑的命令；--json 的 stdout 仍是一行', async () => {
    const setup = 'node -e "process.exit(1)"'
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup }) })
    await trustInMain(cwd)
    const { deps, out, err } = fx.realIn(cwd, untrustedEnvDef())
    expect(await cmdInit(deps, 'demo', { ...BACKEND, json: true })).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(existsSync(join(worktree, 'openspec', 'changes', 'demo', '.pipeline.yaml'))).toBe(true)
    expect(err.some((line) => line.startsWith('WARN') && line.includes(`cd ${worktree} && ${setup}`))).toBe(true)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ worktree })
  })

  test('在 worktree 里改了套件命令：只有改动的命令未信任，原有的命令仍受信任，用户级存储不变', async () => {
    const text = catalogYaml({ setup: 'npm ci' })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: text })
    await trustInMain(cwd)
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    deps.setupRunner = fakeRunner()
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    const stored = await readTrustStore(stateRoot(), SLUG)
    const at = fx.realIn(worktree, untrustedEnvDef())
    expect(await ensureTrusted(at.deps, SLUG, catalogTrustTarget(parse(text)), 'demo')).toBe(true)
    await writeFiles(worktree, { [CATALOG]: catalogYaml({ setup: 'npm ci', command: 'node evil.mjs' }) })
    const changed = parse(await readFile(join(worktree, CATALOG), 'utf8'))
    expect(await ensureTrusted(at.deps, SLUG, catalogTrustTarget(changed), 'demo')).toBe(false)
    expect(at.err.join('\n')).toContain('tenon test trust demo')
    expect(await readTrustStore(stateRoot(), SLUG)).toEqual(stored)
  })

  test('主检出里 setup 有未提交改动并已在主检出信任：新 worktree 里是已提交的那条命令，判为未信任，setup 不执行并提示', async () => {
    const committed = catalogYaml({ setup: MARKER_SETUP })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: committed })
    const edited = catalogYaml({ setup: `node -e "require('fs').writeFileSync('setup-edited','1')"` })
    await writeFiles(cwd, { [CATALOG]: edited })
    await trustInMain(cwd)
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(await readFile(join(worktree, CATALOG), 'utf8')).toBe(committed)
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(worktree, 'setup-ran'))).toBe(false)
    expect(err.join('\n')).toContain('未受信任')
  })

  test('主检出里只有套件命令改了、setup 没变：setup 的摘要不变，新 worktree 里照常执行', async () => {
    const committed = catalogYaml({ setup: MARKER_SETUP })
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: committed })
    await writeFiles(cwd, { [CATALOG]: catalogYaml({ setup: MARKER_SETUP, command: 'node run-edited.mjs' }) })
    await trustInMain(cwd)
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  test('原地建立（TENON_INIT_IN_PLACE=1）：没有新 worktree，不执行 setup', async () => {
    const { cwd } = await fx.repoWithCommit({ [CATALOG]: catalogYaml({ setup: MARKER_SETUP }) })
    await trustInMain(cwd)
    process.env.TENON_INIT_IN_PLACE = '1'
    const { deps, err } = fx.realIn(cwd, untrustedEnvDef())
    const runner = fakeRunner()
    deps.setupRunner = runner
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, 'setup-ran'))).toBe(false)
    expect(err.some((line) => line.includes('[SETUP]'))).toBe(false)
  })
})
