import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { CliDeps } from '../deps.js'
import { realDeps } from '../integration-harness.js'
import { commitAll, git, writeFiles } from '../integration-harness-tests.js'

export const BACKEND = { track: 'backend', preset: 'full' } as const

/** 与 init-workflow.integration.test.ts 同一份两步 workflow 定义（intake -> done，event=complete）。 */
export const TWO_STEP_WF = `name: onboarding
steps:
  - id: intake
    label: intake
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/**
 * init-worktree.test.ts 与 init-worktree-setup.test.ts 共用的夹具：真临时 git 仓 + 真 deps（真 store、真 git）。
 * 全局 setup 给所有测试设了 TENON_INIT_IN_PLACE=1（既有用例都原地建立），这里专测 worktree，所以在用例内删掉它、用完恢复。
 * 在调用它的 describe 里注册 beforeEach/afterEach：删掉 TENON_INIT_IN_PLACE、用完恢复，restoreAllMocks，清理 temps。
 * temps 随返回值一并给出：个别用例自己建的临时目录要登记进去，由 afterEach 清理。
 */
export function useWorktreeInitFixture(): {
  temps: string[]
  repoWithCommit(files?: Record<string, string>): Promise<{ cwd: string; head: string }>
  realIn(cwd: string, env?: NodeJS.ProcessEnv): { deps: CliDeps; out: string[]; err: string[] }
  status(cwd: string): string
  branches(cwd: string): string
} {
  let savedInPlace: string | undefined
  const temps: string[] = []

  beforeEach(() => {
    savedInPlace = process.env.TENON_INIT_IN_PLACE
    delete process.env.TENON_INIT_IN_PLACE
  })

  afterEach(async () => {
    if (savedInPlace === undefined) delete process.env.TENON_INIT_IN_PLACE
    else process.env.TENON_INIT_IN_PLACE = savedInPlace
    vi.restoreAllMocks()
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  /** 临时仓：main 分支上有一个提交（git 给的真实路径，便于和 worktree list 的输出比较）。 */
  async function repoWithCommit(files: Record<string, string> = { 'README.md': 'x\n' }): Promise<{ cwd: string; head: string }> {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'init-worktree-')))
    temps.push(cwd)
    git(cwd, ['init', '-q', '-b', 'main'])
    await writeFiles(cwd, files)
    commitAll(cwd, 'base', '2026-01-01T00:00:00Z')
    return { cwd, head: git(cwd, ['rev-parse', 'HEAD']).trim() }
  }

  function realIn(cwd: string, env: NodeJS.ProcessEnv = process.env) {
    const out: string[] = []
    const err: string[] = []
    return { deps: realDeps(cwd, out, err, env), out, err }
  }

  const status = (cwd: string): string => git(cwd, ['status', '--short']).trim()
  const branches = (cwd: string): string => git(cwd, ['branch', '--list', 'tenon/*']).trim()

  return { temps, repoWithCommit, realIn, status, branches }
}
