import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  createStateStore,
  createTransitionRecordStore,
  createWorkflowRunRepository,
} from '@tenon/kernel'
import {
  TriageOrchestrationError,
  triageCheckpointFilePath,
  type ProductionTriageProvider,
} from '@tenon/automation'
import { describe, expect, it, vi } from 'vitest'
import { loadAgentLibrary } from '@tenon/kernel'
import { fileURLToPath } from 'node:url'
import {
  cmdTriage,
  createCodexFirstTriageProvider,
  createProductionTriageRuntime,
  TriageCommandInterruptedError,
  type TriageCommandRuntime,
} from './triage.js'
import { makeDeps } from '../test-support.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')

const execFileAsync = promisify(execFile)

describe('cmdTriage', () => {
  it('默认 Codex 有界执行，并以稳定 JSON 如实报告创建与 checkpoint', async () => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = {
      run: vi.fn(async () => ({
        pagesProcessed: 1,
        observationsProcessed: 2,
        materializations: [{
          request: {
            schemaVersion: 1,
            kind: 'create-workflow-run',
            idempotencyKey: 'triage-workflow-run:v1:key',
            source: {
              sourceId: 'repo-head',
              actionKind: 'git-commits',
              observationId: 'git-commit:abc',
            },
            actionIdentity: 'triage-create:abc',
            candidateId: 'triage-candidate:abc',
            changeName: 'triage_abc',
            routeId: 'default-fix',
            workflowId: 'default',
            initialStep: 'open',
          },
          outcome: {
            status: 'created',
            run: {
              id: 'triage-run-v1-abc',
              workflowId: 'default',
              currentStep: 'open',
              lifecycle: 'active',
              transitionSequence: 0,
              createdAt: '2026-07-19T00:00:00Z',
              updatedAt: '2026-07-19T00:00:00Z',
            },
          },
        }],
        checkpoint: {
          schemaVersion: 1,
          sourceId: 'repo-head',
          actionKind: 'git-commits',
          cursor: '{"opaque":true}',
        },
        checkpointCommit: 'committed',
        hasMore: false,
        limitReached: false,
      })),
    }

    const code = await cmdTriage(deps, 'git-commits', { json: true }, runtime)

    expect(code).toBe(0)
    expect(runtime.run).toHaveBeenCalledWith({
      source: 'git-commits',
      provider: 'codex',
      model: 'gpt-5.6',
      pageSize: 20,
      maxPages: 4,
      maxHighCandidates: 10,
    })
    expect(deps.errLines).toEqual([])
    expect(JSON.parse(deps.outLines[0]!)).toEqual({
      schemaVersion: 1,
      command: 'triage',
      source: 'git-commits',
      provider: 'codex',
      model: 'gpt-5.6',
      pagesProcessed: 1,
      observationsProcessed: 2,
      workflowRuns: {
        total: 1,
        created: 1,
        existing: 0,
        runs: [{
          status: 'created',
          changeName: 'triage_abc',
          runId: 'triage-run-v1-abc',
          workflowId: 'default',
          currentStep: 'open',
        }],
      },
      checkpoint: {
        sourceId: 'repo-head',
        actionKind: 'git-commits',
        commit: 'committed',
        hasMore: false,
        limitReached: false,
      },
    })
  })

  it('拒绝 Claude provider，且不会启动任何 triage 副作用', async () => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = {
      run: vi.fn(async () => {
        throw new Error('must not run')
      }),
    }

    const code = await cmdTriage(
      deps,
      'git-commits',
      { provider: 'claude-code' },
      runtime,
    )

    expect(code).toBe(1)
    expect(runtime.run).not.toHaveBeenCalled()
    expect(deps.errLines).toEqual([
      "ERROR: triage provider 'claude-code' 不受支持；生产仅支持 codex",
    ])
  })

  it('未知 source fail-loud，且不会错误复用某个 connector', async () => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = { run: vi.fn() }

    const code = await cmdTriage(deps, 'filesystem', {}, runtime)

    expect(code).toBe(1)
    expect(runtime.run).not.toHaveBeenCalled()
    expect(deps.errLines).toEqual([
      "ERROR: triage source 'filesystem' 不受支持；允许 git-commits | loop-run-terminals",
    ])
  })

  it.each([
    [{ pageSize: '0' }, '--page-size'],
    [{ pageSize: '12x' }, '--page-size'],
    [{ maxPages: '1.5' }, '--max-pages'],
    [{ maxHighCandidates: '-1' }, '--max-high-candidates'],
    [{ maxPages: '9007199254740992' }, '--max-pages'],
  ] as const)('有界整数非法时在运行前失败：%j', async (options, flag) => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = { run: vi.fn() }

    const code = await cmdTriage(deps, 'git-commits', options, runtime)

    expect(code).toBe(1)
    expect(runtime.run).not.toHaveBeenCalled()
    expect(deps.errLines.join('\n')).toContain(flag)
  })

  it('拒绝 allowlist 外的 model，且不会启动 source', async () => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = { run: vi.fn() }

    const code = await cmdTriage(
      deps,
      'loop-run-terminals',
      { model: 'claude-opus' },
      runtime,
    )

    expect(code).toBe(1)
    expect(runtime.run).not.toHaveBeenCalled()
    expect(deps.errLines.join('\n')).toMatch(/model.*allowlist/i)
  })

  it('orchestration 失败会带 durable progress fail-loud，并返回诚实非零码', async () => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = {
      run: vi.fn(async () => {
        throw new TriageOrchestrationError(
          'provider-failed',
          'triage provider failed: Codex exited 7',
          [],
          {
            pagesCommitted: 2,
            observationsCommitted: 5,
            materializationsCompleted: [],
            durableCheckpoint: {
              schemaVersion: 1,
              sourceId: 'repo-head',
              actionKind: 'git-commits',
              cursor: 'opaque',
            },
            failedPageCheckpoint: null,
            checkpointCommit: 'not-attempted',
            retryable: true,
          },
        )
      }),
    }

    const code = await cmdTriage(deps, 'git-commits', {}, runtime)

    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('provider-failed')
    expect(deps.errLines.join('\n')).toContain('pages_committed=2')
    expect(deps.errLines.join('\n')).toContain('retryable=true')
    expect(deps.errLines.join('\n')).not.toContain('opaque')
  })

  it('到 max-pages 仍是已提交成功，并明确提示原命令续跑', async () => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = {
      run: vi.fn(async () => ({
        pagesProcessed: 4,
        observationsProcessed: 8,
        materializations: [],
        checkpoint: {
          schemaVersion: 1,
          sourceId: 'loop-ledger',
          actionKind: 'loop-run-terminals',
          cursor: 'opaque',
        },
        checkpointCommit: 'committed',
        hasMore: true,
        limitReached: true,
      })),
    }

    const code = await cmdTriage(deps, 'loop-run-terminals', {}, runtime)

    expect(code).toBe(0)
    expect(deps.errLines).toEqual([])
    expect(deps.outLines).toEqual([
      'TRIAGE source=loop-run-terminals provider=codex model=gpt-5.6',
      'pages=4 observations=8 workflow_runs=0 created=0 existing=0',
      'checkpoint=committed has_more=true limit_reached=true',
      'RESUME: source 仍有数据；原命令重跑将从 durable checkpoint 幂等续跑',
    ])
  })

  it('真实 Git + durable store 在 checkpoint 丢失后重跑收敛为 existing WorkflowRun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-cli-triage-'))
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
      await execFileAsync('git', ['config', 'user.name', 'Triage Test'], { cwd: root })
      await execFileAsync('git', ['config', 'user.email', 'triage@example.test'], { cwd: root })
      await writeFile(join(root, 'change.txt'), 'needs triage\n', 'utf8')
      await execFileAsync('git', ['add', 'change.txt'], { cwd: root })
      await execFileAsync('git', ['commit', '-m', 'fix unstable production path'], {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-07-19T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-07-19T00:00:00Z',
        },
      })

      const store = createStateStore()
      const runRepo = createWorkflowRunRepository({
        store,
        recordStore: createTransitionRecordStore(),
        clock: () => '2026-07-19T00:01:00Z',
      })
      const deps = {
        ...makeDeps({ cwd: root }),
        store,
        runRepo,
      }
      const provider: ProductionTriageProvider = {
        kind: 'codex',
        async classify(request) {
          return {
            output: {
              schemaVersion: 1,
              decisions: request.observations.map((observation) => ({
                observationId: observation.observationId,
                classification: 'high',
                rationale: 'Production failure needs a tracked fix.',
                routeId: 'default-fix',
              })),
            },
            provenance: {
              kind: 'codex',
              model: 'fixture-model',
              invocationId: 'fixture-invocation',
            },
          }
        },
      }
      const runtime = createProductionTriageRuntime({
        repoRoot: root,
        store,
        runRepository: runRepo,
        clock: () => '2026-07-19T00:01:00Z',
        creator: () => ({ id: 'tester@tenon.test', name: 'Tester', trust: 'declared' }),
        providerFactory: () => provider,
        signal: new AbortController().signal,
        // default 的每条分支都引用内建评审者：发布前要从真实 payload 冻结它们。
        loadAgentLibrary: () => loadAgentLibrary({ payloadRoot: REPO_ROOT, configRoot: join(root, '.config') }),
      })

      expect(await cmdTriage(deps, 'git-commits', { json: true }, runtime)).toBe(0)
      const first = JSON.parse(deps.outLines[0]!)
      expect(first.workflowRuns).toMatchObject({ total: 1, created: 1, existing: 0 })

      await unlink(triageCheckpointFilePath(root, {
        sourceId: 'repo-head',
        actionKind: 'git-commits',
      }))
      expect(await cmdTriage(deps, 'git-commits', { json: true }, runtime)).toBe(0)
      const recovered = JSON.parse(deps.outLines[1]!)
      expect(recovered.workflowRuns).toMatchObject({ total: 1, created: 0, existing: 1 })
      expect(
        (await readdir(join(root, 'openspec', 'changes'), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory()),
      ).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('默认 Codex provider 使用 ~/.codex 身份并移除全部 Claude/Anthropic 环境', async () => {
    let childEnv: Readonly<Record<string, string>> | undefined
    const provider = createCodexFirstTriageProvider({
      model: 'gpt-5.6',
      homeDir: () => '/users/codex-owner',
      env: {
        CODEX_HOME: '',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-secret',
        CLAUDECODE: '1',
      },
      exec: async (_file, args, options) => {
        childEnv = options.env
        const outputFlag = args.indexOf('--output-last-message')
        await writeFile(args[outputFlag + 1]!, '{"schemaVersion":1,"decisions":[]}\n', 'utf8')
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })

    await provider.classify({
      schemaVersion: 1,
      observations: [],
      routes: [{ routeId: 'default-fix', description: 'Create a fix.' }],
      maxHighCandidates: 0,
    }, new AbortController().signal)

    expect(childEnv).toEqual({ CODEX_HOME: '/users/codex-owner/.codex' })
    expect(JSON.stringify(childEnv)).not.toContain('claude-secret')
    expect(JSON.stringify(childEnv)).not.toContain('anthropic-secret')
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s 中断返回 shell 约定退出码', async (signal, expectedCode) => {
    const deps = makeDeps()
    const runtime: TriageCommandRuntime = {
      run: vi.fn(async () => {
        throw new TriageCommandInterruptedError(signal)
      }),
    }

    const code = await cmdTriage(deps, 'loop-run-terminals', {}, runtime)

    expect(code).toBe(expectedCode)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toEqual([`ERROR: triage interrupted by ${signal}`])
  })

  it('production runtime 将 SIGINT 传播到 provider，清理 handler 并上抛 130 中断', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-cli-triage-signal-'))
    const handlers = new Map<string, () => void>()
    const processSignals = {
      once: vi.fn((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        handlers.set(signal, listener)
        return processSignals
      }),
      off: vi.fn((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        if (handlers.get(signal) === listener) handlers.delete(signal)
        return processSignals
      }),
    }
    let classifyStarted!: () => void
    const started = new Promise<void>((resolve) => { classifyStarted = resolve })
    const provider: ProductionTriageProvider = {
      kind: 'codex',
      classify: vi.fn(async (_request, signal) => {
        classifyStarted()
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }),
    }
    const store = createStateStore()
    const runRepo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock: () => '2026-07-19T00:01:00Z',
    })
    const runtime = createProductionTriageRuntime({
      repoRoot: root,
      store,
      runRepository: runRepo,
      clock: () => '2026-07-19T00:01:00Z',
      creator: () => ({ id: 'tester@tenon.test', name: 'Tester', trust: 'declared' }),
      providerFactory: () => provider,
      processSignals,
    })

    try {
      const pending = runtime.run({
        source: 'loop-run-terminals',
        provider: 'codex',
        model: 'gpt-5.6',
        pageSize: 20,
        maxPages: 4,
        maxHighCandidates: 10,
      })
      await started
      expect(handlers.has('SIGINT')).toBe(true)
      handlers.get('SIGINT')?.()

      await expect(pending).rejects.toMatchObject({
        name: 'TriageCommandInterruptedError',
        signal: 'SIGINT',
        exitCode: 130,
      })
      expect(provider.classify).toHaveBeenCalledOnce()
      expect(handlers.size).toBe(0)
      expect(processSignals.off).toHaveBeenCalledTimes(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
