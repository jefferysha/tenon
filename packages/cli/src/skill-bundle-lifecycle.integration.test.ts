/**
 * H10 skill bundle 生命周期 —— 跨包集成回归（设计定稿 §7「测试计划」/ §8 任务8「跨包回归与诚实门禁」）。
 *
 * 覆盖真临时仓库 + 真 `.pipeline/loops.yaml`（真 `loadRegistry`）+ 真 manifest 派生
 * （`loadManifest`/`createEffectiveSkillResolver`）+ 真 skill 内容目录（真 `createFsSkillContentLocator`）
 * + 真 workflow 坐标捕获（`createExecutionCoordinatePort`）+ 真 `.pipeline.yaml`（真 `createStateStore`）
 * + 真 ledger/CAS（真 `createLoopLedgerStore`/`createExecutionPreparation`/`materializeSkillSnapshot`）+
 * 真 `createScheduler` 编排（reserve→claim→prepare→activate→runChange→settle 全链），唯一的 fake 是
 * `RunChange`（不起真容器/真 git worktree——那是 task6/afk-run 的覆盖面，见下方「与既有测试的边界」）。
 *
 * 与既有测试的边界（避免误读成重复覆盖）：
 *   · packages/automation/src/admission/loop-admission.test.ts —— 单元级：registry/resolver/
 *     locator/coordinates 全部手写 fake，只有 ledger/CAS 落真 fs；且只单独调用
 *     `createExecutionPreparation(...).prepare()`，从不经过 `createScheduler` 的
 *     claim/activate/settle 编排层。本文件把 registry/manifest/resolver/locator/coordinates/
 *     ledger/CAS/state 全换成真实实现，且真跑完整 scheduler 编排（唯一 fake 是 runChange 本身）。
 *   · packages/cli/src/afk-run.integration.test.ts —— 真 docker + 真 `tenon afk run` CLI，但
 *     其 loops.yaml 恒 `skill_bundle_id: _all`，而该文件驱动的相位在真实 `templates/manifest.yaml`
 *     里从未声明 `_all` 键，三级回退空 slots——从未验证过“真实非空 skill 内容”的挂载/篡改路径。
 *     下方「可选真 docker e2e」补上这条路径（真实非空 `skill_bundle_id` + 真实 CAS 物化产物）。
 *   · packages/automation/src/runner/container.integration.test.ts —— 验证的是 `:ro` bind mount
 *     的通用 docker 机制（合成 `frozen.txt`，不经 CAS/`prepareSkillBundle`）。本文件验证的是
 *     `lifecycle/ports.ts::createSandbox` 对 `PreparedSkillBundle`（真实物化产物）的专属挂载路径 +
 *     host 侧 `verifySkillBundleSnapshot` 篡改检测——两者是不同的代码路径。
 *
 * oracle 裁决（设计定稿 §7）：H10 是新 v3 能力，不新增/修改 oracle 行为或 whitelist——本文件不碰
 * tools/oracle。注释纪律：只描述已经跑通的真实调用与断言，不声称尚未实现的 H11/H14 能力。
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_TRACK_DEFINITIONS,
  compileEffectiveWorkflowPlan, createEffectiveSkillResolver, createLoopLedgerStore, createLoopsYamlText,
  createStateStore, createTransitionRecordStore, createWorkflowRunRepository,
  ledgerDirPath, ledgerFilePath, loadManifest, loadRegistry, nodeLoopIoStrict,
  readRegistrySnapshot, updateLoopInYaml, writeRegistryWithGovernance,
  workflowPlanSnapshot,
  type ExtendedManifestData, type LoopLedgerStore, type NewLoopEntryInput, type StateStore, type TrackRegistry,
  type VerificationResult, type WorkflowRunRepository,
} from '@tenon/kernel'
import {
  createExecutionPreparation, createFsSkillContentLocator, createLifecyclePorts, createLoopAdmission,
  createScheduler, dockerAvailable, evaluateLoopExecutionWiring, getAutomation, materializeSkillSnapshot,
  markQueued, nodeExec, parseSkillActionAuthorityContract, skillActionAuthorityContract, storeWriter,
  SKILL_BUNDLE_CONTAINER_DIR, SkillBundleSnapshotMismatchError,
  type ExecFn, type ExecutionPreparationDeps, type ExecutionPreparationPort, type LoopAdmission,
  type MaterializeSkillSnapshotOptions, type PreparedExecutionContext, type RunChange,
  type SkillContentLocator, type SkillSnapshotInput, type SkillSnapshotPublishResult,
} from '@tenon/automation'
import { changeDir } from './paths.js'
import { createExecutionCoordinatePort } from './skillBundleAssembly.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const PROFILE = 'backend' // 具名 profile（词法与存在性都合法，见 registry.ts::SKILL_BUNDLE_ID_RE + 下方 isSkillProfileKnown）
const SKILL_ID = 'demo-skill'
const FIXED_CLOCK = '2026-07-18T00:00:00.000Z'
const TEST_TRACK_REGISTRY: TrackRegistry = {
  ordered: BUILTIN_TRACK_DEFINITIONS,
  byId: new Map(BUILTIN_TRACK_DEFINITIONS.map((track) => [track.id, track])),
  revision: '0123456789abcdef',
  source: 'builtin-only',
}
const AFK_WORKFLOW = compileEffectiveWorkflowPlan('skill-bundle-afk', {
  name: 'skill-bundle-afk',
  interaction: { version: 'v1', mode: 'afk' },
  steps: [{
    id: 'build', label: 'Build', gate: null,
    skills: [{ id: SKILL_ID }], inputs: [], outputs: [], guards: [], transitions: [{ event: 'build-complete', to: 'verify' }],
  }, {
    id: 'verify', label: 'Verify', gate: null,
    skills: [{ id: SKILL_ID }], inputs: [], outputs: [], guards: [], transitions: [],
  }],
})
const AFK_WORKFLOW_SNAPSHOT = workflowPlanSnapshot(AFK_WORKFLOW)
const AFK_WORKFLOW_YAML = `name: ${AFK_WORKFLOW.id}
interaction:
  version: v1
  mode: afk
steps:
  - id: build
    label: Build
    gate: null
    skills:
      - id: ${SKILL_ID}
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: build-complete
        to: verify
  - id: verify
    label: Verify
    gate: null
    skills:
      - id: ${SKILL_ID}
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** 最小真实 manifest 定稿：custom workflow 的 'build' step 在 'backend' track 的
 * explicit profile allowlist 恰是 SKILL_ID；custom bundle 仍只消费冻结 StepIR 声明，不注入 default。
 */
const MANIFEST_YAML = `phases:
  - build
transitions:
  build: []
review_phases: []
mandatory_skills:
  build.${PROFILE}: [${SKILL_ID}]
`

/** 真实（非手写字面量）loops.yaml 文本：先用 createLoopsYamlText 产出自校验过的基础条目，
 *  skillBundleId 未定义时不 patch（真历史文件形状——连字段行都不存在，不是显式 null）。 */
async function seedLoopYaml(
  repoRoot: string,
  spec: { id: string; changePrefix: string; skillBundleId?: string | null; status?: 'active' | 'paused' | 'retired' },
): Promise<void> {
  const entry: NewLoopEntryInput = {
    id: spec.id,
    name: `${spec.id} loop`,
    kind: 'orchestrator',
    goal: 'exercise H10 skill bundle lifecycle end to end',
    cadence: '1h',
    risk: 'low',
    runner: 'claude-code',
    workflow_id: AFK_WORKFLOW.id,
    change_prefix: spec.changePrefix,
    phases: ['build', 'verify'],
    human_gates: ['verify'],
    state: 'docs/state.md',
    design_doc: 'docs/design.md',
    status: spec.status ?? 'active',
    budget: { max_runs_per_day: 50, max_in_flight: 10, on_exceed: 'skip' },
    kill_criteria: ['no-change-3'],
  }
  const created = createLoopsYamlText(entry)
  if (created.text === null) throw new Error(`seedLoopYaml: ${created.error}`)
  let text = created.text
  if (spec.skillBundleId !== undefined) {
    const patched = updateLoopInYaml(text, spec.id, { skill_bundle_id: spec.skillBundleId })
    if (patched.text === null) throw new Error(`seedLoopYaml patch: ${patched.error}`)
    text = patched.text
  }
  await mkdir(join(repoRoot, '.pipeline'), { recursive: true })
  await writeFile(join(repoRoot, '.pipeline', 'loops.yaml'), text, 'utf8')
}

/** 真实治理写回（同 packages/cli/src/commands/afk.ts::pauseLoop 同款调用序，本文件独立小实现
 *  以免跨越清单越界改 afk.ts 才能导出它）：governance 锁 + epoch-CAS + updateLoopInYaml + 原子落盘。 */
async function pauseLoopReal(repoRoot: string, loopId: string): Promise<void> {
  const snap = await readRegistrySnapshot(repoRoot)
  if (snap.registry === null) throw new Error(`pauseLoopReal: loops.yaml 缺失或不可解析（${repoRoot}）`)
  const res = await writeRegistryWithGovernance(repoRoot, snap.epoch, (cur) => updateLoopInYaml(cur, loopId, { status: 'paused' }))
  if (!res.ok) throw new Error(`pauseLoopReal 失败：${res.error}`)
}

/** 一次真实 run 的固定“通过”事实：trusted+passed 且 subject 与 buildSha 都对齐 ctx 本身
 *  （evaluateVerificationGate 的 authorized 分支），settlement reason 落 'completed'（非 fail-closed 兜底）。 */
function passingVerification(ctx: PreparedExecutionContext, buildSha: string): VerificationResult {
  const binding = { kind: 'default-transition' as const, event: 'ship-complete' }
  return {
    schema_version: 1,
    verification_id: `ver-${ctx.attempt_id}`,
    subject: {
      workflow_run_id: ctx.workflow_run_id ?? ctx.attempt_id,
      attempt_id: ctx.attempt_id,
      change: ctx.change,
      revision: { kind: 'named-branch-head', sha: buildSha },
    },
    binding,
    verdict: 'passed',
    evidence: [{ kind: 'command-result', command_id: 'fake-e2e-runner', exit_code: 0 }],
    issuer: { kind: 'host-verifier', verifier: 'fake-e2e-runner', version: '1', trusted: true },
    evaluated_at: FIXED_CLOCK,
  }
}

/** 一套真实临时仓库装配：真 loops.yaml（skill_bundle_id=PROFILE）+ 真 manifest 定稿 + 真 skill 目录
 *  （SKILL.md + 可执行脚本，证明整目录物化而非只复制 Markdown）+ 真 `.pipeline.yaml`（phase=build,
 *  automation=queued）+ 真 ledger；runChange 是本文件唯一 fake，返回可预测的“成功”结局。 */
interface Rig {
  readonly repoRoot: string
  readonly store: StateStore
  readonly ledger: LoopLedgerStore
  readonly runRepo: WorkflowRunRepository
  readonly skillsRoot: string
  readonly manifest: ExtendedManifestData
  readonly loopId: string
  readonly change: string
  readonly changeDirPath: string
  readonly runCalls: PreparedExecutionContext[]
  readonly runChange: RunChange
}

async function initAfkChange(store: StateStore, repoRoot: string, name: string): Promise<string> {
  return store.init({
    repoRoot, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
    clock: () => FIXED_CLOCK,
    runId: `run-${name}`,
    initialWorkflow: {
      workflow: AFK_WORKFLOW.id,
      phase: 'build',
      workflowPlanFingerprint: AFK_WORKFLOW.workflowFingerprint,
      workflowPlanSnapshot: AFK_WORKFLOW_SNAPSHOT,
    },
  })
}

function exactWorkflowActionAuthority(store: StateStore, repoRoot: string) {
  return async (input: {
    change: string
    context: { loop_id: string; iteration_id?: string; skill_bundle_id: string | null }
    run: {
      id: string; workflowId?: string; workflowPlanFingerprint?: string
      loopId?: string; iterationId?: string
    }
    registry: TrackRegistry
  }) => {
    const state = await store.read(changeDir(repoRoot, input.change))
    const metadata = state.runMetadata
    const exact = metadata !== undefined
      && metadata.runId === input.run.id
      && input.run.workflowId === AFK_WORKFLOW.id
      && metadata.workflowPlanFingerprint === input.run.workflowPlanFingerprint
      && metadata.loopId === input.run.loopId
      && input.run.loopId === input.context.loop_id
      && metadata.iterationId === input.run.iterationId
      && input.run.iterationId === input.context.iteration_id
    const query = input.context.skill_bundle_id && input.run.workflowPlanFingerprint
      ? {
          change: input.change,
          skillBundleId: input.context.skill_bundle_id,
          workflowRunId: input.run.id,
          workflowFingerprint: input.run.workflowPlanFingerprint,
        }
      : null
    return {
      platform: { status: 'valid' as const, grants: ['enter-afk' as const] },
      skill: query
        ? parseSkillActionAuthorityContract(skillActionAuthorityContract(query, ['enter-afk']), query)
        : { status: 'missing' as const, grants: [] },
      project: { status: 'valid' as const, grants: ['enter-afk' as const] },
      run: exact
        ? { status: 'valid' as const, grants: ['enter-afk' as const] }
        : { status: 'fingerprint-mismatch' as const, grants: [] },
      projectAuthority: {
        version: 'v1' as const,
        track_id: 'backend',
        track_registry_revision: input.registry.revision,
      },
    }
  }
}

async function setupRig(opts: { loopId?: string } = {}): Promise<Rig> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'h10-skill-lifecycle-'))
  const loopId = opts.loopId ?? 'lp'
  const changePrefix = `${loopId}-`
  const change = `${changePrefix}x`

  await seedLoopYaml(repoRoot, { id: loopId, changePrefix, skillBundleId: PROFILE })
  await mkdir(join(repoRoot, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(repoRoot, '.pipeline', 'workflows', `${AFK_WORKFLOW.id}.yaml`), AFK_WORKFLOW_YAML)

  const manifestPath = join(repoRoot, 'fixture-manifest.yaml')
  await writeFile(manifestPath, MANIFEST_YAML, 'utf8')
  const manifest = loadManifest(manifestPath)

  const skillsRoot = join(repoRoot, 'skills-root')
  await mkdir(join(skillsRoot, SKILL_ID, 'scripts'), { recursive: true })
  await writeFile(join(skillsRoot, SKILL_ID, 'SKILL.md'), `# ${SKILL_ID}\n真实技能说明文档（H10 集成测试固定内容，禁止随意改动其字节，快照 hash 断言依赖它）。\n`, 'utf8')
  await writeFile(join(skillsRoot, SKILL_ID, 'scripts', 'run.sh'), '#!/bin/sh\necho demo\n', 'utf8')
  await chmod(join(skillsRoot, SKILL_ID, 'scripts', 'run.sh'), 0o755)

  const store = createStateStore()
  await initAfkChange(store, repoRoot, change)
  const changeDirPath = changeDir(repoRoot, change)
  await markQueued(store, changeDirPath, () => FIXED_CLOCK)

  const ledger = createLoopLedgerStore()
  const runRepo = createWorkflowRunRepository({
    store, recordStore: createTransitionRecordStore(), clock: () => FIXED_CLOCK,
  })

  const runCalls: PreparedExecutionContext[] = []
  const runChange: RunChange = async (ctx) => {
    runCalls.push(ctx)
    const buildSha = 'a'.repeat(40)
    return {
      commits: [{ sha: buildSha }],
      verifyResult: 'pass',
      buildSha,
      phaseEvent: 'ship-complete',
      verification: passingVerification(ctx, buildSha),
    }
  }

  return { repoRoot, store, ledger, runRepo, skillsRoot, manifest, loopId, change, changeDirPath, runCalls, runChange }
}

function buildAdmission(rig: Rig): LoopAdmission {
  return createLoopAdmission({
    repoRoot: rig.repoRoot,
    ledger: rig.ledger,
    loadRegistry: (r) => loadRegistry(r, nodeLoopIoStrict),
    clock: () => FIXED_CLOCK,
    level: 'L1',
    getAutomation: (change) => getAutomation(rig.store, changeDir(rig.repoRoot, change)),
    isSkillProfileKnown: (id) => id === PROFILE,
    bindAutomationPolicy: (change, policy, binding) =>
      rig.runRepo.bindAutomationPolicy(changeDir(rig.repoRoot, change), policy, binding),
    bindWorkflowActionAuthority: (change, snapshot) =>
      rig.runRepo.bindWorkflowActionAuthority(changeDir(rig.repoRoot, change), snapshot),
    withWorkflowActionAuthorityLock: async (use) => use(TEST_TRACK_REGISTRY),
    workflowActionAuthority: exactWorkflowActionAuthority(rig.store, rig.repoRoot),
  })
}

function buildPreparation(rig: Rig, overrides: Partial<ExecutionPreparationDeps> = {}): ExecutionPreparationPort {
  return createExecutionPreparation({
    repoRoot: rig.repoRoot,
    ledger: rig.ledger,
    loadRegistry: (r) => loadRegistry(r, nodeLoopIoStrict),
    clock: () => FIXED_CLOCK,
    coordinates: createExecutionCoordinatePort({ store: rig.store, repoRoot: rig.repoRoot }),
    resolver: createEffectiveSkillResolver(rig.manifest),
    locator: createFsSkillContentLocator([rig.skillsRoot]),
    ...overrides,
  })
}

async function runRound(rig: Rig, admission: LoopAdmission, preparation: ExecutionPreparationPort) {
  const resolver = createEffectiveSkillResolver(rig.manifest)
  const locator = createFsSkillContentLocator([rig.skillsRoot])
  const scheduler = createScheduler({
    state: storeWriter(rig.store, (name) => changeDir(rig.repoRoot, name)),
    runChange: rig.runChange,
    registerShutdown: () => () => {},
    config: { maxParallel: 4, maxRetries: 1, level: 'L1' },
    admission,
    preparation,
    pauseLoop: (loopId) => pauseLoopReal(rig.repoRoot, loopId),
    // admission 是可注入边界；即便本文件使用真实 registry，也必须显式完成 fresh wiring 授权，
    // 不能靠 context 自报的 skill_bundle_id 获得 scheduler 默认放行。
    validateExecutionWiring: async (context) => {
      const loaded = loadRegistry(rig.repoRoot, nodeLoopIoStrict)
      if (loaded.data === null || loaded.errors.length > 0) {
        return {
          ok: false, status: 'invalid', dimension: 'skill-bundle',
          reason: loaded.errors.join('；') || 'loops.yaml 缺失',
        }
      }
      const loop = loaded.data.loops.find((entry) => entry.id === context.loop_id)
      if (loop === undefined) {
        return {
          ok: false, status: 'invalid', dimension: 'skill-bundle',
          reason: `registry 中找不到 loop "${context.loop_id}"`,
        }
      }
      const verdict = await evaluateLoopExecutionWiring(loop, loaded.data.loops, {
        repoRoot: rig.repoRoot,
        skillBundleWiring: {
          resolver,
          locator,
          isSkillProfileKnown: (id) => id === PROFILE,
        },
      })
      return verdict.status === 'ready'
        ? { ok: true }
        : {
            ok: false,
            status: verdict.status,
            dimension: verdict.dimension,
            reason: verdict.reason,
          }
    },
  })
  return scheduler.runRoundOnce([rig.change])
}

/** 治理竞态注入：包一层真 locator——第一次 locate() 调用时先真实 governance-locked 改写 loops.yaml
 *  （复用生产同款 readRegistrySnapshot+writeRegistryWithGovernance+updateLoopInYaml），再委托给真
 *  locator 完成本次定位。模拟“准备期间（无锁解析窗口）另一方并发改了 loop”，而非 mock 整个 registry。 */
function raceLocator(rig: Rig, patch: Record<string, unknown>): SkillContentLocator {
  const real = createFsSkillContentLocator([rig.skillsRoot])
  let mutated = false
  return {
    async locate(skillId) {
      if (!mutated) {
        mutated = true
        const snap = await readRegistrySnapshot(rig.repoRoot)
        if (snap.registry === null) throw new Error('raceLocator: loops.yaml 缺失或不可解析（竞态注入失败）')
        const res = await writeRegistryWithGovernance(rig.repoRoot, snap.epoch, (cur) => updateLoopInYaml(cur, rig.loopId, patch))
        if (!res.ok) throw new Error(`raceLocator 并发改写失败：${res.error}`)
      }
      return real.locate(skillId)
    },
  }
}

describe('端到端全链 —— admission→prepareSkillBundle→snapshot→settlement（真临时仓库/真 registry/真 manifest/真 skill 目录/真 ledger+CAS/fake runner）', () => {
  let rig: Rig
  beforeEach(async () => { rig = await setupRig() })
  afterEach(async () => { await rm(rig.repoRoot, { recursive: true, force: true }) })

  it('真跑一轮：reserve→claim→prepareSkillBundle→activate→runChange→settle 全链落地，ledger/CAS/状态文件三处证据互相吻合', async () => {
    const admission = buildAdmission(rig)
    const preparation = buildPreparation(rig)
    const report = await runRound(rig, admission, preparation)

    expect(report.ok).toBe(true)
    expect(report.admitted).toBe(1)
    expect(report.failures).toEqual([])
    expect(report.entries).toEqual([
      { change: rig.change, loopId: rig.loopId, disposition: 'settled', result: 'paused', reason: undefined },
    ])

    // runChange 真的收到了已冻结的 skill bundle 摘要（RunChange 类型收窄到 PreparedExecutionContext 的编译期
    // 保证，在真实调用序里也确实成立，不只是类型层面的承诺）。判别联合下 skillBundle 只在
    // preparedKind==='loop-bundle' 分支存在（H10 r1 阻断3/D5），先显式判别窄化，不能再靠 `?.` 悄悄放过。
    expect(rig.runCalls).toHaveLength(1)
    const receivedCtx = rig.runCalls[0]!
    expect(receivedCtx.preparedKind).toBe('loop-bundle')
    const receivedBundle = receivedCtx.preparedKind === 'loop-bundle' ? receivedCtx.skillBundle : undefined
    expect(receivedBundle).toBeDefined()

    const { records, rejected } = await rig.ledger.read(rig.repoRoot)
    expect(rejected).toEqual([])
    const reservation = records.find((r) => r.kind === 'budget-reservation')
    const activated = records.find((r) => r.kind === 'reservation-activated')
    const snapshot = records.find((r) => r.kind === 'skill-bundle-snapshot')
    const run = records.find((r) => r.kind === 'run')
    expect(reservation).toBeDefined()
    expect(activated).toBeDefined()
    expect(snapshot).toBeDefined()
    expect(run).toBeDefined()

    if (snapshot?.kind !== 'skill-bundle-snapshot' || run?.kind !== 'run') throw new Error('unreachable：上方已 expect 定义')
    expect(snapshot.resolution_source).toBe('custom')
    expect(snapshot.skill_bundle_id).toBe(PROFILE)
    expect(snapshot.slots).toEqual([{ token: SKILL_ID, alternatives: [SKILL_ID], concrete_skill_id: SKILL_ID, tree_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(snapshot.snapshot_sha256).toBe(receivedBundle?.snapshotSha256)
    expect(run.result).toBe('paused')
    // 本文件的唯一 fake 是直接 RunChange；公共 package 不再暴露 boundary 签发能力，因此它的
    // 自报 verification 必须被 scheduler 降级。真实 lifecycle 正向 merge 由 docker 集成覆盖。
    expect(run.reason).toBe('verification-untrusted')
    expect(run.skill_bundle_snapshot_sha256).toBe(snapshot.snapshot_sha256)
    expect(run.accounting.charge_source).toBe('reserved-estimate')
    expect(run.accounting.charged_tokens).toBeGreaterThan(0)

    // 真 CAS：磁盘上的快照目录内容与源 skill 目录逐字节一致，含脚本文件与可执行位（设计 §3 步骤4：
    // 完整目录物化，不能只复制 Markdown）。
    const casDir = join(rig.repoRoot, snapshot.cas_relative_path)
    const manifestJson = JSON.parse(await readFile(join(casDir, 'manifest.json'), 'utf8')) as { digest: string }
    expect(manifestJson.digest).toBe(snapshot.snapshot_sha256)
    const frozenSkillMd = await readFile(join(casDir, 'skills', SKILL_ID, 'SKILL.md'), 'utf8')
    const sourceSkillMd = await readFile(join(rig.skillsRoot, SKILL_ID, 'SKILL.md'), 'utf8')
    expect(frozenSkillMd).toBe(sourceSkillMd)
    const frozenScript = await readFile(join(casDir, 'skills', SKILL_ID, 'scripts', 'run.sh'), 'utf8')
    expect(frozenScript).toBe('#!/bin/sh\necho demo\n')
    const scriptStat = await stat(join(casDir, 'skills', SKILL_ID, 'scripts', 'run.sh'))
    expect((scriptStat.mode & 0o111) !== 0).toBe(true)

    const state = await rig.store.read(rig.changeDirPath)
    expect(state.fields.automation).toBe('paused')

    const window = await rig.ledger.readRunWindow(rig.repoRoot, { limit: 50 })
    expect(window.openReservations).toHaveLength(0)
  }, 20_000)
})

describe('治理竞态 —— 准备期间（无锁解析窗口）loop 的 skill_bundle_id/status 被真实并发修改', () => {
  let rig: Rig
  beforeEach(async () => { rig = await setupRig() })
  afterEach(async () => { await rm(rig.repoRoot, { recursive: true, force: true }) })

  it('准备期间 skill_bundle_id 被并发改到另一个合法 profile → skill-bundle-policy-changed：无 sandbox、不收费、retry-queued，loop 未被额外暂停', async () => {
    const admission = buildAdmission(rig)
    const preparation = buildPreparation(rig, { locator: raceLocator(rig, { skill_bundle_id: 'frontend' }) })
    const report = await runRound(rig, admission, preparation)

    expect(report.ok).toBe(true)
    expect(rig.runCalls).toHaveLength(0) // 无 sandbox：runChange 从未被调用

    const entry = report.entries.find((e) => e.change === rig.change)
    expect(entry?.disposition).toBe('settled')
    expect(entry?.result).toBe('queued')
    expect(entry?.reason).toBe('skill-bundle-policy-changed')

    const { records } = await rig.ledger.read(rig.repoRoot)
    expect(records.some((r) => r.kind === 'skill-bundle-snapshot')).toBe(false)
    const run = records.find((r) => r.kind === 'run')
    expect(run).toBeDefined()
    if (run?.kind === 'run') {
      expect(run.result).toBe('retry-queued')
      expect(run.reason).toBe('skill-bundle-policy-changed')
      expect(run.accounting.charge_source).toBe('none')
      expect(run.accounting.charged_tokens).toBe(0)
    }

    const state = await rig.store.read(rig.changeDirPath)
    expect(state.fields.automation).toBe('queued') // 重排队，不是 paused（并发改策不是错误配置）

    // loop 本身未被本次准备失败额外牵连暂停——它仍 active，只是 skill_bundle_id 已被本测试制造的
    // “外部并发写手”改成 frontend（这是竞态本身的既成事实，不是本轮判定新增的治理动作）。
    const after = loadRegistry(rig.repoRoot, nodeLoopIoStrict)
    const afterLoop = after.data?.loops.find((l) => l.id === rig.loopId)
    expect(afterLoop?.status).toBe('active')
    expect(afterLoop?.skill_bundle_id).toBe('frontend')

    const window = await rig.ledger.readRunWindow(rig.repoRoot, { limit: 50 })
    expect(window.openReservations).toHaveLength(0)
  }, 20_000)

  it('准备期间 loop.status 被并发改成 paused → skill-bundle-policy-changed：无 sandbox、不收费、retry-queued', async () => {
    const admission = buildAdmission(rig)
    const preparation = buildPreparation(rig, { locator: raceLocator(rig, { status: 'paused' }) })
    const report = await runRound(rig, admission, preparation)

    expect(report.ok).toBe(true)
    expect(rig.runCalls).toHaveLength(0)

    const entry = report.entries.find((e) => e.change === rig.change)
    expect(entry?.result).toBe('queued')
    expect(entry?.reason).toBe('skill-bundle-policy-changed')

    const { records } = await rig.ledger.read(rig.repoRoot)
    expect(records.some((r) => r.kind === 'skill-bundle-snapshot')).toBe(false)
    const run = records.find((r) => r.kind === 'run')
    if (run?.kind === 'run') {
      expect(run.accounting.charge_source).toBe('none')
      expect(run.reason).toBe('skill-bundle-policy-changed')
    }

    const state = await rig.store.read(rig.changeDirPath)
    expect(state.fields.automation).toBe('queued')

    const window = await rig.ledger.readRunWindow(rig.repoRoot, { limit: 50 })
    expect(window.openReservations).toHaveLength(0)
  }, 20_000)
})

describe('内容竞态 —— 复制期间 skill 文件被真实并发修改（断言绝不产出混合快照）', () => {
  let rig: Rig
  beforeEach(async () => { rig = await setupRig() })
  afterEach(async () => { await rm(rig.repoRoot, { recursive: true, force: true }) })

  it('两次尝试均遇源内容持续变化 → skill-bundle-source-unstable：CAS 无任何新目录发布、暂存目录不留残余，无 sandbox、不收费、retry-queued', async () => {
    const skillMdPath = join(rig.skillsRoot, SKILL_ID, 'SKILL.md')
    let version = 0
    const materialize = (
      inputs: readonly SkillSnapshotInput[], options: MaterializeSkillSnapshotOptions,
    ): Promise<SkillSnapshotPublishResult> => materializeSkillSnapshot(inputs, {
      ...options,
      onAfterBeforeDigest: async () => {
        version += 1
        // 每次「复制前摘要拍完、真正开始复制前」都真实改写源文件——保证两次尝试的 before/after
        // 摘要恒不一致（真实、确定性的时序，非 mock fs），迫使 materializeSkillSnapshot fail-loud。
        await writeFile(skillMdPath, `# ${SKILL_ID} v${version}\n`, 'utf8')
      },
    })

    const admission = buildAdmission(rig)
    const preparation = buildPreparation(rig, { materialize })
    const report = await runRound(rig, admission, preparation)

    expect(report.ok).toBe(true)
    expect(rig.runCalls).toHaveLength(0)

    const entry = report.entries.find((e) => e.change === rig.change)
    expect(entry?.result).toBe('queued')
    expect(entry?.reason).toBe('skill-bundle-source-unstable')

    const { records } = await rig.ledger.read(rig.repoRoot)
    expect(records.some((r) => r.kind === 'skill-bundle-snapshot')).toBe(false)
    const run = records.find((r) => r.kind === 'run')
    if (run?.kind === 'run') {
      expect(run.accounting.charge_source).toBe('none')
      expect(run.reason).toBe('skill-bundle-source-unstable')
    }

    // 绝不产出混合快照：materializeSkillSnapshot 在稳定性检查失败时于聚合/发布之前就 throw，
    // sha256/ 下没有任何新目录；暂存目录在其自身 finally 里已被清空——两处都真实核验，不只信错误码。
    const shaRoot = join(rig.repoRoot, '.pipeline', 'loops', 'skill-snapshots', 'sha256')
    const published = await readdir(shaRoot).catch(() => [])
    expect(published).toHaveLength(0)
    const stagingRoot = join(rig.repoRoot, '.pipeline', 'loops', 'skill-snapshots', '.tmp')
    const staging = await readdir(stagingRoot).catch(() => [])
    expect(staging).toHaveLength(0)

    const state = await rig.store.read(rig.changeDirPath)
    expect(state.fields.automation).toBe('queued')
  }, 20_000)
})

describe('旧 loops.yaml fixture 回归 —— 缺 skill_bundle_id 字段的历史登记表', () => {
  const LEGACY_LOOP_ID = 'legacyloop'
  const LEGACY_PREFIX = 'legacy-'
  let repoRoot: string
  let store: StateStore
  let ledger: LoopLedgerStore
  let change: string
  let changeDirPath: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'h10-legacy-loops-'))
    // 真历史 loops.yaml：手写文本（而非经 createLoopsYamlText）——刻意逐字对齐 H10 之前的真实登记表
    // 形状：连 autonomy_level/allowlist/denylist/skill_bundle_id 这些字段行都不存在（不是显式 null）。
    const legacyYaml = `version: 1
loops:
  - id: ${LEGACY_LOOP_ID}
    name: Legacy Loop
    kind: orchestrator
    goal: predates H10 skill bundle wiring entirely
    cadence: 1h
    risk: low
    runner: claude-code
    change_prefix: ${LEGACY_PREFIX}
    phases:
      - build
      - verify
    human_gates:
      - verify
    state: docs/state.md
    design_doc: docs/design.md
    status: active
    budget:
      max_runs_per_day: 50
      max_in_flight: 10
      on_exceed: skip
    kill_criteria:
      - no-change-3
`
    await mkdir(join(repoRoot, '.pipeline'), { recursive: true })
    await writeFile(join(repoRoot, '.pipeline', 'loops.yaml'), legacyYaml, 'utf8')

    store = createStateStore()
    change = `${LEGACY_PREFIX}x`
    await store.init({ repoRoot, name: change, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: () => FIXED_CLOCK })
    changeDirPath = changeDir(repoRoot, change)
    await store.set(changeDirPath, 'phase', 'build')
    await markQueued(store, changeDirPath, () => FIXED_CLOCK)

    ledger = createLoopLedgerStore()
  })
  afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }) })

  it('真被 loadRegistry 载入：skill_bundle_id 归一化为 null（unwired，非“空 bundle”也非“默认 bundle”）', async () => {
    const { data, errors } = loadRegistry(repoRoot, nodeLoopIoStrict)
    expect(errors).toEqual([])
    expect(data?.loops.find((l) => l.id === LEGACY_LOOP_ID)?.skill_bundle_id).toBeNull()
  })

  it('对该 loop 真跑一轮：admission 因 unwired fail-closed 拒绝——零 reservation、零 sandbox、change 停在 queued、loop 被真实治理写回 paused', async () => {
    const admission = createLoopAdmission({
      repoRoot, ledger, loadRegistry: (r) => loadRegistry(r, nodeLoopIoStrict), clock: () => FIXED_CLOCK, level: 'L1',
      getAutomation: (c) => getAutomation(store, changeDir(repoRoot, c)),
    })
    // admission 应在 claim 之前就已拒绝——preparation/runChange 若真被调用即是回归，用会抛错的桩
    // 而非真实实现，让任何“意外放行”都在这里就地炸穿，而不是悄悄产出一个看似合理的假结果。
    const preparation: ExecutionPreparationPort = {
      prepare: async () => { throw new Error('unreachable：admission 已 fail-closed 拒绝时不应调用 prepare') },
    }
    const scheduler = createScheduler({
      state: storeWriter(store, (name) => changeDir(repoRoot, name)),
      runChange: async () => { throw new Error('unreachable：admission 已 fail-closed 拒绝时不应创建 sandbox') },
      registerShutdown: () => () => {},
      config: { maxParallel: 4, maxRetries: 1, level: 'L1' },
      admission,
      preparation,
      pauseLoop: (loopId) => pauseLoopReal(repoRoot, loopId),
    })
    const report = await scheduler.runRoundOnce([change])

    expect(report.ok).toBe(true)
    const entry = report.entries.find((e) => e.change === change)
    expect(entry?.disposition).toBe('denied')
    expect(entry?.reason).toBe('skill-bundle-unwired')

    const { records } = await ledger.read(repoRoot)
    expect(records.some((r) => 'loop_id' in r && r.loop_id === LEGACY_LOOP_ID)).toBe(false) // 零 reservation

    const state = await store.read(changeDirPath)
    expect(state.fields.automation).toBe('queued') // 从未 claim；change 本身不受连坐，loop 接线后可自然重试

    const after = loadRegistry(repoRoot, nodeLoopIoStrict)
    const afterLoop = after.data?.loops.find((l) => l.id === LEGACY_LOOP_ID)
    expect(afterLoop?.status).toBe('paused') // 真实治理写回：未接线 loop 被安全暂停
    expect(afterLoop?.skill_bundle_id).toBeNull() // 暂停不等于“顺手补上了 bundle”——本字段仍诚实缺席
  }, 20_000)
})

describe('旧 ledger JSONL fixture 回归 —— 手写历史行与新真实 reserve 在同一账本文件里共存', () => {
  let repoRoot: string
  beforeEach(async () => { repoRoot = await mkdtemp(join(tmpdir(), 'h10-legacy-ledger-')) })
  afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }) })

  it('H10 之前手写的 budget-reservation+run 行（无 skill_bundle_snapshot_sha256、从未出现 skill-bundle-snapshot kind）真实落盘后仍被 createLoopLedgerStore 正确 decode，且不影响另一个全新 loop 的真实 reserve；新旧记录在同一文件里原样共存', async () => {
    const legacyLines = [
      JSON.stringify({
        schema_version: 1, record_id: 'rec-legacy-res-1', recorded_at: '2026-06-01T00:00:00.000Z',
        kind: 'budget-reservation', reservation_id: 'res-legacy-1', attempt_id: 'att-legacy-1',
        loop_id: 'legacy-loop', change: 'legacy-old-1', budget_day: '2026-06-01', reserved_runs: 1,
        reserved_tokens: 1000, token_basis: 'risk-default',
        limits_snapshot: { max_runs_per_day: 6, max_in_flight: 1, on_exceed: 'skip-run' },
        expires_at: '2026-06-01T01:00:00.000Z',
      }),
      JSON.stringify({
        schema_version: 1, record_id: 'rec-legacy-run-1', recorded_at: '2026-06-01T00:10:00.000Z',
        kind: 'run', run_record_id: 'run-legacy-1', attempt_id: 'att-legacy-1', reservation_id: 'res-legacy-1',
        loop_id: 'legacy-loop', change: 'legacy-old-1', level: 'L1', runner: 'claude-code',
        admitted_at: '2026-06-01T00:00:00.000Z', finished_at: '2026-06-01T00:10:00.000Z', result: 'merged',
        usage_record_ids: [], accounting: { reserved_tokens: 1000, charged_tokens: 1000, charge_source: 'reserved-estimate' },
      }),
    ]
    await mkdir(ledgerDirPath(repoRoot), { recursive: true })
    await writeFile(ledgerFilePath(repoRoot), `${legacyLines.join('\n')}\n`, 'utf8')

    const ledger = createLoopLedgerStore()
    const before = await ledger.read(repoRoot)
    expect(before.rejected).toEqual([])
    expect(before.records).toHaveLength(2)
    const legacyRun = before.records.find((r) => r.kind === 'run')
    if (legacyRun?.kind === 'run') {
      expect(legacyRun.skill_bundle_snapshot_sha256).toBeUndefined()
      expect(legacyRun.verification).toBeUndefined()
    }

    // 全新、良好接线的 loop 在同一账本文件旁真实 reserve：不同 loop_id 的预算投影各自独立，
    // 旧行不会被误算进新 loop 的额度，也不会被新写入触碰。
    await seedLoopYaml(repoRoot, { id: 'lp2', changePrefix: 'lp2-', skillBundleId: PROFILE })
    const store = createStateStore()
    const change = 'lp2-y'
    await initAfkChange(store, repoRoot, change)
    await markQueued(store, changeDir(repoRoot, change), () => FIXED_CLOCK)
    const runRepo = createWorkflowRunRepository({
      store, recordStore: createTransitionRecordStore(), clock: () => FIXED_CLOCK,
    })

    const admission = createLoopAdmission({
      repoRoot, ledger, loadRegistry: (r) => loadRegistry(r, nodeLoopIoStrict), clock: () => FIXED_CLOCK, level: 'L1',
      getAutomation: (c) => getAutomation(store, changeDir(repoRoot, c)), isSkillProfileKnown: (id) => id === PROFILE,
      bindAutomationPolicy: (name, policy, binding) =>
        runRepo.bindAutomationPolicy(changeDir(repoRoot, name), policy, binding),
      bindWorkflowActionAuthority: (name, snapshot) =>
        runRepo.bindWorkflowActionAuthority(changeDir(repoRoot, name), snapshot),
      withWorkflowActionAuthorityLock: async (use) => use(TEST_TRACK_REGISTRY),
      workflowActionAuthority: exactWorkflowActionAuthority(store, repoRoot),
    })
    const result = await admission.reserve(change)
    expect(result.ok).toBe(true)

    const after = await ledger.read(repoRoot)
    expect(after.rejected).toEqual([])
    // reserve() 首次为该 change 建立 loop 归属时同时追加 change-loop-binding（最长前缀发现）+
    // budget-reservation 两条，故新增 2 条而非 1 条——只追加，不改写历史（旧两行逐字节原样健在）。
    expect(after.records.length).toBe(before.records.length + 2)
    expect(after.records.slice(0, 2)).toEqual(before.records)
    const newBinding = after.records.find((r) => r.kind === 'change-loop-binding' && r.change === change)
    const newReservation = after.records.find((r) => r.kind === 'budget-reservation' && r.loop_id === 'lp2')
    expect(newBinding).toBeDefined()
    expect(newReservation).toBeDefined()
  }, 20_000)
})

describe('可选真 docker e2e —— 容器真读到冻结 skill 内容；篡改 CAS 后容器不创建/agent 不执行（缺 docker → 诚实 skip）', () => {
  let hasDocker = false
  /**
   * `@tenon/automation` 的 package.json `exports` 指向本地构建产物 `dist/index.js`
   * （gitignore，不入库；见 packages/automation/package.json）——本进程解析到的可能是落后于当前
   * source 的旧构建（尤其在多 agent 并行改动 packages/automation/src/lifecycle 期间）。若
   * `SKILL_BUNDLE_CONTAINER_DIR`/`SkillBundleSnapshotMismatchError` 尚未出现在当前解析到的构建里，
   * 诚实跳过并明确打印原因——绝不用旧构建冒充已验证过当前 source；不在本文件内触发任何构建
   * （刷新 dist 需要 `tsc -b`，越出本任务边界——见任务说明「禁 tsc -b／会撞其他并行 agent 的构建
   * 产物」）。刷新构建后重跑本文件即可自动恢复真跑，无需改动本文件任何一行。
   */
  let hasSkillBundleMountSupport = false
  beforeAll(async () => {
    hasDocker = await dockerAvailable(async (file, args) => nodeExec(file, args))
    if (!hasDocker) {
      console.warn('[HONEST SKIP] docker daemon 不可用（docker info 失败）——H10 skill bundle 容器消费 e2e 跳过，绝不伪绿。')
    }
    hasSkillBundleMountSupport = typeof SKILL_BUNDLE_CONTAINER_DIR === 'string' && typeof SkillBundleSnapshotMismatchError === 'function'
    if (hasDocker && !hasSkillBundleMountSupport) {
      console.warn(
        '[HONEST SKIP] 当前进程解析到的 @tenon/automation 构建（packages/automation/dist，本地 gitignore 产物）'
        + '缺 SKILL_BUNDLE_CONTAINER_DIR/SkillBundleSnapshotMismatchError——落后于最新 lifecycle/ports 源码，尚未经构建刷新。'
        + 'H10 skill bundle 容器消费 e2e 诚实跳过，不拿旧构建冒充已验证；刷新构建（如 `tsc -b`）后重跑本文件即可恢复真跑。',
      )
    }
  })

  let rig: Rig
  beforeEach(async () => {
    if (!hasDocker || !hasSkillBundleMountSupport) return
    rig = await setupRig({ loopId: 'lpd' })
  })
  afterEach(async () => {
    if (hasDocker && hasSkillBundleMountSupport) await rm(rig.repoRoot, { recursive: true, force: true })
  })

  /** 直接调用 admission.reserve()+preparation.prepare()（不经完整 scheduler 轮次）拿到真实
   *  PreparedExecutionContext.skillBundle——本 describe 块聚焦沙箱消费面（task6），不重复上面
   *  已经覆盖过的 claim/activate/settle 编排面。 */
  async function realPreparedSkillBundle(admission: LoopAdmission, preparation: ExecutionPreparationPort) {
    const reserved = await admission.reserve(rig.change)
    if (!reserved.ok) throw new Error(`reserve 意外拒绝：${reserved.reason}`)
    const prepared = await preparation.prepare(reserved.context)
    if (!prepared.ok) throw new Error(`prepare 意外失败：${prepared.reason}`)
    // 判别联合下 skillBundle 只在 preparedKind==='loop-bundle' 分支存在（H10 r1 阻断3/D5）——先显式
    // 判别窄化，不能再靠结构性 `.skillBundle` 读取悄悄放过 non-loop 分支。
    if (prepared.context.preparedKind !== 'loop-bundle') throw new Error('prepare 成功但走了 non-loop 分支（bundle 绑定场景不应发生）')
    return prepared.context.skillBundle
  }

  it('真容器只读挂载真实 CAS 快照：cat 出的内容与源 SKILL.md 逐字节一致，写入被拒（:ro 语义）', async (ctx) => {
    if (!hasDocker || !hasSkillBundleMountSupport) { ctx.skip(); return }
    const skillBundle = await realPreparedSkillBundle(buildAdmission(rig), buildPreparation(rig))

    const ports = createLifecyclePorts({ exec: nodeExec, hostRepoDir: rig.repoRoot, image: 'alpine' })
    const sandbox = await ports.createSandbox({ env: {}, worktreePath: rig.repoRoot, skillBundle })
    try {
      const read = await sandbox.exec(`cat ${SKILL_BUNDLE_CONTAINER_DIR}/skills/${SKILL_ID}/SKILL.md`)
      expect(read.exitCode).toBe(0)
      const sourceContent = await readFile(join(rig.skillsRoot, SKILL_ID, 'SKILL.md'), 'utf8')
      expect(read.stdout).toBe(sourceContent)

      const write = await sandbox.exec(`echo tampered > ${SKILL_BUNDLE_CONTAINER_DIR}/skills/${SKILL_ID}/SKILL.md`)
      expect(write.exitCode).not.toBe(0) // 只读挂载：容器内写入必须失败
    } finally {
      await sandbox.close()
    }
  }, 120_000)

  it('篡改真实 CAS 内容后：host 侧重新核验 hash 失败，createSandbox 拒绝——docker 命令从未被调用（容器不创建，agent 更不会启动）', async (ctx) => {
    if (!hasDocker || !hasSkillBundleMountSupport) { ctx.skip(); return }
    const skillBundle = await realPreparedSkillBundle(buildAdmission(rig), buildPreparation(rig))

    const tamperedPath = join(rig.repoRoot, skillBundle.casRelativePath, 'skills', SKILL_ID, 'SKILL.md')
    await writeFile(tamperedPath, '# TAMPERED\n', 'utf8')

    let execCalls = 0
    const countingExec: ExecFn = (file, args, opts) => { execCalls += 1; return nodeExec(file, args, opts) }
    const ports = createLifecyclePorts({ exec: countingExec, hostRepoDir: rig.repoRoot, image: 'alpine' })

    await expect(ports.createSandbox({ env: {}, worktreePath: rig.repoRoot, skillBundle }))
      .rejects.toMatchObject({ name: 'SkillBundleSnapshotMismatchError' })
    expect(execCalls).toBe(0) // 从未调用 docker——容器不创建，agent 命令没有执行

    // 双重确认：这确实是本文件顶部 import 的同一个错误类（而非同名巧合），_tag 判据与生产代码
    // （scheduler.ts::skillErrorReason 一类归类点）读的是同一个字段。
    await expect(ports.createSandbox({ env: {}, worktreePath: rig.repoRoot, skillBundle }).catch((e: unknown) => {
      expect(e).toBeInstanceOf(SkillBundleSnapshotMismatchError)
      throw e
    })).rejects.toThrow()
  }, 120_000)
})
