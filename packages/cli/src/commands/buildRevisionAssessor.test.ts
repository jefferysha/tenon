import { describe, expect, test } from 'vitest'
import { createBuildRevisionToken, safeRevisionHash } from '@tenon/kernel'
import type { BuildRevisionIdentity } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { resolveBuildRevisionAssessor } from './buildRevisionAssessor.js'

const IDENTITY: BuildRevisionIdentity = { repository: '/repo.git', worktree: '/repo/.worktrees/demo\0/repo.git/worktrees/demo' }
const OTHER_CHECKOUT: BuildRevisionIdentity = { repository: IDENTITY.repository, worktree: '/repo\0/repo.git' }
const GIT_HEAD = 'a'.repeat(40)
const WORKSPACE = `workspace:sha256:${'c'.repeat(64)}`

function assessorFor(identity: BuildRevisionIdentity) {
  const deps = {
    cwd: '/repo/.worktrees/demo',
    buildRevisionIdentity: async () => identity,
    gitHeadSha: async () => GIT_HEAD,
    workspaceFingerprint: async () => WORKSPACE,
  } as unknown as CliDeps
  // 变更目录不存在：通过观察比对后只会停在「缺少转换来源」，足以区分类别与身份的判定。
  return resolveBuildRevisionAssessor(deps, 'demo', '/nonexistent/openspec/changes/demo')
}

function request(isolation: string, buildSha: string) {
  return {
    buildSha,
    isolation,
    expectedStep: 'verify',
    stateHash: safeRevisionHash({ phase: 'verify', build_sha: buildSha }),
  }
}

describe('CLI 默认的构建版本复核：类别随隔离方式', () => {
  const workspaceToken = createBuildRevisionToken('workspace', WORKSPACE, IDENTITY).value
  const gitToken = createBuildRevisionToken('git', GIT_HEAD, IDENTITY).value

  test('worktree 任务按工作区指纹观察：workspace 令牌比对通过（之后才轮到转换来源）', async () => {
    const result = await assessorFor(IDENTITY)(request('worktree', workspaceToken))
    expect(result).toMatchObject({ trusted: false, blocker: { reason: 'provenance-missing' } })
  })

  test('worktree 任务拿 git 令牌复核：isolation-mismatch', async () => {
    const result = await assessorFor(IDENTITY)(request('worktree', gitToken))
    expect(result).toMatchObject({ trusted: false, blocker: { reason: 'isolation-mismatch' } })
  })

  test('worktree 令牌在别的检出里复核：worktree-mismatch', async () => {
    const result = await assessorFor(OTHER_CHECKOUT)(request('worktree', workspaceToken))
    expect(result).toMatchObject({ trusted: false, blocker: { reason: 'worktree-mismatch' } })
  })

  test('branch 任务仍按 git HEAD 观察', async () => {
    const result = await assessorFor(IDENTITY)(request('branch', gitToken))
    expect(result).toMatchObject({ trusted: false, blocker: { reason: 'provenance-missing' } })
  })
})
