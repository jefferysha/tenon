/**
 * 真实 e2e —— Dashboard 服务的 transition 写回端点（performTransition）对 worktree 任务的构建版本：
 * `isolation=worktree` 与 CLI 一致，build-complete 写入 `workspace` 类令牌（工作区内容指纹 + 该 worktree 的身份），
 * 实现尚未提交也能在同一 worktree 里复核；`isolation=branch` 仍绑 git HEAD。
 * git 仓与 worktree 一律建在 mkdtemp 临时目录，worktree 用 kernel 的任务 worktree API 建（路径 `<主检出>/.worktrees/<change>`）。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  candidateFingerprint, createBuildRevisionToken, createTaskWorktree, createTransitionRecordStore,
  createWorkflowRunRepository, planTaskWorktree, probeBuildRevisionIdentity,
  type GitRunner, type StateStore,
} from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import { initChange, newStore, testFlow } from './test-support.js'

const NAME = 'demo'
const CLOCK = (): string => '2026-10-11T00:00:00Z'
const WORKFLOW = `name: buildwf
steps:
  - id: build
    label: Build
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: build-complete
        to: verify
        actions:
          - type: freeze-build-sha
  - id: verify
    label: Verify
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: build-head-unchanged
        field: build_sha
    transitions:
      - event: verify-pass
        to: done
  - id: done
    label: Done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const runGit: GitRunner = (args, cwd) => new Promise((resolve) => {
  execFile('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
    resolve({ code, stdout, stderr })
  })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], cwd)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  return result.stdout.trim()
}

let main: string
let worktree: string
let store: StateStore
let deps: TransitionDeps

const changeDir = (): string => join(worktree, 'openspec', 'changes', NAME)
const go = (event: string) => performTransition(deps, worktree, NAME, event)

beforeEach(async () => {
  main = await realpath(await mkdtemp(join(tmpdir(), 'pl-dash-build-revision-')))
  await git(main, 'init', '-q', '-b', 'main')
  await writeFile(join(main, 'README.md'), 'x\n', 'utf8')
  await git(main, 'add', '-A')
  await git(main, 'commit', '-q', '-m', 'init')
  const plan = await planTaskWorktree({ repoRoot: main, change: NAME, inPlace: false, git: runGit })
  if (plan.kind !== 'create') throw new Error(`期望 create，实际 ${plan.reason}`)
  await createTaskWorktree(plan, runGit)
  worktree = plan.path
  await mkdir(join(worktree, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(worktree, '.pipeline', 'workflows', 'buildwf.yaml'), WORKFLOW, 'utf8')
  // 实现尚未提交：worktree 里多出一个未跟踪文件。
  await writeFile(join(worktree, 'impl.ts'), 'export const answer = 42\n', 'utf8')

  store = newStore()
  await initChange(store, worktree, NAME, {
    track: 'simple',
    initialWorkflow: { workflow: 'buildwf', phase: 'build', openspecContract: false },
  })
  const recordStore = createTransitionRecordStore()
  deps = {
    store,
    runRepo: createWorkflowRunRepository({ store, recordStore, clock: CLOCK }),
    recordStore,
    flow: testFlow(),
    clock: CLOCK,
    gitHeadSha: async (cwd) => git(cwd, 'rev-parse', 'HEAD'),
    workspaceFingerprint: (cwd) => candidateFingerprint(cwd),
  }
})

afterEach(async () => {
  await rm(main, { recursive: true, force: true })
})

describe('Dashboard 服务的 transition：worktree 任务的构建版本', () => {
  test('isolation=worktree：build-complete 写入 workspace 令牌，与 CLI 同口径（指纹 + 该 worktree 身份）', async () => {
    await store.set(changeDir(), 'isolation', 'worktree')
    const result = await go('build-complete')
    expect(result.code).toBe(200)
    const buildSha = String((await store.read(changeDir())).fields.build_sha)
    expect(buildSha).toMatch(/^build:v1:workspace:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/)
    const identity = await probeBuildRevisionIdentity(worktree)
    expect(identity).toBeDefined()
    expect(buildSha).toBe(createBuildRevisionToken('workspace', await candidateFingerprint(worktree), identity!).value)
  }, 30_000)

  test('实现未提交也能验证：同一 worktree 里 verify-pass 复核通过', async () => {
    await store.set(changeDir(), 'isolation', 'worktree')
    expect((await go('build-complete')).code).toBe(200)
    const result = await go('verify-pass')
    expect(result.code).toBe(200)
    expect((await store.read(changeDir())).fields.phase).toBe('done')
  }, 30_000)

  test('捕获之后 worktree 里的实现又变了：verify-pass 以 revision-stale 拒绝，相位不动', async () => {
    await store.set(changeDir(), 'isolation', 'worktree')
    expect((await go('build-complete')).code).toBe(200)
    await writeFile(join(worktree, 'impl.ts'), 'export const answer = 43\n', 'utf8')
    const result = await go('verify-pass')
    expect(result.code).toBe(409)
    expect(JSON.stringify(result.body)).toContain('revision-stale')
    expect((await store.read(changeDir())).fields.phase).toBe('verify')
  }, 30_000)

  test('isolation=branch 不变：build-complete 写入 git 令牌', async () => {
    await store.set(changeDir(), 'isolation', 'branch')
    expect((await go('build-complete')).code).toBe(200)
    const buildSha = String((await store.read(changeDir())).fields.build_sha)
    expect(buildSha).toMatch(/^build:v1:git:/)
    const identity = await probeBuildRevisionIdentity(worktree)
    expect(buildSha).toBe(createBuildRevisionToken('git', await git(worktree, 'rev-parse', 'HEAD'), identity!).value)
  }, 30_000)
})
