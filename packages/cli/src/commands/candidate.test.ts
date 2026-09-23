import { describe, expect, it } from 'vitest'
import {
  compileEffectiveWorkflowPlan,
  createBuildRevisionToken,
  type PipelineState,
} from '@tenon/kernel'
import { currentCandidate, normalizeCandidate } from './candidate.js'

const identity = { repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change' } as const

describe('review candidate normalization', () => {
  it('maps a canonical build:v1 token to the existing sha256 revision candidate', async () => {
    const token = createBuildRevisionToken('git', 'a'.repeat(40), identity)
    const plan = compileEffectiveWorkflowPlan('candidate-flow', {
      name: 'candidate-flow',
      steps: [
        {
          id: 'build', label: 'Build', gate: null, skills: [],
          inputs: [], outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
          transitions: [{ event: 'complete', to: 'verify' }],
        },
        {
          id: 'verify', label: 'Verify', gate: 'review', skills: [],
          inputs: [{ field: 'build_sha', type: 'string' }], outputs: [], guards: [], transitions: [],
        },
      ],
    })
    const state: PipelineState = {
      fields: { phase: 'verify', build_sha: token.value } as PipelineState['fields'],
      opaqueTail: '',
    }
    // 没有工作区指纹能力时才回落到冻结的 build token。
    const candidate = await currentCandidate({ cwd: '/repo' } as never, 'demo', state, plan, 'verify')
    expect(candidate).toBe(`sha256:${token.revisionHash}`)
    expect(normalizeCandidate(token.value)).toBe(candidate)

    // 有指纹能力时即使 verify 冻结了 build token 也用工作区指纹：改了代码，候选随之改变，
    // 绑在旧候选上的评审结论因此过期（与测试记录同一口径）。
    let tree = 'b'
    const deps = { cwd: '/repo', workspaceFingerprint: async () => 'workspace:sha256:' + tree.repeat(64) } as never
    const before = await currentCandidate(deps, 'demo', state, plan, 'verify')
    expect(before).toBe('workspace:sha256:' + 'b'.repeat(64))
    tree = 'c'
    expect(await currentCandidate(deps, 'demo', state, plan, 'verify')).not.toBe(before)
  })

  it('rejects malformed, whitespace-padded, and structurally non-canonical token candidates', () => {
    expect(normalizeCandidate('build:v1:git:bad')).toBeUndefined()
    expect(normalizeCandidate(' build:v1:git:' + 'a'.repeat(64) + ':' + 'b'.repeat(64) + ':' + 'c'.repeat(64))).toBeUndefined()
    expect(normalizeCandidate('build:v2:git:' + 'a'.repeat(64) + ':' + 'b'.repeat(64) + ':' + 'c'.repeat(64))).toBeUndefined()
    expect(normalizeCandidate('sha256:' + 'A'.repeat(64))).toBeUndefined()
  })
})
