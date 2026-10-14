/**
 * H14 shared AFK executor —— 只测编排接缝，不起真 Docker/Git。
 * 真 binary / image 对账由 automation runner/ports 集成测试覆盖；这里钉死 CLI 共享入口的
 * ordinary/targeted 分流、lazy Docker、host verifier 与 bundled CLI digest 透传。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createExecutionPreparation,
  GIT_REVISION_VERIFIER_ISSUER_IDENTITY,
  skillActionAuthorityContract,
  type Automation,
  type DockerRunChangeOptions,
  type ExecutionContext,
  type PreparedExecutionContext,
  type RoundReport,
  type RunChange,
  type TargetedRunCandidate,
  type VerifierPort,
} from '@tenon/automation'
import { createLoopLedgerStore } from '@tenon/kernel'
import { makeDeps, mockState } from '../test-support.js'
import {
  BundledCliDigestUnavailableError,
  resolveAfkWorkflowActionAuthority,
  resolveBundledCliDistSha256,
  runAfkRound,
  type AfkExecutorRuntime,
} from './afk-executor.js'

const DIGEST = 'd'.repeat(64)
const TARGETS = [{
  change: 'ready-a',
  expectedLoopId: 'loop-a',
  expectedAutonomyLevel: 'L1',
}] satisfies readonly TargetedRunCandidate[]

function withEnterAfkSkillAuthority(deps: ReturnType<typeof makeDeps>) {
  deps.resolveSkillActionAuthority = async (query) =>
    skillActionAuthorityContract(query, ['enter-afk'])
  return deps
}

async function resolveTestAfkWorkflowActionAuthority(
  deps: ReturnType<typeof makeDeps>,
  change: string,
  context: Parameters<typeof resolveAfkWorkflowActionAuthority>[2],
  run: Parameters<typeof resolveAfkWorkflowActionAuthority>[3],
) {
  return resolveAfkWorkflowActionAuthority(deps, change, context, run)
}

const report = (over: Partial<RoundReport> = {}): RoundReport => ({
  candidates: 1,
  admitted: 1,
  entries: [{ change: 'ready-a', loopId: 'loop-a', disposition: 'settled', result: 'paused' }],
  failures: [],
  ledgerFailures: [],
  halted: false,
  ledgerDegraded: false,
  ok: true,
  ...over,
})

const EXECUTION_CONTEXT = {
  attempt_id: 'attempt-a',
  reservation_id: 'reservation-a',
  loop_id: 'loop-a',
  change: 'ready-a',
  level: 'L1',
  runner: 'codex',
  admitted_at: '2026-07-19T00:00:00Z',
  policy_epoch: 'epoch-a',
  reservation: { runs: 1, tokens: 1, token_basis: 'risk-default' },
  skill_bundle_id: null,
} satisfies ExecutionContext

const preparation = createExecutionPreparation({
  repoRoot: '/repo',
  ledger: createLoopLedgerStore(),
  loadRegistry: () => ({ data: null, errors: [] }),
  clock: () => '2026-07-19T00:00:00Z',
  coordinates: {
    capture: async () => { throw new Error('non-loop fixture must not capture workflow coordinates') },
    readCurrentInputsDigest: async () => { throw new Error('non-loop fixture must not read workflow inputs') },
  },
  resolver: {
    resolveDefault: () => [],
    resolveCustom: () => [],
  },
  locator: {
    locate: async () => { throw new Error('non-loop fixture must not locate skills') },
  },
})

async function preparedContext(): Promise<PreparedExecutionContext> {
  const outcome = await preparation.prepare(EXECUTION_CONTEXT)
  if (!outcome.ok) throw new Error(`non-loop fixture preparation failed: ${outcome.detail}`)
  return outcome.context
}

function harness(opts: { invoke?: boolean; denied?: boolean } = {}) {
  const events: string[] = []
  const dockerOptions: DockerRunChangeOptions[] = []
  const verifier: VerifierPort = {
    verify: vi.fn<VerifierPort['verify']>(async () => {
      throw new Error('verifier is not invoked by this orchestration seam')
    }),
  }
  const runRound = vi.fn<Automation['runRound']>(async (runChange) => {
    events.push('runRound')
    if (opts.invoke !== false) await runChange(await preparedContext(), new AbortController().signal)
    return opts.denied
      ? report({ admitted: 0, entries: [{ change: 'ready-a', loopId: 'loop-a', disposition: 'denied', reason: 'budget-runs-exceeded' }] })
      : report()
  })
  const runTargeted = vi.fn<Automation['runTargeted']>(async (targets, runChange) => {
    events.push(`runTargeted:${targets.length}`)
    if (opts.invoke !== false) await runChange(await preparedContext(), new AbortController().signal)
    return report()
  })
  const scanReady = vi.fn<Automation['scanReady']>(async () => ['ready-a'])
  const auto: Automation = {
    config: { enabled: true, defaultOptIn: true, maxParallel: 1, maxRetries: 0, level: 'L1' },
    enqueue: vi.fn<Automation['enqueue']>(async () => true),
    scanReady,
    runRound,
    runTargeted,
  }
  const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
  const runtime: AfkExecutorRuntime = {
    enforceLoopWiring: vi.fn(async () => ({ blocked: [] })),
    exec,
    currentBranch: vi.fn(async () => 'main'),
    dockerAvailable: vi.fn(async () => {
      events.push('dockerAvailable')
      return true
    }),
    resolveCliDistSha256: vi.fn(async () => DIGEST),
    createAutomation: vi.fn(() => auto),
    createGitRevisionVerifier: vi.fn(() => verifier),
    createDockerRunChange: vi.fn((options: DockerRunChangeOptions): RunChange => {
      events.push('createDockerRunChange')
      dockerOptions.push(options)
      return async () => ({ commits: [], verifyResult: 'pass', phaseEvent: 'verify-pass' })
    }),
  }
  return { runtime, events, dockerOptions, verifier, auto, scanReady, runRound, runTargeted }
}

describe('runAfkRound · H14 shared executor', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('普通 run 调 Automation.runRound；第一次真实 runChange 才探 Docker，并透传 L3 verifier + CLI digest', async () => {
    const h = harness()
    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L3', image: 'sandcastle:test' }, h.runtime)

    expect(result.status).toBe('completed')
    expect(h.runRound).toHaveBeenCalledOnce()
    expect(h.runTargeted).not.toHaveBeenCalled()
    expect(h.events).toEqual(['runRound', 'dockerAvailable', 'createDockerRunChange'])
    expect(h.runtime.createGitRevisionVerifier).toHaveBeenCalledWith(h.runtime.exec)
    expect(h.dockerOptions).toHaveLength(1)
    expect(h.dockerOptions[0]).toMatchObject({
      level: 'L3',
      image: 'sandcastle:test',
      verifier: h.verifier,
      verifierExpectedIssuerIdentity: GIT_REVISION_VERIFIER_ISSUER_IDENTITY,
      imageExpectation: { cliDistSha256: DIGEST },
    })
    expect(typeof h.dockerOptions[0]?.usageJournal?.recordProviderUsage).toBe('function')
  })

  it('targets 存在时只调 Automation.runTargeted，并原样传递已解析归属', async () => {
    const h = harness()
    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1', targets: TARGETS }, h.runtime)

    expect(result.status).toBe('completed')
    expect(h.runRound).not.toHaveBeenCalled()
    expect(h.runTargeted).toHaveBeenCalledWith(TARGETS, expect.any(Function))
    expect(h.runtime.enforceLoopWiring).toHaveBeenCalledWith(
      expect.anything(),
      ['loop-a'],
    )
  })

  it('H11：active loop wiring invalid → AFK 在 scan/reservation/Docker 前阻断（无 ready 也必须检查）', async () => {
    const h = harness()
    h.runtime.enforceLoopWiring = vi.fn(async () => ({
      blocked: [{
        loopId: 'loop-a', status: 'invalid' as const, dimension: 'workflow' as const,
        reason: 'workflow missing',
      }],
    }))

    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1' }, h.runtime)

    expect(result).toMatchObject({
      status: 'configuration-error', ready: [], message: expect.stringMatching(/loop-a.*workflow.*missing/i),
    })
    expect(h.runtime.createAutomation).not.toHaveBeenCalled()
    expect(h.scanReady).not.toHaveBeenCalled()
    expect(h.runtime.dockerAvailable).not.toHaveBeenCalled()
  })

  it('H11：同一 guard 还真接进 reserve 后/claim 前 scheduler validator，返回已 CAS 暂停标记', async () => {
    const h = harness({ invoke: false })
    const enforce = h.runtime.enforceLoopWiring as ReturnType<typeof vi.fn>
    enforce
      .mockResolvedValueOnce({ blocked: [] })
      .mockResolvedValueOnce({
        blocked: [{
          loopId: 'loop-a', status: 'invalid', dimension: 'skill-bundle', reason: 'skill removed',
        }],
      })

    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1' }, h.runtime)
    expect(result.status).toBe('completed')
    const createCalls = (h.runtime.createAutomation as ReturnType<typeof vi.fn>).mock.calls
    const productionDeps = createCalls.at(-1)?.[0]
    expect(productionDeps.validateExecutionWiring).toBeTypeOf('function')

    await expect(productionDeps.validateExecutionWiring(EXECUTION_CONTEXT)).resolves.toEqual({
      ok: false,
      status: 'invalid',
      dimension: 'skill-bundle',
      reason: 'skill removed',
      governancePaused: true,
    })
    expect(enforce).toHaveBeenLastCalledWith(expect.anything(), ['loop-a'])
  })

  it('ordinary AFK 与 targeted loop 的预扫描失败都原样上抛，不伪装成空队列', async () => {
    const cases: Array<readonly TargetedRunCandidate[] | undefined> = [undefined, TARGETS]
    for (const targets of cases) {
      const h = harness({ invoke: false })
      const scanError = Object.assign(new Error('simulated scan EIO'), { code: 'EIO' })
      h.scanReady.mockRejectedValueOnce(scanError)

      const run = runAfkRound(
        makeDeps({ cwd: '/repo' }),
        targets === undefined ? { level: 'L1' } : { level: 'L1', targets },
        h.runtime,
      )
      await expect(run).rejects.toBe(scanError)
      expect(h.runRound).not.toHaveBeenCalled()
      expect(h.runTargeted).not.toHaveBeenCalled()
    }
  })

  it('admission/budget 全拒绝且 runChange 从未被调用 → Docker 探针、digest、Docker factory 均 0 次', async () => {
    const h = harness({ invoke: false, denied: true })
    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1' }, h.runtime)

    expect(result.status).toBe('completed')
    expect(result.report?.admitted).toBe(0)
    expect(h.runtime.dockerAvailable).not.toHaveBeenCalled()
    expect(h.runtime.resolveCliDistSha256).not.toHaveBeenCalled()
    expect(h.runtime.createDockerRunChange).not.toHaveBeenCalled()
  })

  it('首次实际执行发现 Docker 不可用 → 结构化 docker-unavailable，不伪装 completed', async () => {
    const h = harness()
    h.runtime.dockerAvailable = vi.fn(async () => false)

    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1' }, h.runtime)
    expect(result.status).toBe('docker-unavailable')
    expect(h.runtime.resolveCliDistSha256).not.toHaveBeenCalled()
    expect(h.runtime.createDockerRunChange).not.toHaveBeenCalled()
  })

  it('bundled CLI digest 无法确认时 fail-loud 为结构化 configuration-error，不宣称 completed', async () => {
    const h = harness()
    h.runtime.resolveCliDistSha256 = vi.fn(async () => {
      throw new BundledCliDigestUnavailableError('/tmp/source/afk-executor.ts')
    })

    const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1' }, h.runtime)
    expect(result.status).toBe('configuration-error')
    expect(result.message).toMatch(/pipeline\.mjs|bundle|digest/i)
    expect(h.runtime.createDockerRunChange).not.toHaveBeenCalled()
  })

  it('Codex-first：process.env.CODEX_HOME 缺席但 ~/.codex/auth.json 可读 → hostEnv 注入该 ~/.codex', async () => {
    const home = await mkdtemp(join(tmpdir(), 'afk-codex-home-'))
    vi.stubEnv('CODEX_HOME', '')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'auth.json'), '{"token":"test-only"}\n')
    const h = harness()
    h.runtime.homeDir = () => home

    try {
      const result = await runAfkRound(makeDeps({ cwd: '/repo' }), { level: 'L1' }, h.runtime)
      expect(result.status).toBe('completed')
      expect(h.dockerOptions[0]?.hostEnv).toMatchObject({ CODEX_HOME: join(home, '.codex') })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('resolveAfkWorkflowActionAuthority · PR3 fresh non-Workflow layers', () => {
  const exactRun = {
    id: 'run-current',
    workflowId: 'default',
    workflowPlanFingerprint: 'frozen-fingerprint',
    loopId: 'lp',
    iterationId: 'iteration-current',
  }

  it('denies a stale Run identity even when the Change is still queued', async () => {
    const state = {
      ...mockState({ track: 'backend', automation: 'queued' }),
      runMetadata: {
        runId: 'run-replaced',
        transitionSequence: 0,
        workflowPlanFingerprint: exactRun.workflowPlanFingerprint,
        loopId: exactRun.loopId,
        iterationId: exactRun.iterationId,
      },
    }

    const facts = await resolveTestAfkWorkflowActionAuthority(
      makeDeps({ cwd: '/repo', state }),
      'ready-a',
      { skill_bundle_id: '_all', loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )

    expect(facts.run).toEqual({ status: 'fingerprint-mismatch', grants: [] })
  })

  it('does not treat a wired bundle as Skill contract authority when no resolver is installed', async () => {
    const state = {
      ...mockState({ track: 'backend', automation: 'queued' }),
      runMetadata: {
        runId: exactRun.id,
        transitionSequence: 0,
        workflowPlanFingerprint: exactRun.workflowPlanFingerprint,
        loopId: exactRun.loopId,
        iterationId: exactRun.iterationId,
      },
    }

    const facts = await resolveTestAfkWorkflowActionAuthority(
      makeDeps({ cwd: '/repo', state }),
      'ready-a',
      { skill_bundle_id: '_all', loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )

    expect(facts.skill).toEqual({ status: 'missing', grants: [] })
  })

  it('grants the AFK entry action only for verified bundle wiring and the exact queued Run, and reports the recorded track', async () => {
    const state = {
      ...mockState({ track: 'backend', automation: 'queued' }),
      runMetadata: {
        runId: exactRun.id,
        transitionSequence: 0,
        workflowPlanFingerprint: exactRun.workflowPlanFingerprint,
        loopId: exactRun.loopId,
        iterationId: exactRun.iterationId,
      },
    }
    const deps = makeDeps({
      cwd: '/repo',
      state,
    })
    const resolver = vi.fn(async (query) => skillActionAuthorityContract(query, ['enter-afk']))
    deps.resolveSkillActionAuthority = resolver

    await expect(resolveTestAfkWorkflowActionAuthority(deps, 'ready-a', {
      skill_bundle_id: '_all',
      loop_id: 'lp',
      iteration_id: 'iteration-current',
    }, exactRun)).resolves.toEqual({
      platform: { status: 'valid', grants: ['enter-afk'] },
      skill: { status: 'valid', grants: ['enter-afk'] },
      run: { status: 'valid', grants: ['enter-afk'] },
      // 项目层不在这里：准入读任务冻结计划里所选分支的 automation，宿主只说明任务记着哪条轨道。
      trackId: 'backend',
    })
    expect(resolver).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledWith({
      change: 'ready-a',
      skillBundleId: '_all',
      workflowRunId: exactRun.id,
      workflowFingerprint: exactRun.workflowPlanFingerprint,
    })
  })

  it.each(['lite', 'unknown-track'])('does not judge project eligibility for track %j: it reports the recorded track and no project layer', async (track) => {
    const facts = await resolveTestAfkWorkflowActionAuthority(
      withEnterAfkSkillAuthority(makeDeps({
        cwd: '/repo',
        state: mockState({ track, automation: 'queued' }),
      })),
      'ready-a',
      { skill_bundle_id: null, loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )

    // 项目层由准入读冻结计划里该分支的 automation 判定（没写 = 不可进入 AFK）；宿主不能代授。
    expect(facts).not.toHaveProperty('project')
    expect(facts).not.toHaveProperty('projectAuthority')
    expect(facts.trackId).toBe(track)
  })

  it('propagates a Skill authority provider failure instead of converting it into malformed skill policy', async () => {
    const providerError = new Error('skill authority EIO')
    const deps = makeDeps({
      cwd: '/repo',
      state: mockState({ track: 'backend', automation: 'queued' }),
    })
    deps.resolveSkillActionAuthority = async () => { throw providerError }

    await expect(resolveTestAfkWorkflowActionAuthority(
      deps,
      'ready-a',
      { skill_bundle_id: '_all', loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )).rejects.toBe(providerError)
  })

  it('keeps a malformed Skill authority payload as the deterministic malformed skill-policy denial', async () => {
    const deps = makeDeps({
      cwd: '/repo',
      state: mockState({ track: 'backend', automation: 'queued' }),
    })
    deps.resolveSkillActionAuthority = async () => ({ malformed: true })

    const facts = await resolveTestAfkWorkflowActionAuthority(
      deps,
      'ready-a',
      { skill_bundle_id: '_all', loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )

    expect(facts.skill).toEqual({ status: 'malformed', grants: [] })
  })

  it('denies an archived exact Run even when automation remains queued', async () => {
    const state = {
      ...mockState({ track: 'backend', automation: 'queued', archived: 'true' }),
      runMetadata: {
        runId: exactRun.id,
        transitionSequence: 0,
        workflowPlanFingerprint: exactRun.workflowPlanFingerprint,
        loopId: exactRun.loopId,
        iterationId: exactRun.iterationId,
      },
    }

    const facts = await resolveTestAfkWorkflowActionAuthority(
      withEnterAfkSkillAuthority(makeDeps({ cwd: '/repo', state })),
      'ready-a',
      { skill_bundle_id: '_all', loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )

    expect(facts.run).toEqual({ status: 'valid', grants: [] })
  })

  it.each([
    ['skill', mockState({ track: 'backend', automation: 'queued' }), null, 'missing'],
    ['run', mockState({ track: 'backend', automation: 'off' }), '_all', 'valid'],
  ] as const)('keeps %s denial independent instead of expanding it from AFK mode', async (
    layer,
    baseState,
    skillBundleId,
    status,
  ) => {
    const state = {
      ...baseState,
      runMetadata: {
        runId: exactRun.id,
        transitionSequence: 0,
        workflowPlanFingerprint: exactRun.workflowPlanFingerprint,
        loopId: exactRun.loopId,
        iterationId: exactRun.iterationId,
      },
    }
    const facts = await resolveTestAfkWorkflowActionAuthority(
      withEnterAfkSkillAuthority(makeDeps({ cwd: '/repo', state })),
      'ready-a',
      { skill_bundle_id: skillBundleId, loop_id: 'lp', iteration_id: 'iteration-current' },
      exactRun,
    )

    expect(facts[layer]).toEqual({ status, grants: [] })
  })
})

describe('resolveBundledCliDistSha256 · 只认运行中的 dist/tenon.mjs', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('确认 packages/cli/dist/tenon.mjs 后按真实字节计算 sha256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-cli-digest-'))
    roots.push(root)
    const path = join(root, 'packages', 'cli', 'dist', 'tenon.mjs')
    await mkdir(join(root, 'packages', 'cli', 'dist'), { recursive: true })
    await writeFile(path, 'bundled-cli-bytes\n')

    await expect(resolveBundledCliDistSha256(pathToFileURL(path).href)).resolves.toBe(
      createHash('sha256').update('bundled-cli-bytes\n').digest('hex'),
    )
  })

  it('源码 afk-executor.ts 即使可读也拒绝，绝不把源码/测试文件 sha 冒充镜像期望', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-cli-source-'))
    roots.push(root)
    const path = join(root, 'packages', 'cli', 'src', 'commands', 'afk-executor.ts')
    await mkdir(join(root, 'packages', 'cli', 'src', 'commands'), { recursive: true })
    await writeFile(path, 'source-bytes\n')

    await expect(resolveBundledCliDistSha256(pathToFileURL(path).href))
      .rejects.toBeInstanceOf(BundledCliDigestUnavailableError)
  })
})
