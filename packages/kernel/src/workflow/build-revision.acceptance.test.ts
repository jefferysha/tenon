import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyFields } from '../state/parse.js'
import type { PipelineState } from '../types.js'
import { allFields } from './test-support.js'
import { checkDefaultEventPreconditions } from '../flow/default-event-policy.js'
import { candidateFingerprint } from '../test-system/candidate.js'
import { probeBuildRevisionIdentity } from '../workspace/build-revision-identity.js'
import { createTaskWorktree, planTaskWorktree, type GitRunner } from '../workspace/task-worktree.js'
import {
  assessBuildRevisionTrust,
  createBuildRevisionToken,
  expectedBuildRevisionKind,
  makeBuildRevisionBlocker,
  safeRevisionHash,
} from './build-revision.js'
import { ACTION_HANDLERS } from './action-handlers.js'
import { evaluateGuards } from './guard-handlers.js'
import { compileWorkflow } from './compile.js'
import { effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { readinessByTransition } from './transition-readiness.js'
import { mergeLifecycleGuards, semanticRevisionLifecyclePolicy } from './governed-lifecycle-policy.js'
import type { WorkflowDef } from './types.js'

const identity = {
  repository: '/repo.git',
  worktree: '/repo\\0/repo.git/worktrees/change',
} as const
const revision = 'a'.repeat(40)
const token = createBuildRevisionToken('git', revision, identity)

function trustedAssessment(
  override: Partial<Parameters<typeof assessBuildRevisionTrust>[0]> = {},
) {
  return (request: Parameters<NonNullable<import('./ir.js').GuardInput['assessBuildRevision']>>[0]) =>
    assessBuildRevisionTrust({
      ...request,
      observe: async () => ({ kind: 'git' as const, revision, identity }),
      provenance: async () => ({
        currentStep: request.expectedStep ?? 'verify',
        stateHash: request.stateHash,
        stateBuildSha: token.value,
        recordTo: request.expectedStep ?? 'verify',
        buildShaEffects: [token.value],
      }),
      ...override,
    })
}

describe('issue #42 kernel acceptance seams', () => {
  it('capture action requires a canonical token and leaves fields untouched', async () => {
    const fields = allFields({ isolation: 'branch', build_sha: 'legacy' })
    const out = await ACTION_HANDLERS['freeze-build-sha']({ type: 'freeze-build-sha' }, {
      fields,
      clock: () => '2026-08-10T00:00:00Z',
      captureBuildRevision: async () => token.value,
    })
    expect(out).toEqual({ patch: { build_sha: token.value }, signals: [] })
    expect(fields.build_sha).toBe('legacy')
  })

  it.each([
    ['missing capability', undefined, 'capability-unavailable'],
    ['legacy SHA', async () => revision, 'malformed'],
    ['wrong token kind', async () => createBuildRevisionToken('workspace', 'workspace:sha256:' + 'b'.repeat(64), identity).value, 'malformed'],
    ['surrounding whitespace', async () => ` ${token.value}\n`, 'malformed'],
  ] as const)('capture failure %s is typed and does not write a patch', async (_label, capture, reason) => {
    const fields = allFields({ isolation: 'branch', build_sha: 'before' })
    const input = {
      fields,
      clock: () => '2026-08-10T00:00:00Z',
      ...(capture === undefined ? {} : { captureBuildRevision: capture }),
    }
    await expect(ACTION_HANDLERS['freeze-build-sha']({ type: 'freeze-build-sha' }, input))
      .rejects.toMatchObject({ blocker: makeBuildRevisionBlocker(reason) })
    expect(fields.build_sha).toBe('before')
  })

  it('build-head guard maps every untrusted assessment to a stable blocker, never skipped', async () => {
    const guard = { type: 'build-head-unchanged', field: 'build_sha' } as const
    const cases: readonly [string, unknown, string][] = [
      ['missing', undefined, 'missing'],
      ['null', null, 'null'],
      ['ambiguous', [token.value], 'ambiguous'],
      ['legacy', revision, 'malformed'],
      ['malformed', 'build:v1:git:bad', 'malformed'],
      ['39-char git SHA', 'a'.repeat(39), 'malformed'],
      ['41-char git SHA', 'a'.repeat(41), 'malformed'],
      ['63-char git SHA', 'a'.repeat(63), 'malformed'],
      ['65-char git SHA', 'a'.repeat(65), 'malformed'],
    ]
    for (const [_label, buildSha, reason] of cases) {
      const fields = allFields({ isolation: 'branch', build_sha: buildSha as never })
      const evaluations = await evaluateGuards([guard], {
        fields,
        track: 'backend',
        currentStep: 'verify',
        assessBuildRevision: trustedAssessment(),
      })
      expect(evaluations[0]?.decision).toMatchObject({
        kind: 'failed',
        blocker: { code: 'verify-build-revision-untrusted', reason },
      })
    }
  })

  it.each([
    ['capability unavailable', undefined, 'capability-unavailable'],
    ['evaluator exception', async () => { throw new Error('/private/project') }, 'evaluation-error'],
  ] as const)('guard %s is fail-closed and privacy-safe', async (_label, assessor, reason) => {
    const fields = allFields({ isolation: 'branch', build_sha: token.value })
    const evaluations = await evaluateGuards([{ type: 'build-head-unchanged', field: 'build_sha' }], {
      fields,
      track: 'backend',
      currentStep: 'verify',
      ...(assessor === undefined ? {} : {
        assessBuildRevision: async () => assessor(),
      }),
    })
    expect(evaluations[0]?.decision).toMatchObject({
      kind: 'failed',
      blocker: { code: 'verify-build-revision-untrusted', reason },
    })
    expect(JSON.stringify(evaluations)).not.toContain('/private/project')
  })

  it.each([
    ['revision-stale', async () => ({ kind: 'git' as const, revision: 'b'.repeat(40), identity })],
    ['project-mismatch', async () => ({ kind: 'git' as const, revision, identity: { ...identity, repository: '/other.git' } })],
    ['worktree-mismatch', async () => ({ kind: 'git' as const, revision, identity: { ...identity, worktree: '/other\\0/worktree' } })],
  ] as const)('assessment rejects %s with stable reason', async (reason, observe) => {
    const result = await assessBuildRevisionTrust({
      buildSha: token.value,
      isolation: 'branch',
      expectedStep: 'verify',
      stateHash: safeRevisionHash({ phase: 'verify' }),
      observe,
      provenance: async () => ({
        currentStep: 'verify',
        stateBuildSha: token.value,
        recordTo: 'verify',
        buildShaEffects: [token.value],
      }),
    })
    expect(result).toMatchObject({ trusted: false, blocker: { reason } })
  })

  it('semantic lifecycle captures only on Build entry, guards Verify exits, and leaves rollback open', () => {
    const workflow: WorkflowDef = {
      name: 'arbitrary-build',
      steps: [
        {
          id: 'implement-anything', label: 'Implement', gate: null, skills: [],
          inputs: [], outputs: [{ field: 'build_sha', type: 'string' }], guards: [],
          transitions: [{ event: 'ready-for-review', to: 'review-anything', actions: [{ type: 'freeze-build-sha' }] }],
        },
        {
          id: 'review-anything', label: 'Review', gate: 'review', skills: [],
          inputs: [{ field: 'build_sha', type: 'string' }], outputs: [],
          guards: [{ type: 'build-head-unchanged', field: 'build_sha' }], transitions: [],
        },
      ],
    }
    const ir = compileWorkflow(workflow)
    const from = ir.steps[0]!
    const to = ir.steps[1]!
    const entryPolicy = semanticRevisionLifecyclePolicy(from, from.transitions[0]!, to)
    expect(entryPolicy).toEqual({
      actions: [{ type: 'freeze-build-sha' }],
      guards: [],
    })

    const verify = { ...to, transitions: [
      { event: 'accept', to: 'ship-anything', actions: [] },
      { event: 'reject', to: 'implement-anything', actions: [{ type: 'mark-verification-failed' as const }] },
    ] }
    const ship = { id: 'ship-anything', label: 'Ship', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }
    const successPolicy = semanticRevisionLifecyclePolicy(verify, verify.transitions[0]!, ship)
    expect(successPolicy).toEqual({ actions: [], guards: [{ type: 'build-head-unchanged', field: 'build_sha' }] })
    const rollbackPolicy = semanticRevisionLifecyclePolicy(verify, verify.transitions[1]!, from)
    expect(rollbackPolicy).toBeUndefined()

    const explicit = mergeLifecycleGuards(
      [{ type: 'build-head-unchanged', field: 'build_sha' }],
      successPolicy?.guards,
    )
    expect(explicit).toEqual([{ type: 'build-head-unchanged', field: 'build_sha' }])
  })

  it('readiness repeats a valid assessment idempotently and does not mutate state', async () => {
    const workflow: WorkflowDef = {
      name: 'readiness-anything',
      steps: [
        {
          id: 'review-anything', label: 'Review', gate: null, skills: [],
          inputs: [{ field: 'build_sha', type: 'string' }], outputs: [], guards: [],
          transitions: [{ event: 'accept', to: 'ship-anything' }],
        },
        { id: 'ship-anything', label: 'Ship', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const plan = effectiveWorkflowPlanFromIr('readiness-anything', compileWorkflow(workflow))
    const fields = { ...emptyFields(), phase: 'review-anything', track: 'backend', isolation: 'branch', build_sha: token.value }
    const state: PipelineState = { fields: fields as PipelineState['fields'], opaqueTail: '' }
    const before = structuredClone(state)
    const context = { changeDirAbs: '/tmp/issue-42-readiness', assessBuildRevision: trustedAssessment() }
    const first = await readinessByTransition(plan, state, context)
    const second = await readinessByTransition(plan, state, context)
    expect(first).toEqual(second)
    expect(first['review-anything']?.accept).toEqual({ ready: true, blockers: [] })
    expect(state).toEqual(before)
  })

  it.each([
    ['built-in backend', 'backend', 'default'],
    ['built-in backend', 'backend', 'custom'],
    ['free track', 'free', 'default'],
    ['free track', 'free', 'custom'],
    ['arbitrary custom track', 'custom-id', 'default'],
    ['arbitrary custom track', 'custom-id', 'custom'],
  ] as const)('revision trust guard is not bypassed by %s in %s workflow', async (_label, track, path) => {
    let calls = 0
    const blocker = makeBuildRevisionBlocker('revision-stale')
    const assessor: NonNullable<import('./ir.js').GuardInput['assessBuildRevision']> = async () => {
      calls += 1
      return { trusted: false, blocker }
    }
    const fields = allFields({
      phase: 'verify', track, isolation: 'branch', build_sha: token.value,
      verification_report: 'docs/v.md', branch_status: 'handled',
      agent_review_result: 'pass', codex_review_result: 'pass',
    })
    const result = path === 'default'
      ? await checkDefaultEventPreconditions('verify-pass', {
          fields: fields as PipelineState['fields'], opaqueTail: '',
        }, { fileExists: () => true, assessBuildRevision: assessor })
      : await evaluateGuards([{ type: 'build-head-unchanged', field: 'build_sha' }], {
          fields,
          track,
          currentStep: 'review-anything',
          assessBuildRevision: assessor,
        })
    if (path === 'default') {
      expect(result).toEqual([
        'ERROR: verify-pass revision trust blocked (code=verify-build-revision-untrusted reason=revision-stale)',
        '  修复：return-to-build-and-capture-current-revision',
      ])
    } else {
      expect(result[0]?.decision).toMatchObject({
        kind: 'failed',
        blocker: { code: 'verify-build-revision-untrusted', reason: 'revision-stale' },
      })
    }
    expect(calls).toBe(1)
  })
})

const execFileAsync = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const runGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV })
    return { code: 0, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    }
  }
}

describe('worktree 任务的构建版本往返（真实 git，临时目录）', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  /** 主检出 + 一个按任务 worktree 规则建好的 `.worktrees/demo`，实现尚未提交。 */
  async function mainWithTaskWorktree(): Promise<{ main: string; worktree: string }> {
    const main = await realpath(await mkdtemp(join(tmpdir(), 'tenon-build-revision-roundtrip-')))
    roots.push(main)
    const git = async (...args: string[]): Promise<void> => {
      const result = await runGit(['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], main)
      if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
    }
    await git('init', '-q', '-b', 'main')
    await writeFile(join(main, 'README.md'), 'x\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'init')
    const plan = await planTaskWorktree({ repoRoot: main, change: 'demo', inPlace: false, git: runGit })
    if (plan.kind !== 'create') throw new Error(`期望 create，实际 ${plan.reason}`)
    await createTaskWorktree(plan, runGit)
    await writeFile(join(plan.path, 'impl.ts'), 'export const answer = 42\n', 'utf8')
    return { main, worktree: plan.path }
  }

  /** 与生产同口径：类别取 `expectedBuildRevisionKind`，workspace 取内容指纹，git 取 HEAD。 */
  async function observeIn(cwd: string, kind: 'git' | 'workspace') {
    const identity = await probeBuildRevisionIdentity(cwd)
    if (!identity) throw new Error('测试仓读不出构建版本身份')
    const revision = kind === 'workspace'
      ? await candidateFingerprint(cwd)
      : (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim()
    return { kind, revision, identity }
  }

  async function captureIn(cwd: string, isolation: string): Promise<string> {
    const observed = await observeIn(cwd, expectedBuildRevisionKind(isolation))
    return createBuildRevisionToken(observed.kind, observed.revision, observed.identity).value
  }

  function verifyIn(cwd: string, buildSha: string) {
    return assessBuildRevisionTrust({
      buildSha,
      isolation: 'worktree',
      expectedStep: 'verify',
      observe: () => observeIn(cwd, 'workspace'),
      provenance: async () => ({
        currentStep: 'verify', stateBuildSha: buildSha, recordTo: 'verify', buildShaEffects: [buildSha],
      }),
    })
  }

  it('未提交的实现：build-complete 捕获 workspace 令牌，同一 worktree 复核可信', async () => {
    const { worktree } = await mainWithTaskWorktree()
    const fields = allFields({ isolation: 'worktree' })
    const out = await ACTION_HANDLERS['freeze-build-sha']({ type: 'freeze-build-sha' }, {
      fields,
      clock: () => '2026-10-11T00:00:00Z',
      captureBuildRevision: (isolation) => captureIn(worktree, isolation),
    })
    const buildSha = String(out.patch?.build_sha)
    expect(buildSha).toMatch(/^build:v1:workspace:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/)
    await expect(verifyIn(worktree, buildSha)).resolves.toMatchObject({ trusted: true })
  }, 30_000)

  it('同一任务在主检出里复核：worktree-mismatch（即使两边内容一致）', async () => {
    const { main, worktree } = await mainWithTaskWorktree()
    const buildSha = await captureIn(worktree, 'worktree')
    await expect(verifyIn(main, buildSha)).resolves.toMatchObject({
      trusted: false, blocker: { reason: 'worktree-mismatch' },
    })
  }, 30_000)

  it('捕获之后 worktree 里的实现又变了：revision-stale', async () => {
    const { worktree } = await mainWithTaskWorktree()
    const buildSha = await captureIn(worktree, 'worktree')
    await writeFile(join(worktree, 'impl.ts'), 'export const answer = 43\n', 'utf8')
    await expect(verifyIn(worktree, buildSha)).resolves.toMatchObject({
      trusted: false, blocker: { reason: 'revision-stale' },
    })
  }, 30_000)
})
