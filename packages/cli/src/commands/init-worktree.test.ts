import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { changedFilesForState, computeContentHash } from '@tenon/kernel'
import { cmdInit } from './init.js'
import { BACKEND, TWO_STEP_WF, useWorktreeInitFixture } from './init-worktree-test-support.js'
import { makeHarness } from '../integration-harness.js'
import { VITEST_FILES, git, writeFiles } from '../integration-harness-tests.js'

/**
 * 新任务建在自己的 git worktree 里：真临时 git 仓 + 真 deps（真 store、真 git）。
 * 夹具（TENON_INIT_IN_PLACE 的保存/恢复、临时目录清理、建仓与 realIn）在 init-worktree-test-support.ts。
 */
describe('init —— 新任务建在 worktree 里', () => {
  const fx = useWorktreeInitFixture()

  test('主检出建任务：任务在 .worktrees/demo 里，base_branch/isolation/start_sha 正确，主检出没有变化', async () => {
    const { cwd, head } = await fx.repoWithCommit()
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    const yaml = await readFile(join(worktree, 'openspec', 'changes', 'demo', '.pipeline.yaml'), 'utf8')
    expect(yaml).toContain('\nbase_branch: main\n')
    expect(yaml).toContain('\nisolation: worktree\n')
    // start_sha 的物理值在伴随文件里，投影保持上一正式版认得的闭集；逻辑值经 get 读回。
    expect(yaml).not.toContain('start_sha')
    expect(await deps.store.get(join(worktree, 'openspec', 'changes', 'demo'), 'start_sha')).toBe(head)
    expect(existsSync(join(cwd, 'openspec', 'changes', 'demo'))).toBe(false)
    expect(git(cwd, ['worktree', 'list', '--porcelain'])).toContain('branch refs/heads/tenon/demo')
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('tenon/demo')
    expect(fx.status(cwd)).toBe('')
    expect(out).toEqual([])
    expect(err).toContain(`[INIT] ${join(worktree, 'openspec', 'changes', 'demo')}`)
  })

  test('文本输出末尾两行：worktree 路径与切进去的做法（Claude Code 的 EnterWorktree、Codex 开新会话）', async () => {
    const { cwd } = await fx.repoWithCommit()
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(err.slice(-2)).toEqual([
      `worktree: ${worktree}`,
      `Claude Code：EnterWorktree path=${worktree} 后执行 tenon session activate；Codex：在该目录开新会话`,
    ])
  })

  test('--json：stdout 一行 JSON，带 worktree 绝对路径，worktree_reason 为 null；不再打印文本提示', async () => {
    const { cwd } = await fx.repoWithCommit()
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { ...BACKEND, json: true }), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] ?? '')).toEqual({
      change: 'demo',
      path: join(worktree, 'openspec', 'changes', 'demo'),
      worktree,
      worktree_reason: null,
    })
    expect(err.some((line) => line.startsWith('worktree: '))).toBe(false)
  })

  test('初始化失败（initChange 抛错）：worktree 与分支都回滚，主检出无残留，错误原样报出', async () => {
    const { cwd } = await fx.repoWithCommit()
    const { deps, err } = fx.realIn(cwd)
    const real = deps.runRepo.initChange.bind(deps.runRepo)
    vi.spyOn(deps.runRepo, 'initChange').mockImplementation(async (opts) => {
      await real(opts)
      throw new Error('boom: 初始化中途失败')
    })
    expect(await cmdInit(deps, 'demo', BACKEND)).toBe(1)
    expect(err.join('\n')).toContain('boom: 初始化中途失败')
    expect(existsSync(join(cwd, '.worktrees', 'demo'))).toBe(false)
    expect(fx.branches(cwd)).toBe('')
    expect(git(cwd, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
    expect(fx.status(cwd)).toBe('')
  })

  /** 升级前的版本留在主检出里的宿主 agent 文件（内容记进所有权清单，清单口径的删除依据成立）。 */
  async function legacyHostAgent(cwd: string): Promise<string> {
    const rel = '.claude/agents/tenon-builder.md'
    await writeFiles(cwd, { [rel]: '旧版本写的\n' })
    await writeFile(join(cwd, '.pipeline-owned.json'), `${JSON.stringify({ [rel]: computeContentHash('旧版本写的\n') })}\n`, 'utf8')
    return join(cwd, rel)
  }

  test('旧项目级宿主 agent 文件在建任务全部成功（含项目登记）之后才清理，之后照常清掉', async () => {
    const { cwd } = await fx.repoWithCommit()
    const legacy = await legacyHostAgent(cwd)
    const { deps, err } = fx.realIn(cwd)
    const seenAtRegister: boolean[] = []
    deps.registerProject = async () => { seenAtRegister.push(existsSync(legacy)) }
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(seenAtRegister).toEqual([true])
    expect(existsSync(legacy)).toBe(false)
    expect(err.join('\n')).toContain('已清理旧版本写进项目的宿主 agent 文件')
  })

  test('初始化中途失败回滚 worktree 时，旧项目级宿主 agent 文件原样保留（清理不在回滚范围内）', async () => {
    const { cwd } = await fx.repoWithCommit()
    const legacy = await legacyHostAgent(cwd)
    const { deps, err } = fx.realIn(cwd)
    const real = deps.runRepo.initChange.bind(deps.runRepo)
    vi.spyOn(deps.runRepo, 'initChange').mockImplementation(async (opts) => {
      await real(opts)
      throw new Error('boom: 初始化中途失败')
    })
    expect(await cmdInit(deps, 'demo', BACKEND)).toBe(1)
    expect(existsSync(join(cwd, '.worktrees', 'demo'))).toBe(false)
    expect(await readFile(legacy, 'utf8')).toBe('旧版本写的\n')
    expect(err.join('\n')).not.toContain('已清理旧版本写进项目的宿主 agent 文件')
  })

  test('清理本身失败只 WARN：任务照常建好，退出码 0', async () => {
    const { cwd } = await fx.repoWithCommit()
    const legacy = await legacyHostAgent(cwd)
    // .tenon 是文件而不是目录：清理要在 .tenon 下建锁目录，建不出来。
    await writeFiles(cwd, { '.tenon': '我是个文件，不是目录' })
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    expect(existsSync(join(cwd, '.worktrees', 'demo', 'openspec', 'changes', 'demo'))).toBe(true)
    expect(await readFile(legacy, 'utf8')).toBe('旧版本写的\n')
    expect(err.join('\n')).toMatch(/WARN: .*清理失败/u)
  })

  test('.worktrees/demo 已有同名普通目录：报冲突退出，目录内容不变，没有分支和任务状态', async () => {
    const { cwd } = await fx.repoWithCommit()
    await writeFiles(cwd, { '.worktrees/demo/mine.txt': '用户自己的文件\n' })
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND)).toBe(1)
    expect(err.join('\n')).toContain(join(cwd, '.worktrees', 'demo'))
    expect(await readFile(join(cwd, '.worktrees', 'demo', 'mine.txt'), 'utf8')).toBe('用户自己的文件\n')
    expect(existsSync(join(cwd, '.worktrees', 'demo', 'openspec'))).toBe(false)
    expect(fx.branches(cwd)).toBe('')
  })

  test('分支 tenon/demo 已存在：失败退出，.worktrees/demo 与任务状态都没有创建', async () => {
    const { cwd } = await fx.repoWithCommit()
    git(cwd, ['branch', 'tenon/demo'])
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND)).toBe(1)
    expect(err.join('\n')).toContain('tenon/demo')
    expect(existsSync(join(cwd, '.worktrees', 'demo'))).toBe(false)
    expect(existsSync(join(cwd, 'openspec', 'changes', 'demo'))).toBe(false)
  })

  test('主检出已有同名任务（未提交，不在 HEAD 里）：建 worktree 的路径同样拒绝，报错与原地撞名一致，什么都不建', async () => {
    const { cwd } = await fx.repoWithCommit()
    // 先原地建一个 demo：它的状态目录在主检出里、未提交，新 worktree 里不会有它。
    process.env.TENON_INIT_IN_PLACE = '1'
    const first = fx.realIn(cwd)
    expect(await cmdInit(first.deps, 'demo', BACKEND), first.err.join('\n')).toBe(0)
    const stateFile = join(cwd, 'openspec', 'changes', 'demo', '.pipeline.yaml')
    const before = await readFile(stateFile, 'utf8')
    // 原地再建同名：store.init 拒绝，这是基准文案。
    const again = fx.realIn(cwd)
    expect(await cmdInit(again.deps, 'demo', BACKEND)).toBe(1)
    const refusal = `ERROR: init: change 已存在，拒绝覆盖: ${join(cwd, 'openspec', 'changes', 'demo')}`
    expect(again.err).toContain(refusal)

    delete process.env.TENON_INIT_IN_PLACE
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND)).toBe(1)
    expect(err).toContain(refusal)
    expect(out).toEqual([])
    expect(existsSync(join(cwd, '.worktrees', 'demo'))).toBe(false)
    expect(fx.branches(cwd)).toBe('')
    expect(git(cwd, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
    expect(await readFile(stateFile, 'utf8')).toBe(before)
  })

  test('--in-place 建同名任务：行为与改动前一致，store.init 拒绝覆盖，主检出原任务不变', async () => {
    const { cwd } = await fx.repoWithCommit()
    const first = fx.realIn(cwd)
    expect(await cmdInit(first.deps, 'demo', { ...BACKEND, inPlace: true }), first.err.join('\n')).toBe(0)
    const stateFile = join(cwd, 'openspec', 'changes', 'demo', '.pipeline.yaml')
    const before = await readFile(stateFile, 'utf8')
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { ...BACKEND, inPlace: true })).toBe(1)
    expect(err).toContain(`ERROR: init: change 已存在，拒绝覆盖: ${join(cwd, 'openspec', 'changes', 'demo')}`)
    expect(existsSync(join(cwd, '.worktrees'))).toBe(false)
    expect(fx.branches(cwd)).toBe('')
    expect(await readFile(stateFile, 'utf8')).toBe(before)
  })

  test('track 非法：校验先于建 worktree，什么都不建', async () => {
    const { cwd } = await fx.repoWithCommit()
    const { deps } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { track: 'devops', preset: 'full' })).toBe(1)
    expect(existsSync(join(cwd, '.worktrees'))).toBe(false)
    expect(fx.branches(cwd)).toBe('')
  })

  test('主检出没有测试目录（触发自动发现）：目录写进 worktree，登记的项目是 worktree，主检出 git status 为空', async () => {
    const { cwd } = await fx.repoWithCommit(VITEST_FILES)
    const { deps, err } = fx.realIn(cwd)
    const registered: string[] = []
    deps.registerProject = async (root) => { registered.push(root) }
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(existsSync(join(worktree, '.tenon', 'tests', 'catalog.yaml'))).toBe(true)
    expect(existsSync(join(cwd, '.tenon'))).toBe(false)
    expect(registered).toEqual([worktree])
    expect(fx.status(cwd)).toBe('')
  })

  test('主检出 .pipeline/workflows 里的自定义工作流：按主检出解析，冻结进 worktree 里的任务', async () => {
    const { cwd } = await fx.repoWithCommit()
    await writeFiles(cwd, { '.pipeline/workflows/onboarding.yaml': TWO_STEP_WF })
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { workflow: 'onboarding' }), err.join('\n')).toBe(0)
    const worktree = join(cwd, '.worktrees', 'demo')
    expect(existsSync(join(worktree, '.pipeline'))).toBe(false)
    const yaml = await readFile(join(worktree, 'openspec', 'changes', 'demo', '.pipeline.yaml'), 'utf8')
    expect(yaml).toContain('\nworkflow: onboarding\n')
    expect(yaml).toContain('\nphase: intake\n')
  })

  test('TENON_INIT_IN_PLACE=1：原地建立，isolation 不预设，不输出原因，没有 .worktrees', async () => {
    const { cwd } = await fx.repoWithCommit()
    process.env.TENON_INIT_IN_PLACE = '1'
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', BACKEND), err.join('\n')).toBe(0)
    const yaml = await readFile(join(cwd, 'openspec', 'changes', 'demo', '.pipeline.yaml'), 'utf8')
    expect(yaml).toContain('\nisolation: null\n')
    expect(existsSync(join(cwd, '.worktrees'))).toBe(false)
    expect(err.some((line) => line.includes('原地'))).toBe(false)
  })

  test('--in-place：原地建立并输出原因；--json 的 worktree 为 null、worktree_reason 为 requested', async () => {
    const { cwd } = await fx.repoWithCommit()
    const harness = makeHarness(cwd)
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--preset', 'full', '--in-place', '--json']), harness.err.join('\n')).toBe(0)
    const yaml = await readFile(join(cwd, 'openspec', 'changes', 'demo', '.pipeline.yaml'), 'utf8')
    expect(yaml).toContain('\nisolation: null\n')
    expect(existsSync(join(cwd, '.worktrees'))).toBe(false)
    expect(harness.err.join('\n')).toContain('原地')
    expect(JSON.parse(harness.out[0] ?? '')).toMatchObject({ change: 'demo', worktree: null, worktree_reason: 'requested' })
  })

  test('不带 --json：stdout 保持为空（init 的 stdout 契约不变）', async () => {
    const { cwd } = await fx.repoWithCommit()
    const harness = makeHarness(cwd)
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--preset', 'full']), harness.err.join('\n')).toBe(0)
    expect(harness.out).toEqual([])
    expect(existsSync(join(cwd, '.worktrees', 'demo', 'openspec', 'changes', 'demo'))).toBe(true)
  })

  test('不是 git 仓库：原地建立并说明原因，--json 的 worktree_reason 为 not-git', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'init-worktree-plain-')))
    fx.temps.push(cwd)
    const { deps, out, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'demo', { ...BACKEND, json: true }), err.join('\n')).toBe(0)
    expect(existsSync(join(cwd, 'openspec', 'changes', 'demo', '.pipeline.yaml'))).toBe(true)
    expect(err.join('\n')).toContain('不是 git 仓库')
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ worktree: null, worktree_reason: 'not-git' })
  })

  test('已在 linked worktree 里：任务原地建在这个 worktree，输出原因，不再嵌套新建', async () => {
    const { cwd } = await fx.repoWithCommit()
    const linked = join(cwd, '..', `${cwd.split('/').pop()}-linked`)
    git(cwd, ['worktree', 'add', '-q', '-b', 'feature', linked])
    fx.temps.push(await realpath(linked))
    const { deps, err } = fx.realIn(await realpath(linked))
    expect(await cmdInit(deps, 'demo2', BACKEND), err.join('\n')).toBe(0)
    expect(existsSync(join(linked, 'openspec', 'changes', 'demo2', '.pipeline.yaml'))).toBe(true)
    expect(existsSync(join(linked, '.worktrees'))).toBe(false)
    expect(err.join('\n')).toContain('linked worktree')
  })

  test('两个任务并行互不污染：A 的 worktree 里新增并修改测试文件，B 的改动文件里没有它', async () => {
    const { cwd } = await fx.repoWithCommit({ 'src/lib.ts': 'export const lib = 1\n' })
    const { deps, err } = fx.realIn(cwd)
    expect(await cmdInit(deps, 'a', BACKEND), err.join('\n')).toBe(0)
    expect(await cmdInit(deps, 'b', BACKEND), err.join('\n')).toBe(0)
    const wtA = join(cwd, '.worktrees', 'a')
    const wtB = join(cwd, '.worktrees', 'b')
    await writeFiles(wtA, { 'src/a.test.ts': 'test("a", () => {})\n' })
    await writeFiles(wtA, { 'src/a.test.ts': 'test("a", () => { expect(1).toBe(1) })\n' })
    const stateA = await deps.store.read(join(wtA, 'openspec', 'changes', 'a'))
    const stateB = await deps.store.read(join(wtB, 'openspec', 'changes', 'b'))
    expect(await changedFilesForState(wtA, stateA)).toContain('src/a.test.ts')
    expect(await changedFilesForState(wtB, stateB)).not.toContain('src/a.test.ts')
    expect(fx.status(cwd)).toBe('')
  })
})
