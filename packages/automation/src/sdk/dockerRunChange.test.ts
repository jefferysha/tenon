import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markLoopPrepared, markNonLoopPrepared, type ExecutionContext, type PreparedExecutionContext } from '../admission/execution-context.js'
import { worktreePathFor } from '../lifecycle/worktree.js'
import type { ExecFn, ExecResult } from '../runner/exec.js'
import { materializeSkillSnapshot } from '../skills/snapshot-store.js'
import { createDockerRunChange } from './dockerRunChange.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

/**
 * createDockerRunChange 装配面（fake exec，无需真 docker）。GOAL H · Stage B 后 RunChange 吃
 * ExecutionContext：runner/change/loop_id 由 context 权威携带（不再 resolveRunner 前缀猜）。
 */
const SHA = 'a'.repeat(40)

/**
 * 最小裸 ExecutionContext（runner/loopId/policy_epoch/skill_bundle_id 均可覆盖，模拟
 * admission.reserve() 产出的 pre-prepare context——本身不满足 PreparedExecutionContext，仅供
 * mkCtx/markLoopPrepared 之类唯一合法构造点作为输入）。
 */
const mkBaseCtx = (
  change: string,
  over: { runner?: string; loopId?: string; policyEpoch?: string; skillBundleId?: string | null } = {},
): ExecutionContext => ({
  attempt_id: 'att', reservation_id: 'res', loop_id: over.loopId ?? 'lp', change,
  level: 'L1', runner: over.runner ?? 'claude-code', admitted_at: 't',
  reservation: { runs: 1, tokens: 2000, token_basis: 'risk-default' },
  policy_epoch: over.policyEpoch ?? 'epoch-mock', skill_bundle_id: over.skillBundleId ?? null,
})

/**
 * H10 r1 阻断3/D5 返工（任务B1）：唯一合法构造点是 markNonLoopPrepared()——绝大多数用例（无
 * skillBundle）的缺省 prepared 形态，不再手写字面量冒充满足 PreparedExecutionContext（裸字面量
 * 按结构类型曾经天然满足接口，是 r1 复审阻断3 的确切成因，见 execution-context.ts 头注）。
 */
const mkCtx = (
  change: string,
  over: { runner?: string; loopId?: string; policyEpoch?: string; skillBundleId?: string | null } = {},
): PreparedExecutionContext => markNonLoopPrepared(mkBaseCtx(change, over))

const makeFakeExec = (): { exec: ExecFn; calls: string[][] } => {
  const calls: string[][] = []
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'docker' && args[0] === 'exec') {
      return { stdout: `<output>{"verify_result":"pass","build_sha":"${SHA}","phase_event":"verify-pass"}</output>\n`, stderr: '', exitCode: 0 }
    }
    if (file === 'git' && args.includes('rev-list')) {
      return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 }
    }
    const res: ExecResult = { stdout: `${SHA}\n`, stderr: '', exitCode: 0 }
    return res
  }
  return { exec, calls }
}

/**
 * H7 verifier Phase 2：createDockerRunChange 是 lifecycle 唯一的真实 ExecutionContext 持有点
 * （scheduler.runChange(context, signal) 的 context 形参）——必须真透传进 RunChangeConfig.context，
 * 否则 VerifierPort 收到的 subject 字段（attempt_id/change/workflow_run_id）只是 lifecycle 内部合成
 * 的最小兜底值，不是 admission 权威归属。opts.verifier 可选注入，未传 → createLifecyclePorts 缺省
 * createDefaultVerifierPort()（诚实 inconclusive）。
 */
describe('createDockerRunChange · H7 verifier Phase 2：context 真透传 + verifier 可选注入', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-verifier-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('真实 ExecutionContext（attempt_id/workflow_run_id）真透传到 verifier.verify 的入参', async () => {
    const { exec } = makeFakeExec()
    const seen: unknown[] = []
    const verifier = {
      async verify(input: Parameters<NonNullable<Parameters<typeof createDockerRunChange>[0]['verifier']>['verify']>[0]) {
        seen.push(input)
        return {
          schema_version: 1 as const, verification_id: 'v1',
          subject: { workflow_run_id: input.workflowRunId, attempt_id: input.context.attempt_id, change: input.context.change, revision: { kind: 'named-branch-head' as const, sha: input.revisionSha } },
          binding: input.workflowBinding, verdict: 'passed' as const,
          evidence: [{ kind: 'command-result' as const, command_id: 'x', exit_code: 0 }],
          issuer: { kind: 'host-verifier' as const, verifier: 'v', version: '1', trusted: true as const },
          evaluated_at: '2026-07-19T00:00:00.000Z',
        }
      },
    }
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, verifier })
    const ctx = mkCtx('x', { runner: 'claude-code' })
    await runChange({ ...ctx, workflow_run_id: 'wfr-real-9' }, new AbortController().signal)
    expect(seen).toHaveLength(1)
    const input = seen[0] as { context: { attempt_id: string; change: string }; workflowRunId: string }
    expect(input.context.attempt_id).toBe('att') // mkCtx 的真实 attempt_id（非 lifecycle 合成兜底）
    expect(input.context.change).toBe('x')
    expect(input.workflowRunId).toBe('wfr-real-9')
  })

  it('未传 opts.verifier → 行为不变（缺省 createDefaultVerifierPort，不炸）', async () => {
    const { exec } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await expect(runChange(mkCtx('x'), new AbortController().signal)).resolves.toBeDefined()
  })
})

describe('createDockerRunChange · extraEnv 真流到 docker run argv', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-argv-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('opts.extraEnv 的每个键值都以 -e KEY=VALUE 出现在 docker run 调用里', async () => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec,
      extraEnv: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:9', CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
    })
    await runChange(mkCtx('x'), new AbortController().signal)

    const dockerRun = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(dockerRun).toBeDefined()
    expect(dockerRun).toContain('-e')
    const joined = dockerRun!.join(' ')
    expect(joined).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:9')
    expect(joined).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-secret')
  })

  it('未传 extraEnv 时不炸（缺省行为不变，仍只有 TENON_AFK=1）', async () => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await runChange(mkCtx('x'), new AbortController().signal)
    const dockerRun = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(dockerRun!.join(' ')).toContain('TENON_AFK=1')
  })
})

describe('createDockerRunChange · H14 CLI bundle imageExpectation 全链透传', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-cli-digest-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('DockerRunChangeOptions → LifecyclePorts → buildAfkRunCommand，docker exec 真命令含 digest guard', async () => {
    const { exec, calls } = makeFakeExec()
    const cliDigest = 'e'.repeat(64)
    const runChange = createDockerRunChange({
      hostRepoDir: repo,
      base: 'main',
      level: 'L1',
      image: 'sandcastle:local',
      exec,
      imageExpectation: { cliDistSha256: cliDigest },
    })

    await runChange(mkCtx('digest-case', { runner: 'codex' }), new AbortController().signal)

    const runWorkExec = calls.find((call) =>
      call[0] === 'docker'
      && call[1] === 'exec'
      && call.join(' ').includes('tenon-afk-run digest-case'))
    expect(runWorkExec).toBeDefined()
    const command = runWorkExec!.join(' ')
    expect(command).toContain(cliDigest)
    expect(command).toContain('/opt/pipeline/packages/cli/dist/tenon.mjs')
    expect(command).toContain('pipeline_cli_dist_sha256=')
  })
})

/**
 * Task 1 收尾缺口修复：opts.store 一旦注入，automation_sandbox/automation_worktree 真落盘非空。
 */
describe('createDockerRunChange · opts.store 真接线（Task 1 收尾缺口）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-store-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('注入真 StateStore 后，runChange 结束前把 automation_sandbox/automation_worktree 真写回该 store（非空）', async () => {
    const { exec } = makeFakeExec()
    const store = createStateStore()
    const dir = await store.init({ repoRoot: repo, name: 'w', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full' })
    expect(await store.get(dir, 'automation_sandbox')).toBe('')
    expect(await store.get(dir, 'automation_worktree')).toBe('')

    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store })
    await runChange(mkCtx('w'), new AbortController().signal)

    const sandbox = await store.get(dir, 'automation_sandbox')
    const worktree = await store.get(dir, 'automation_worktree')
    expect(sandbox).not.toBe('')
    expect(sandbox).toMatch(/^sandcastle-/)
    expect(worktree).not.toBe('')
  })

  it('未传 opts.store 时行为不变（缺省 no-op，不 throw、不阻断 run）', async () => {
    const { exec } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await expect(runChange(mkCtx('x'), new AbortController().signal)).resolves.toBeDefined()
  })
})

/**
 * 决议 #12：resolveDenylist 装配面——GOAL H · Stage B 后按 context.loop_id 精确查（resolver 收
 * loopId），loop denylist 真流到 runChangeInSandbox 的结算检查。
 */
describe('createDockerRunChange · resolveDenylist（loop denylist 真实生效，决议 #12，按 loop_id）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-deny-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  const makeDiffExec = (diffFiles: string): { exec: ExecFn } => {
    const exec: ExecFn = async (file, args) => {
      if (file === 'docker' && args[0] === 'exec') {
        return { stdout: `<output>{"verify_result":"pass","build_sha":"${SHA}","phase_event":"verify-pass"}</output>\n`, stderr: '', exitCode: 0 }
      }
      if (file === 'git' && args.includes('rev-list')) {
        return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 }
      }
      if (file === 'git' && args.includes('diff')) {
        return { stdout: diffFiles, stderr: '', exitCode: 0 }
      }
      return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 }
    }
    return { exec }
  }

  it('resolver 给出 denylist（收到 loop_id）且 diff 命中 → run reject DenylistViolationError', async () => {
    const { exec } = makeDiffExec('docs/a.md\n')
    let gotLoopId = ''
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec,
      resolveDenylist: async (loopId) => { gotLoopId = loopId; return ['docs/**'] },
    })
    await expect(runChange(mkCtx('loop-a-fix', { loopId: 'styling' }), new AbortController().signal)).rejects.toMatchObject({ _tag: 'DenylistViolationError' })
    expect(gotLoopId).toBe('styling') // 按 context.loop_id 精确查，不再前缀猜
  })

  it('resolver 返回 [] → 检查跳过，run 正常 resolve', async () => {
    const { exec } = makeDiffExec('docs/a.md\n')
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, resolveDenylist: async () => [] })
    await expect(runChange(mkCtx('standalone'), new AbortController().signal)).resolves.toBeDefined()
  })

  it('legacy denylist resolver 自己 throw → fail-loud，不把未知策略降级为空', async () => {
    const { exec } = makeDiffExec('docs/a.md\n')
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, resolveDenylist: async () => { throw new Error('loops.yaml unreadable') } })
    await expect(runChange(mkCtx('x'), new AbortController().signal)).rejects.toThrow('loops.yaml unreadable')
  })

  it('未传 resolveDenylist → 行为不变（不查 denylist）', async () => {
    const { exec } = makeDiffExec('docs/a.md\n')
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await expect(runChange(mkCtx('x'), new AbortController().signal)).resolves.toBeDefined()
  })

  it('resolvePathPolicy 同次返回 allow/deny；L3 allowlist 外路径在 merge 前被拒', async () => {
    const { exec } = makeDiffExec('.github/workflows/ci.yml\n')
    let gotLoopId = ''
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L3', image: 'sandcastle:local', exec,
      resolvePathPolicy: async (loopId) => {
        gotLoopId = loopId
        return { allowlist: ['src/**'], denylist: [] }
      },
    })
    await expect(runChange(mkCtx('loop-a-fix', { loopId: 'styling' }), new AbortController().signal)).rejects.toMatchObject({
      _tag: 'AllowlistViolationError',
      files: ['.github/workflows/ci.yml'],
    })
    expect(gotLoopId).toBe('styling')
  })

  it('resolvePathPolicy 读取失败 → run fail-loud，零沙箱执行', async () => {
    const base = makeDiffExec('src/a.ts\n')
    let calls = 0
    const exec: ExecFn = async (...args) => { calls += 1; return base.exec(...args) }
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L3', image: 'sandcastle:local', exec,
      resolvePathPolicy: async () => { throw new Error('registry EIO') },
    })
    await expect(runChange(mkCtx('x'), new AbortController().signal)).rejects.toThrow('registry EIO')
    expect(calls).toBe(0)
  })

  it('L3 未装配 resolvePathPolicy（即使有 legacy denylist）→ fail-loud，零 docker/git 副作用', async () => {
    const base = makeDiffExec('src/a.ts\n')
    let calls = 0
    const exec: ExecFn = async (...args) => { calls += 1; return base.exec(...args) }
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L3', image: 'sandcastle:local', exec,
      resolveDenylist: async () => [],
    })
    await expect(runChange(mkCtx('x'), new AbortController().signal)).rejects.toMatchObject({
      _tag: 'PathPolicyResolverUnconfiguredError',
    })
    expect(calls).toBe(0)
  })
})

describe('createDockerRunChange · automation_worktree 写回前 sanitize（四闸防炸，Fix 2）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-worktree #evil-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('hostRepoDir 含 " #" 时，真 StateStore 写 automation_worktree 不炸、且已消毒（不再含 " #"）', async () => {
    const { exec } = makeFakeExec()
    const store = createStateStore()
    const dir = await store.init({ repoRoot: repo, name: 'w', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full' })
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store })
    await expect(runChange(mkCtx('w'), new AbortController().signal)).resolves.toBeDefined()
    const worktree = await store.get(dir, 'automation_worktree')
    expect(worktree).not.toBe('')
    expect(worktree).not.toContain(' #')
  })
})

describe('createDockerRunChange · automation_worktree 深路径不截断（真机 P1：cancel 500 根因）', () => {
  let base: string
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'dockerrc-deep-')) })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  it('worktree 全路径 > 200 字符 → 完整写回真 StateStore（与 worktreePathFor 派生值逐字相等）', async () => {
    const seg = 'x'.repeat(60)
    const repo = join(base, seg, seg, seg)
    await mkdir(repo, { recursive: true })
    const { exec } = makeFakeExec()
    const store = createStateStore()
    const dir = await store.init({ repoRoot: repo, name: 'deep', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full' })
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store })
    await expect(runChange(mkCtx('deep'), new AbortController().signal)).resolves.toBeDefined()
    const expected = worktreePathFor(repo, 'sandcastle-pipeline/deep')
    expect(expected.length).toBeGreaterThan(200)
    expect(await store.get(dir, 'automation_worktree')).toBe(expected)
  })
})

/**
 * v5 T20：runner 由 ExecutionContext 权威携带（admission 从 context.loop_id → loop.runner 派生）。
 * 'codex' → 沙箱命令构造点注入 TENON_RUNNER=codex；'claude-code' → 缺省 Claude 路径；
 * 历史/未知值（cron 等）必须 fail-closed，不能悄悄换 runner 执行。
 */
describe('createDockerRunChange · runner 由 context 派生（v5 T20）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-runner-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('context.runner=codex → docker exec 命令含 TENON_RUNNER=codex', async () => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await runChange(mkCtx('loop-a-fix', { runner: 'codex' }), new AbortController().signal)
    const dockerExec = calls.find((c) => c[0] === 'docker' && c[1] === 'exec')
    expect(dockerExec).toBeDefined()
    expect(dockerExec!.join(' ')).toContain('TENON_RUNNER=codex')
  })

  it('context.runner=claude-code → 命令不含 TENON_RUNNER（显式 Claude 兼容路径）', async () => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await runChange(mkCtx('x', { runner: 'claude-code' }), new AbortController().signal)
    const dockerExec = calls.find((c) => c[0] === 'docker' && c[1] === 'exec')
    expect(dockerExec!.join(' ')).not.toContain('TENON_RUNNER')
  })

  it('context.runner=历史/未知值 cron → fail-closed，不隐式降级到 Claude', async () => {
    const { exec } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await expect(runChange(mkCtx('x', { runner: 'cron' }), new AbortController().signal))
      .rejects.toThrow(/runner 非法.*claude-code.*codex/)
  })
})

/**
 * v5 T22：codex 凭证透传——仅 context.runner=codex 且 host 真有凭证时注入 OPENAI_API_KEY /
 * CODEX_HOME（+ CODEX_HOME 目录挂载）。hostEnv 显式注入（hermetic，不读真 process.env）。
 */
describe('createDockerRunChange · codex 凭证透传（v5 T22）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-cred-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  const run = async (opts: { runner?: string; hostEnv?: Readonly<Record<string, string | undefined>>; extraEnv?: Readonly<Record<string, string>> }): Promise<string> => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, hostEnv: opts.hostEnv ?? {}, extraEnv: opts.extraEnv })
    await runChange(mkCtx('loop-a-fix', { runner: opts.runner }), new AbortController().signal)
    const dockerRun = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(dockerRun).toBeDefined()
    return dockerRun!.join(' ')
  }

  it('runner=codex 且 host 有 OPENAI_API_KEY → 注入 -e OPENAI_API_KEY=<值>', async () => {
    expect(await run({ runner: 'codex', hostEnv: { OPENAI_API_KEY: 'sk-test-t22' } })).toContain('OPENAI_API_KEY=sk-test-t22')
  })

  it('runner=codex 且 host 有 CODEX_HOME（绝对路径）→ 注入 -e CODEX_HOME + 同路径目录挂载', async () => {
    const dockerRun = await run({ runner: 'codex', hostEnv: { CODEX_HOME: '/home/u/.codex' } })
    expect(dockerRun).toContain('CODEX_HOME=/home/u/.codex')
    expect(dockerRun).toContain('-v /home/u/.codex:/home/u/.codex')
  })

  it('runner=codex 但 host 无任何凭证 → 不注入', async () => {
    const dockerRun = await run({ runner: 'codex', hostEnv: {} })
    expect(dockerRun).not.toContain('OPENAI_API_KEY')
    expect(dockerRun).not.toContain('CODEX_HOME')
  })

  it('运行时兼容输入真缺 runner → Codex-first，不选 Claude 凭证（不靠 mkCtx 的显式 Claude 缺省）', async () => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec,
      hostEnv: { OPENAI_API_KEY: 'sk-codex-default', CLAUDE_CODE_OAUTH_TOKEN: 'must-not-leak' },
    })
    const legacyMissingRunner = { ...mkCtx('loop-a-fix', { runner: 'codex' }), runner: undefined } as unknown as PreparedExecutionContext
    await runChange(legacyMissingRunner, new AbortController().signal)
    const dockerRun = calls.find((call) => call[0] === 'docker' && call[1] === 'run')!.join(' ')
    expect(dockerRun).toContain('OPENAI_API_KEY=sk-codex-default')
    expect(dockerRun).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('runner=claude-code → 即便 host 有凭证也不注入（凭证只随点名它的 runner 走）', async () => {
    const dockerRun = await run({ runner: 'claude-code', hostEnv: { OPENAI_API_KEY: 'sk-test-t22', CODEX_HOME: '/home/u/.codex' } })
    expect(dockerRun).not.toContain('OPENAI_API_KEY')
    expect(dockerRun).not.toContain('CODEX_HOME')
  })

  it('显式 opts.extraEnv 同名键 > host 透传', async () => {
    const dockerRun = await run({ runner: 'codex', hostEnv: { OPENAI_API_KEY: 'sk-from-host' }, extraEnv: { OPENAI_API_KEY: 'sk-explicit' } })
    expect(dockerRun).toContain('OPENAI_API_KEY=sk-explicit')
    expect(dockerRun).not.toContain('sk-from-host')
  })

  it('runner=codex 时 extraEnv 也不能夹带 Claude 凭证；同 runner 凭证与普通 env 保留', async () => {
    const dockerRun = await run({
      runner: 'codex',
      extraEnv: {
        OPENAI_API_KEY: 'sk-explicit',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-must-not-leak',
        ANTHROPIC_BASE_URL: 'http://host.docker.internal:9',
      },
    })
    expect(dockerRun).toContain('OPENAI_API_KEY=sk-explicit')
    expect(dockerRun).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:9')
    expect(dockerRun).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(dockerRun).not.toContain('claude-must-not-leak')
  })
})

/**
 * v6 T2：claude-code 凭证透传——context.runner !== 'codex' 时从 hostEnv 白名单透传
 * CLAUDE_CODE_OAUTH_TOKEN；互斥纪律不变（codex 路径绝不带 claude token）。
 */
describe('createDockerRunChange · claude-code 凭证透传（v6 T2）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-cred2-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  const run = async (opts: { runner?: string; hostEnv?: Readonly<Record<string, string | undefined>>; extraEnv?: Readonly<Record<string, string>> }): Promise<string> => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, hostEnv: opts.hostEnv ?? {}, extraEnv: opts.extraEnv })
    await runChange(mkCtx('loop-a-fix', { runner: opts.runner }), new AbortController().signal)
    const dockerRun = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(dockerRun).toBeDefined()
    return dockerRun!.join(' ')
  }

  it('runner 显式 claude-code 且 host 有 CLAUDE_CODE_OAUTH_TOKEN → 注入 -e', async () => {
    const dockerRun = await run({ runner: 'claude-code', hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-v6t2' } })
    expect(dockerRun).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-v6t2')
  })

  it('runner=codex → CLAUDE_CODE_OAUTH_TOKEN 不注入（互斥）', async () => {
    const dockerRun = await run({ runner: 'codex', hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-v6t2', OPENAI_API_KEY: 'sk-ok' } })
    expect(dockerRun).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(dockerRun).toContain('OPENAI_API_KEY=sk-ok')
  })

  it('claude 路径不带 OPENAI_API_KEY（对称互斥）；空串 token 不注入', async () => {
    const dockerRun = await run({ runner: 'claude-code', hostEnv: { OPENAI_API_KEY: 'sk-ok', CLAUDE_CODE_OAUTH_TOKEN: '' } })
    expect(dockerRun).not.toContain('OPENAI_API_KEY')
    expect(dockerRun).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('显式 extraEnv 同名键 > host 透传（claude 路径同 codex 纪律）', async () => {
    const dockerRun = await run({ runner: 'claude-code', hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-from-host' }, extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-explicit' } })
    expect(dockerRun).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-explicit')
    expect(dockerRun).not.toContain('tok-from-host')
  })

  it('runner=claude-code 时 extraEnv 也不能夹带 Codex 凭证或 CODEX_HOME mount', async () => {
    const dockerRun = await run({
      runner: 'claude-code',
      extraEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: 'tok-explicit',
        OPENAI_API_KEY: 'codex-must-not-leak',
        CODEX_HOME: '/tmp/codex-must-not-mount',
        ANTHROPIC_BASE_URL: 'http://host.docker.internal:9',
      },
    })
    expect(dockerRun).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-explicit')
    expect(dockerRun).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:9')
    expect(dockerRun).not.toContain('OPENAI_API_KEY')
    expect(dockerRun).not.toContain('codex-must-not-leak')
    expect(dockerRun).not.toContain('CODEX_HOME')
    expect(dockerRun).not.toContain('/tmp/codex-must-not-mount')
  })
})

/**
 * H7-S3（H7 返工·修死 r2 阻断5 的生产半边——r2 §5：「createDockerRunChange 没有
 * workflowCoordinate 选项，也未向 lifecycle 传入」「生产 AFK 恒走 default-transition」）：
 * createDockerRunChange 现每次 run 读该 change 的 workflow 字段（kernel resolveWorkflowName(state)
 * 单一真相源）派生 cfg.workflowKind，恒显式传给 lifecycle（不再让它恒 undefined）。这里只验证
 * 「读 state → workflowKind → RunOutcome.requireWorkflowBinding」这条生产装配接线本身——「custom
 * workflow 因此真的拦下 trusted-passed 的 merge」这条端到端事实由 dockerRunChange.integration.
 * test.ts（真 docker + 真 scheduler，能看到真 merge 是否发生）覆盖；本文件的 fake exec 不模拟真实
 * git 仓状态（无 git init），不适合断言真 merge 是否发生。
 */
describe('createDockerRunChange · H7-S3：workflowKind 生产装配（现读 state.workflow）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-wfkind-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('已注入 store 且 change 的 workflow 字段非空/非 default → cfg.workflowKind=custom（RunOutcome.requireWorkflowBinding=true）', async () => {
    const { exec } = makeFakeExec()
    const store = createStateStore()
    const dir = await store.init({ repoRoot: repo, name: 'w', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full' })
    await store.set(dir, 'workflow', 'h7s3-custom-wf')
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store })
    const outcome = await runChange(mkCtx('w'), new AbortController().signal)
    expect(outcome.requireWorkflowBinding).toBe(true)
  })

  it('已注入 store 且 change 的 workflow 字段空（默认）→ cfg.workflowKind=default（requireWorkflowBinding=false，零回归）', async () => {
    const { exec } = makeFakeExec()
    const store = createStateStore()
    await store.init({ repoRoot: repo, name: 'w', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full' })
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store })
    const outcome = await runChange(mkCtx('w'), new AbortController().signal)
    expect(outcome.requireWorkflowBinding).toBe(false)
  })

  it('未传 opts.store（历史零 store 调用点）→ 无法读取 state，诚实回退 default（既有零 store 调用点行为不倒退）', async () => {
    const { exec } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    const outcome = await runChange(mkCtx('x'), new AbortController().signal)
    expect(outcome.requireWorkflowBinding).toBe(false)
  })

  it('已注入 store 但该 change 从未 init（store.read 抛错）→ fail-closed 回 custom（宁可这一轮不自动 merge，也不在读故障时冒充 default）', async () => {
    const { exec } = makeFakeExec()
    // 真 store，但从不对 'never-inited' 调 init()——store.read 会真 throw（ENOENT），走 catch 分支。
    const store = createStateStore()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store })
    const outcome = await runChange(mkCtx('never-inited'), new AbortController().signal)
    expect(outcome.requireWorkflowBinding).toBe(true)
  })

  /**
   * H7-S3 · expectedIssuerKind（r2 §5 核验结论「没有由端口注册信息派生 issuer 的独立信任锚」的
   * 生产装配确认）：默认装配（本用例未传 verifierExpectedIssuerKind——createDockerRunChange 也确实
   * 没有这个注入面，见其 verifier 字段文档）下，enforceVerificationBoundary 的锚恒为
   * DEFAULT_VERIFIER_ISSUER_KIND='host-verifier'（lifecycle.ts 的
   * `ports.verifierExpectedIssuerKind ?? DEFAULT_VERIFIER_ISSUER_KIND` 兜底）。注入的 verifier 若
   * 签发任何其它 issuer.kind（即便本身是 schema 合法的 trusted kind，如 human-review）都应被拒。
   * 此前只在 verifier.ts 单元测试层面证明过这条锚存在；本用例在「生产装配」（createDockerRunChange）
   * 这一层再证一遍，堵住"单元测试对、生产装配没真接上"这类此前在 custom workflow 坐标上出现过的
   * 落差（见 r2 §5 对 createDockerRunChange 的点名）。
   */
  it('生产默认装配（未传 verifierExpectedIssuerKind）：verifier 签发 issuer.kind=human-review（非 host-verifier，但本身是合法 trusted kind）→ boundary 判锚不符，降级 sentinel，不放行', async () => {
    const { exec } = makeFakeExec()
    const verifier = {
      async verify(input: Parameters<NonNullable<Parameters<typeof createDockerRunChange>[0]['verifier']>['verify']>[0]) {
        return {
          schema_version: 1 as const, verification_id: 'v-fake-issuer',
          subject: { workflow_run_id: input.workflowRunId, attempt_id: input.context.attempt_id, change: input.context.change, revision: { kind: 'named-branch-head' as const, sha: input.revisionSha } },
          binding: input.workflowBinding, verdict: 'passed' as const,
          evidence: [{ kind: 'command-result' as const, command_id: 'x', exit_code: 0 }],
          issuer: { kind: 'human-review' as const, actor_id: 'someone', trusted: true as const }, // 非 'host-verifier'
          evaluated_at: 't',
        }
      },
    }
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, verifier })
    const outcome = await runChange(mkCtx('x'), new AbortController().signal)
    // boundary 用 DEFAULT_VERIFIER_ISSUER_KIND='host-verifier' 作锚——verifier 谎报的 issuer.kind
    // 与锚不符 → 被 enforceVerificationBoundary 拒，降级 sentinel（inconclusive/untrusted）。「该
    // issuer.kind 本身合法（human-review 确实是 schema 允许的 trusted kind）」不构成放行理由——
    // 「合法但不是这次调用锚定的那个」同样不可信。
    expect(outcome.verification?.issuer.kind).toBe('sandbox-report')
    expect(outcome.verification?.issuer.trusted).toBe(false)
    expect(outcome.verification?.verdict).toBe('inconclusive')
  })
})

/**
 * H10 r5：沙箱隔离消费面端到端——context.skillBundle 从 createDockerRunChange 的 RunChange 参数，
 * 经 lifecycle.ts 元数据 env 注入、ports.ts 的 host 核验 → 无 CAS mount 起容器 → docker cp → root seal。
 * fake exec 记录完整 Docker argv；CAS 目录真实存在，host 核验仍跑生产实现。
 */
describe('createDockerRunChange · H10 r5：context.skillBundle 端到端流到 docker cp 私有目录 + 元数据 env', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-skillbundle-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('custom prepared bundle → 私有 CAS、step prompt env 与 verifier workflow binding 共用同一冻结坐标', async () => {
    const { exec, calls } = makeFakeExec()
    const sourceDir = join(repo, 'source-skills', 'demo-skill')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'SKILL.md'), '# Demo skill\n', 'utf8')
    // 用生产物化器生成完整 canonical descriptor，避免测试手写任意 digest/残缺 manifest
    // 绕开 host 与容器都会执行的真实完整性契约。
    const publish = await materializeSkillSnapshot([{ skillId: 'demo-skill', contentDir: sourceDir }], { projectRoot: repo })
    const casRelativePath = join('.pipeline', 'loops', 'skill-snapshots', 'sha256', publish.digest)
    const manifest = publish.manifests[0]!

    const store = createStateStore()
    const changeDir = await store.init({ repoRoot: repo, name: 'x', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full' })
    await store.set(changeDir, 'workflow', 'release-flow')
    const bindings: unknown[] = []
    const verifier = {
      async verify(input: Parameters<NonNullable<Parameters<typeof createDockerRunChange>[0]['verifier']>['verify']>[0]) {
        bindings.push(input.workflowBinding)
        return {
          schema_version: 1 as const, verification_id: 'v-coordinate',
          subject: { workflow_run_id: input.workflowRunId, attempt_id: input.context.attempt_id, change: input.context.change, revision: { kind: 'named-branch-head' as const, sha: input.revisionSha } },
          binding: input.workflowBinding, verdict: 'passed' as const,
          evidence: [{ kind: 'command-result' as const, command_id: 'coordinate', exit_code: 0 }],
          issuer: { kind: 'host-verifier' as const, verifier: 'coordinate-test', version: '1', trusted: true as const },
          evaluated_at: '2026-07-19T00:00:00.000Z',
        }
      },
    }
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, store, verifier,
      verifierExpectedIssuerIdentity: { kind: 'host-verifier', verifier: 'coordinate-test', version: '1' },
    })
    // H10 r1 阻断3/D5 返工（任务B1）：唯一合法构造点是 markLoopPrepared()——不再手写字面量+skillBundle
    // 字段冒充满足 PreparedExecutionContext。
    const ctx = markLoopPrepared(mkBaseCtx('x', { policyEpoch: 'epoch-1', skillBundleId: 'profile-a' }), {
      snapshotSha256: publish.digest, casRelativePath, resolutionSource: 'custom' as const,
      workflow: 'release-flow', step: 'verify', coordinateDigest: 'd'.repeat(64),
      stepPrompt: 'Run release browser E2E.\nDo not skip WebKit.',
      slots: [{ token: 'primary', alternatives: ['demo-skill'], concreteSkillId: 'demo-skill', treeSha256: manifest.treeSha256 }],
    })
    await runChange(ctx, new AbortController().signal)

    const dockerRun = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    expect(dockerRun).toBeDefined()
    const joined = dockerRun!.join(' ')
    const containerName = dockerRun![dockerRun!.indexOf('--name') + 1]!
    const volumeValues = dockerRun!.flatMap((arg, index) => arg === '-v' ? [dockerRun![index + 1]!] : [])
    expect(volumeValues.some((volume) => volume.startsWith(`${join(repo, casRelativePath)}:`))).toBe(false)
    expect(volumeValues.some((volume) => volume.includes(':/opt/pipeline-run/skill-bundle:'))).toBe(false)
    expect(joined).toContain('TENON_SKILL_BUNDLE_DIR=/opt/pipeline-run/skill-bundle')
    expect(joined).toContain(`TENON_SKILL_BUNDLE_SHA256=${publish.digest}`)
    expect(joined).toContain('TENON_SKILL_BUNDLE_ID=profile-a')
    expect(joined).toContain(`TENON_WORKFLOW_STEP_PROMPT_B64=${Buffer.from('Run release browser E2E.\nDo not skip WebKit.', 'utf8').toString('base64url')}`)
    expect(bindings).toEqual([{
      kind: 'workflow-transition', workflow_digest: 'd'.repeat(64), workflow: 'release-flow', step: 'verify', event: 'verify-pass',
    }])
    expect(calls).toContainEqual([
      'docker', 'cp', `${join(repo, casRelativePath)}/.`, `${containerName}:/opt/pipeline-run/skill-bundle`,
    ])
    expect(calls.some((c) =>
      c[0] === 'docker' && c[1] === 'exec' && c.includes('-u') && c.includes('0')
      && c.some((arg) => arg.includes('chown -R 0:0'))
      && c.some((arg) => arg.includes('chmod -R a+rX,a-w')))).toBe(true)
  })

  it('context.skillBundle 缺席（既有零 bundle 调用点）→ 无 skill-bundle env/cp/seal（回归）', async () => {
    const { exec, calls } = makeFakeExec()
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec })
    await runChange(mkCtx('x'), new AbortController().signal)
    const dockerRun = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    const joined = dockerRun!.join(' ')
    expect(joined).not.toContain('/opt/pipeline-run/skill-bundle')
    expect(joined).not.toContain('TENON_SKILL_BUNDLE')
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'cp')).toBe(false)
  })
})

/**
 * H10 §1（复审阻断1修复）：opts.startPermit 装配调用点——本文件此前对 startPermit 的接线零覆盖
 * （checkActive/mergePermit 同样零覆盖，非本次新增缺口）。证明 createDockerRunChange 真把
 * context.policy_epoch / context.skill_bundle_id 转发进 opts.startPermit 的第二个形参，而不是
 * 只转发 loopId、把新增的 prepared 值静默丢在半路——kernel::withLoopStartPermit 的治理身份比对
 * 全靠这条转发链把 prepare 阶段冻结的真实值送到它面前。
 */
describe('createDockerRunChange · H10 §1：startPermit 真传 policy_epoch/skill_bundle_id', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-startpermit-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('startPermit 收到的 (loopId, prepared) 与 context 的 loop_id/policy_epoch/skill_bundle_id 一致；fn 执行才真建沙箱', async () => {
    const { exec, calls } = makeFakeExec()
    const seen: { loopId: string; prepared: { policy_epoch: string; skill_bundle_id?: string | null } }[] = []
    const startPermit = async <T>(
      loopId: string,
      prepared: { policy_epoch: string; skill_bundle_id?: string | null },
      fn: () => Promise<T>,
    ): Promise<T> => {
      seen.push({ loopId, prepared })
      return fn() // 放行——同 kernel withLoopStartPermit 比对通过后的行为
    }
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, startPermit })
    const ctx = mkCtx('x', { loopId: 'lp-1', policyEpoch: 'epoch-xyz', skillBundleId: 'profile-z' })
    await runChange(ctx, new AbortController().signal)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.loopId).toBe('lp-1')
    expect(seen[0]!.prepared).toEqual({ policy_epoch: 'epoch-xyz', skill_bundle_id: 'profile-z' })
    // fn() 被真调用 → createSandbox 真发生 → docker run 真被调（放行路径未被短路）。
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'run')).toBe(true)
  })

  it('startPermit 拒绝（策略已变更）→ 错误 fail-loud 传出 runChange，绝不吞成成功、也不建沙箱', async () => {
    const { exec, calls } = makeFakeExec()
    class FakePolicyChangedError extends Error {
      readonly _tag = 'LoopPolicyChangedError'
    }
    const startPermit = async <T>(): Promise<T> => {
      throw new FakePolicyChangedError('policy changed')
    }
    const runChange = createDockerRunChange({ hostRepoDir: repo, base: 'main', level: 'L1', image: 'sandcastle:local', exec, startPermit })
    const ctx = mkCtx('x', { loopId: 'lp-1', policyEpoch: 'epoch-old', skillBundleId: 'profile-old' })
    await expect(runChange(ctx, new AbortController().signal)).rejects.toThrow('policy changed')
    // 沙箱从未创建：docker create/run 均未被调用（拒绝发生在 createSandbox 之前）。
    expect(calls.some((c) => c[0] === 'docker' && (c[1] === 'run' || c[1] === 'create'))).toBe(false)
  })
})

describe('createDockerRunChange · G5：mergePermit 真传冻结 policy_epoch/skill_bundle_id', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'dockerrc-merge-policy-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('L3 merge permit 收到 context 冻结治理身份，且 resolver 已显式装配', async () => {
    const { exec } = makeFakeExec()
    const seen: Array<{ loopId: string; prepared: { policy_epoch: string; skill_bundle_id?: string | null } }> = []
    const mergePermit = async <T>(
      loopId: string,
      prepared: { policy_epoch: string; skill_bundle_id?: string | null },
      fn: () => Promise<T>,
      verifyBase: () => Promise<boolean>,
    ): Promise<T> => {
      seen.push({ loopId, prepared })
      expect(await verifyBase()).toBe(true)
      void fn // kernel governance tests cover fn execution; this wiring test stops before fake git merge machinery.
      return undefined as T
    }
    const verifier = {
      async verify(input: Parameters<NonNullable<Parameters<typeof createDockerRunChange>[0]['verifier']>['verify']>[0]) {
        return {
          schema_version: 1 as const,
          verification_id: 'v-g5-merge-permit',
          subject: {
            workflow_run_id: input.workflowRunId,
            attempt_id: input.context.attempt_id,
            change: input.context.change,
            revision: { kind: 'named-branch-head' as const, sha: input.revisionSha },
          },
          binding: input.workflowBinding,
          verdict: 'passed' as const,
          evidence: [{ kind: 'command-result' as const, command_id: 'g5', exit_code: 0 }],
          issuer: { kind: 'host-verifier' as const, verifier: 'g5-test', version: '1', trusted: true as const },
          evaluated_at: '2026-07-19T00:00:00.000Z',
        }
      },
    }
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base: 'main', level: 'L3', image: 'sandcastle:local', exec,
      resolvePathPolicy: async () => ({ allowlist: ['**'], denylist: [] }),
      mergePermit,
      verifier,
      verifierExpectedIssuerIdentity: { kind: 'host-verifier', verifier: 'g5-test', version: '1' },
      mergeJournal: {
        recordMergeIntent: async () => 'intent-g5',
        recordMergeLanded: async () => {},
      },
    })
    const outcome = await runChange(mkCtx('x', { loopId: 'lp-g5', policyEpoch: 'epoch-frozen', skillBundleId: 'profile-g5' }), new AbortController().signal)
    expect(outcome.verification?.verdict).toBe('passed')
    expect(outcome.verification?.issuer).toMatchObject({ verifier: 'g5-test', version: '1', trusted: true })
    expect(seen).toEqual([{ loopId: 'lp-g5', prepared: { policy_epoch: 'epoch-frozen', skill_bundle_id: 'profile-g5' } }])
  })
})
