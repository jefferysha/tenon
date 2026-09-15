import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinTrack, createStateStore, type VerificationResult } from '@tenon/kernel'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathFor } from '../lifecycle/worktree.js'
import { dockerAvailable } from '../runner/docker.js'
import { nodeExec } from '../runner/exec.js'
import type { ExecutionContext } from '../admission/execution-context.js'
import type { ActivateResult, LoopAdmission } from '../admission/loop-admission.js'
import type { VerifierPort } from '../verifier/verifier.js'
import { createAutomation } from './sdk.js'
import { createDockerRunChange } from './dockerRunChange.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const TEST_VERIFIER_IDENTITY = {
  kind: 'host-verifier', verifier: 'it-echo-verifier', version: '1',
} as const

/**
 * H7 verifier Phase 2：真容器跑出的 build_sha 只有运行期才知道（沙箱内确定性 commit），故这里注入
 * 一个 trusted verifier，原样回显调用方给的 revisionSha（barrier 派生的权威 build_sha）——不是伪造
 * pass，是诚实证明「scheduler 的 verification gate 对权威 SHA 放行、且用的是 barrier 值而非猜测」。
 * 默认 createDefaultVerifierPort()（inconclusive）在本 IT 会让 L3 只落 paused，故显式注入。
 */
const trustedEchoVerifier: VerifierPort = {
  async verify(input): Promise<VerificationResult> {
    return {
      schema_version: 1,
      verification_id: 'ver-it-echo',
      subject: {
        workflow_run_id: input.workflowRunId, attempt_id: input.context.attempt_id, change: input.context.change,
        revision: { kind: 'named-branch-head', sha: input.revisionSha },
      },
      binding: input.workflowBinding,
      verdict: 'passed',
      evidence: [{ kind: 'command-result', command_id: 'it-echo', exit_code: 0 }],
      issuer: { ...TEST_VERIFIER_IDENTITY, trusted: true },
      evaluated_at: '2026-07-07T00:00:00.000Z',
    }
  },
}

/**
 * 放行 admission（隔离 docker 全链测试，不牵扯 registry/binding）：总放行、settle no-op。reserve()
 * 契约本就产出裸 `ExecutionContext`（pre-prepare，见 loop-admission.ts::ReserveResult）——不经
 * markLoopPrepared/markNonLoopPrepared，那两个是 prepare() 成功分支的唯一合法构造点，不是 reserve()
 * 的。本 fake 未注入 opts.preparation，createAutomation 缺省走 sdk.ts::createDefaultExecutionPreparation
 * ——skill_bundle_id 显式置 null（无 bundle 绑定）→ 该缺省装配内部经 markNonLoopPrepared() 产出
 * PreparedExecutionContext，交给 runChange。policy_epoch 补齐为语义自洽的具体值（字段本身在
 * ExecutionContext 是必填，此前遗漏是历史欠账，不影响本文件行为——无 preparation 复核会比对它）。
 */
const passAdmission = (level: 'L1' | 'L3'): LoopAdmission => ({
  reserve: async (change): Promise<{ ok: true; context: ExecutionContext }> => ({
    ok: true,
    context: {
      // 本文件构建的是 WITH_CLAUDE_CODE=false + TEST fallback 镜像，故显式选择 Claude 兼容轨来测
      // deterministic fallback；真实 Codex-first 路径由 loop-run.real.integration.test.ts required 模式覆盖。
      attempt_id: 'att', reservation_id: 'res', loop_id: 'lp', change, level, runner: 'claude-code', admitted_at: 't',
      reservation: { runs: 1, tokens: 2000, token_basis: 'risk-default' },
      policy_epoch: 'epoch-it-mock', skill_bundle_id: null,
    },
  }),
  claimWithFreshWorkflowAuthority: async (ctx, claim) => ({
    ok: true, context: ctx, claimed: await claim('backend'),
  }),
  workflowAuthorityClaim: {
    version: 'v1',
    claim: async (ctx, claim) => ({ ok: true, context: ctx, claimed: await claim('backend') }),
  },
  activate: async (): Promise<ActivateResult> => ({ status: 'activated' }),
  settleWon: async () => {},
  settleLost: async () => {},
  recordMergeIntent: async () => 'integration-intent-1',
  recordMergeLanded: async () => {},
  isActive: async () => true,
})

/**
 * #29-wire 全链 e2e（诚实门，翻 automation docker honest-skip 的执行接线）：
 *   真 build sandcastle 镜像 → 真 docker 容器 → 真 git worktree（挂载）→ 沙箱内 tenon-afk-run
 *   确定性 build commit → 回读 <output> 握手 → host collectCommits + barrier build_sha → L3 真 merge-back。
 *
 *   · 无 docker daemon → honest skip（ctx.skip，vitest 计 skipped）+ 打印缺什么，绝不伪绿。
 *   · 缺编译产物 packages/cli/dist/tenon.mjs（先 npm run build）→ honest skip。
 *   · full CC-in-sandbox（真 agent 编码）→ 需 CLAUDE_CODE_OAUTH_TOKEN + WITH_CLAUDE_CODE 镜像 → honest skip。
 *   · 任何路径都不为绿伪造 pass（非零退出真抛错、noop 真判、merge 冲突真留现场）。
 */
const IMAGE = 'sandcastle:test'
const testMergeJournal = {
  async recordMergeIntent() { return 'integration-intent-1' },
  async recordMergeLanded() {},
}
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..') // sdk → src → automation → packages → root
const bundlePath = join(repoRoot, 'packages', 'cli', 'dist', 'tenon.mjs')
const dockerfile = join(repoRoot, 'tools', 'sandcastle', 'Dockerfile')

let hasDocker = false
let imageReady = false
let skipReason = ''

const clock = () => '2026-07-07T00:00:00Z'
const eligiblePolicy = () => builtinTrack('backend').policyProfile

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await nodeExec('git', args, { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

describe('createDockerRunChange · 真 docker 全链执行（#29-wire）', () => {
  beforeAll(async () => {
    hasDocker = await dockerAvailable((f, a) => nodeExec(f, a))
    if (!hasDocker) {
      skipReason = 'docker daemon 不可用（docker info 失败）'
      console.warn(`[HONEST SKIP] ${skipReason} → #29-wire 全链 IT 跳过，绝不伪绿。装 docker 后本地/CI 真跑。`)
      return
    }
    try {
      await access(bundlePath)
    } catch {
      skipReason = '缺 packages/cli/dist/tenon.mjs（先 npm run build）'
      console.warn(`[HONEST SKIP] ${skipReason} → #29-wire 全链 IT 跳过`)
      return
    }
    // 精简测试镜像（无 agent 层）：只有显式测试开关才允许 deterministic fallback；生产默认仍关闭。
    const r = await nodeExec('docker', [
      'build', '-f', dockerfile, '-t', IMAGE,
      '--build-arg', 'WITH_CLAUDE_CODE=false',
      '--build-arg', 'TENON_TEST_ALLOW_DETERMINISTIC_FALLBACK=1',
      repoRoot,
    ])
    if (r.exitCode !== 0) {
      skipReason = `sandcastle 镜像构建失败: ${r.stderr.slice(-500)}`
      console.warn(`[HONEST SKIP] ${skipReason}`)
      return
    }
    imageReady = true
  }, 600_000)

  let repo: string
  const store = createStateStore()

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'afk-wire-'))
    if (!imageReady) return
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.email', 'test@pipeline.local'])
    await git(repo, ['config', 'user.name', 'test'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  const seedChange = async (name: string): Promise<string> => {
    const dir = await store.init({
      repoRoot: repo, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    })
    await store.set(dir, 'phase', 'build')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'seed change'])
    return dir
  }

  it('L3：真容器跑 tenon-afk-run → 回读握手 → 真 merge-back 落 host base（automation=merged）', async (ctx) => {
    if (!imageReady) {
      ctx.skip()
      return
    }
    const dir = await seedChange('x')
    const base = (await nodeExec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()

    const auto = createAutomation({
      repoRoot: repo, store, clock,
      config: { level: 'L3', enabled: true, defaultOptIn: true }, admission: passAdmission('L3'),
      validateExecutionWiring: async () => ({ ok: true }),
    })
    expect(await auto.enqueue('x', eligiblePolicy)).toBe(true)

    const runChange = createDockerRunChange({
      hostRepoDir: repo, base, level: 'L3', image: IMAGE, idleMs: 120_000, graceMs: 15_000,
      resolvePathPolicy: async () => ({ allowlist: ['**'], denylist: [] }),
      verifier: trustedEchoVerifier, verifierExpectedIssuerIdentity: TEST_VERIFIER_IDENTITY,
      mergeJournal: testMergeJournal,
    })
    await auto.runRound(runChange)

    // 真落盘 merged（L3 自动合并；非伪造：只有沙箱真跑成功 + 真 merge + H7 verification gate 授权才到 merged）
    expect(await store.get(dir, 'automation')).toBe('merged')

    // host base ref 真拿到沙箱在命名分支上落的 build 产物（merge-back 真发生）——base ref 的树读：
    const merged = await nodeExec('git', ['show', `${base}:.sandcastle-build/x.done`], { cwd: repo })
    expect(merged.exitCode).toBe(0) // base ref 树里真含产物
    expect(merged.stdout).toContain('afk build for x')
    // 阻断1（第五轮返工）：mergeBackToBase CAS 成功后 `git read-tree -m -u <baseTip> <merge>` **真把产物同步进
    // host 主工作树**（此前只推 ref 不同步、主树 `git status` 显 staged deletion、用户看不到产物）。现在产物文件
    // 系统真可见、且相对 HEAD 干净（已同步进 index+工作树，非游离/未跟踪修改）。
    expect(await readFile(join(repo, '.sandcastle-build', 'x.done'), 'utf8')).toContain('afk build for x')
    const artifactStatus = await nodeExec('git', ['status', '--porcelain', '--', '.sandcastle-build/x.done'], { cwd: repo })
    expect(artifactStatus.stdout.trim()).toBe('') // 产物相对 HEAD 干净（真同步进树，不是游离文件）
    // 注：不断言 host 整树 clean——本 change 的 openspec/changes/x/.pipeline.yaml 被 run 期 scheduler
    // (automation:running) + settle (automation:merged) 写脏，是合法的脏；read-tree 刻意保留它（未改动路径本地
    // 改动不动），若用 reset --hard 全树打回反会把 automation 字段还原、令结算 running→merged CAS 落空。

    // 命名分支真存在且带真 commit（barrier build_sha 锚点）
    const branches = (await nodeExec('git', ['branch', '--list', 'sandcastle-pipeline/x'], { cwd: repo })).stdout
    expect(branches).toContain('sandcastle-pipeline/x')

    // afk-workbench Task 2 teardown 修复（见 task-2-report.md "Fix: log survives teardown"）：
    // L3 也走同一条结算落盘路径——worktree 真被 runChangeInSandbox 的 finally 块清掉之后，完整
    // 日志仍要能从 host 侧 openspec/changes/<name>/.sandcastle-run.log 读到。
    let worktreeLeaked = false
    try {
      await access(worktreePathFor(repo, 'sandcastle-pipeline/x'))
      worktreeLeaked = true
    } catch {
      /* 期望：真被 teardown 删除 */
    }
    expect(worktreeLeaked).toBe(false)
    const runLog = await readFile(join(dir, '.sandcastle-run.log'), 'utf8')
    expect(runLog).toContain('<output>')
    expect(runLog).toContain('verify_result')
  }, 300_000)

  /**
   * H7-S3（H7 返工·修死 r2 阻断5 的生产半边——r2 §5：「createDockerRunChange 没有
   * workflowCoordinate 选项，也未向 lifecycle 传入」「生产 AFK 恒走 default-transition」「custom
   * workflow 也能拿这个错误 binding 自动 merge」）：本用例把 change 的 workflow 字段显式改成非
   * default 值，createDockerRunChange 现读到它 → cfg.workflowKind='custom' → lifecycle 的
   * requireWorkflowBinding=true（H7-S2 已接好的 fail-closed 门槛，见 verifier.ts/lifecycle.ts）。
   * cfg.workflowCoordinate 在本包仍从未被任何生产调用点填充（G2 IR 无 digest，见 lifecycle.ts
   * 头注「custom workflow 坐标」段落），故 lifecycle 构造的 binding 仍是 default-transition
   * （不是伪造的 workflow-transition）。trustedEchoVerifier 诚实回显 trusted:true + verdict:
   * passed + 逐字相符的 subject/binding——与上面「L3：真容器跑…」用例（default workflow、同一
   * verifier）唯一的差别只是这里的 workflow 字段非 default。若只看"verifier 说过 trusted pass"，
   * 两者理应同样 merged；但 custom workflow 的 requireWorkflowBinding fail-closed 会在这里拦下它
   * （canonical.binding.kind==='default-transition'≠'workflow-transition'）——这正是 H7-S3 要修死
   * 的绕过：H7-S3 之前，dockerRunChange 从不读 workflow 字段、cfg.workflowKind 恒 undefined，本
   * 用例会以 automation=merged 收场（与上面 default workflow 用例的观测结果没有任何差别，即
   * r2 §5 点名的"custom workflow 也能拿这个错误 binding 自动 merge"）。上面「L3：真容器跑…」用例
   * 正是本用例的对照组（default workflow + 同一 trustedEchoVerifier + 同一 L3 → authorized→
   * merged）。
   */
  it('H7-S3：custom workflow change + L3 + trusted-passed verifier → fail-closed，绝不 merged（reason=verification-binding-unresolved）', async (ctx) => {
    if (!imageReady) {
      ctx.skip()
      return
    }
    const dir = await seedChange('custom-a')
    await store.set(dir, 'workflow', 'h7s3-custom-workflow') // resolveWorkflowName≠'default' → workflowKind='custom'
    const base = (await nodeExec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()

    const auto = createAutomation({
      repoRoot: repo, store, clock,
      config: { level: 'L3', enabled: true, defaultOptIn: true }, admission: passAdmission('L3'),
      validateExecutionWiring: async () => ({ ok: true }),
    })
    expect(await auto.enqueue('custom-a', eligiblePolicy)).toBe(true)

    // H7-S3：workflowKind 生产装配靠 opts.store 现读该 change 的 state 派生（见
    // dockerRunChange.ts::resolveWorkflowKindFor）——本用例必须真注入 store（同上面 seed/断言用的
    // 同一个 store 实例），否则 dockerRunChange 拿不到读取该 change 的通道，只能诚实回退
    // 'default'，本用例就测不出 custom fail-closed 这条差别（上面「L3：真容器跑…」等既有用例不
    // 传 store 是因为它们不需要验证 automation_sandbox/automation_worktree 写回或 workflowKind
    // 读取，这里的用途不同）。
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base, level: 'L3', image: IMAGE, idleMs: 120_000, graceMs: 15_000,
      resolvePathPolicy: async () => ({ allowlist: ['**'], denylist: [] }),
      verifier: trustedEchoVerifier, verifierExpectedIssuerIdentity: TEST_VERIFIER_IDENTITY, store,
    })
    await auto.runRound(runChange)

    // fail-closed：即便 verifier trusted+passed+subject 全符，custom workflow 缺真实 workflow-
    // transition binding 仍不放行——诚实 paused + 精确 reason（不是笼统 verify-fail/未知错误）。
    expect(await store.get(dir, 'automation')).toBe('paused')
    expect(await store.get(dir, 'automation_cause')).toBe('verification-binding-unresolved')
    // 物理层面同样没有 merge（lifecycle 的 mergeGate 与 scheduler 的 settlement gate 共享同一纯
    // 函数判定，不会出现「git 已合并、字段却说未合并」的分裂）：host base 不含沙箱产物。
    const shown = await nodeExec('git', ['show', `${base}:.sandcastle-build/custom-a.done`], { cwd: repo })
    expect(shown.exitCode).not.toBe(0)
  }, 300_000)

  it('L1 report-only：真容器跑成功但**不自动 merge**（automation=paused，host base 不含产物）', async (ctx) => {
    if (!imageReady) {
      ctx.skip()
      return
    }
    const dir = await seedChange('y')
    const base = (await nodeExec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()

    const auto = createAutomation({
      repoRoot: repo, store, clock,
      config: { level: 'L1', enabled: true, defaultOptIn: true }, admission: passAdmission('L1'),
      validateExecutionWiring: async () => ({ ok: true }),
    })
    await auto.enqueue('y', eligiblePolicy)
    const runChange = createDockerRunChange({
      hostRepoDir: repo, base, level: 'L1', image: IMAGE, idleMs: 120_000, graceMs: 15_000,
    })
    await auto.runRound(runChange)

    // L1 安全默认：成功也停 paused，不自动合并回主线
    expect(await store.get(dir, 'automation')).toBe('paused')
    // host base 不含沙箱产物（未 merge）
    let leaked = false
    try { await access(join(repo, '.sandcastle-build', 'y.done')); leaked = true } catch { /* 期望不存在 */ }
    expect(leaked).toBe(false)

    // afk-workbench Task 2 teardown 修复（见 task-2-report.md "Fix: log survives teardown"）：
    // 早期版本把完整日志落在 worktree 内——但成功结算这一类，runChangeInSandbox 的 finally 块
    // 会真删 worktree（下方断言先钉死这一点：worktree 目录真的从磁盘消失，不是编排层偷懒没删），
    // 日志刚写完就随之消失。真容器跑完这个最常见的"成功"结局后，完整日志现在应仍可从 host 侧
    // openspec/changes/<name>/.sandcastle-run.log 读到。
    let worktreeLeaked = false
    try {
      await access(worktreePathFor(repo, 'sandcastle-pipeline/y'))
      worktreeLeaked = true
    } catch {
      /* 期望：真被 teardown 删除——这正是缺口曾经发生的地方 */
    }
    expect(worktreeLeaked).toBe(false)
    const runLog = await readFile(join(dir, '.sandcastle-run.log'), 'utf8')
    expect(runLog).toContain('<output>')
    expect(runLog).toContain('verify_result')
  }, 300_000)

  it('full CC-in-sandbox（真 agent 编码）需 CLAUDE_CODE_OAUTH_TOKEN + WITH_CLAUDE_CODE 镜像 → honest skip', (ctx) => {
    if (!imageReady) {
      ctx.skip()
      return
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      console.warn('[HONEST SKIP] 缺 CLAUDE_CODE_OAUTH_TOKEN → full CC-in-sandbox 跳过（缺沙箱内 agent 认证）')
      ctx.skip()
      return
    }
    console.warn('[HONEST SKIP] full CC-in-sandbox 需 WITH_CLAUDE_CODE=true 镜像 + 真 agent 编码，本 wire 的 host 侧全链已覆盖')
    ctx.skip()
  })
})
