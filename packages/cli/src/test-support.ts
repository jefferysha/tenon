/**
 * 测试基座：StateStore / FlowEngine 的 mock 工厂 + 依赖装配 helper。
 * 只依赖 types 契约（@tenon/kernel 目前仅 re-export types），零 vitest 依赖，
 * 因此可被 tsc 正常编译（不进任何运行时路径）。
 */
import {
  compileEffectiveWorkflowPlan,
  createEffectiveSkillResolver,
  FIELD_ORDER,
  IllegalTransitionError,
  LIST_FIELDS,
  loadTrackRegistry,
  PHASES,
  resolveWorkflowName,
  workflowPlanSnapshot,
  DEFAULT_WORKFLOW_SOURCE, parseWorkflow,
} from '@tenon/kernel'
import type { WorkflowDef } from '@tenon/kernel'
import type {
  CommitResult,
  DocumentContractPhase,
  DocumentEvidenceReport,
  EffectiveSkillResolver,
  FieldName,
  GuardContext,
  GuardResult,
  HistoryEntry,
  InitOptions,
  ManifestData,
  Phase,
  PipelineState,
  ProjectTrackConfig,
  SkillTable,
  StateWriteIntent,
  StateWriteResult,
  TrackRegistry,
  TrackValidationContext,
  TransitionRecord,
  TransitionResult,
  WorkflowRun,
  WorkflowRunRepository,
  WorkflowRunTransaction,
} from '@tenon/kernel'
import type { CliDeps, DoctorProbes, GateMarkerInfo, GuardFileContext } from './deps.js'
export {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from '../../kernel/dist/skill-invocation/producer-internal.js'

// === 调用记录 spy（不引 vitest，纯手写） ===

export interface Recorded<A extends unknown[], R> {
  (...args: A): R
  calls: A[]
}

export function spy<A extends unknown[], R>(impl: (...args: A) => R): Recorded<A, R> {
  const calls: A[] = []
  const fn = (...args: A): R => {
    calls.push(args)
    return impl(...args)
  }
  return Object.assign(fn, { calls })
}

// === PipelineState 工厂：37 字段全量、缺省空串 / 空列表 ===

export function mockState(fields: Partial<Record<FieldName, string | string[]>> = {}): PipelineState {
  const all = {} as Record<FieldName, string | string[]>
  for (const f of FIELD_ORDER) {
    // workflow 缺省 'default'——镜像 kernel emptyFields()（Task 4）；否则 mockState 会产出
    // workflow==='' 让每个默认路径单测误入自定义 workflow 分支（'' !== 'default'）。
    // assignee 缺省为 makeDeps 的默认用户，负责人规则下 mock 转换照常放行。
    all[f] = f === 'workflow' ? 'default' : f === 'assignee' ? 'Tester <tester@tenon.test>' : (LIST_FIELDS as readonly string[]).includes(f) ? [] : ''
  }
  return { fields: { ...all, ...fields }, opaqueTail: '' }
}

/**
 * 技能矩阵并入 YAML 之前的 default 定义（只保留无轨道条件的 tenon-* 驱动技能）：manifest a|b 备选、
 * 机器级 mandatory/recommended 表这些 manifest-overlay 机制的单测，用它冻结成 run 快照后仍按旧口径求值。
 */
export function legacyDefaultWorkflowDef(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  // 分支化之前 default 只有一条 pipeline：驱动技能 + spec 的 plan artifact 带 PM 豁免谓词。用 frontend 分支（含其文档契约）还原它。
  const branch = def.tracks?.frontend
  const frontend = branch?.steps ?? def.steps
  return {
    ...def,
    tracks: undefined,
    ...(branch?.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: frontend.map((step) => ({
      ...step,
      skills: step.skills.filter((skill) => skill.id.startsWith('tenon-')),
      ...(step.id === 'spec' && step.artifacts !== undefined
        ? { artifacts: step.artifacts.map((artifact) => artifact.field === 'plan' ? { ...artifact, requiredWhen: { kind: 'track-not-in' as const, values: ['pm'] } } : artifact) }
        : {}),
    })),
  }
}
const LEGACY_DEFAULT_PLAN = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflowDef())
const LEGACY_DEFAULT_PLAN_SNAPSHOT = workflowPlanSnapshot(LEGACY_DEFAULT_PLAN)

/** mockState + 冻结的 legacy default 计划：让 artifact / manifest-overlay 单测沿用 manifest 表语义。 */
export function mockLegacyDefaultState(fields: Partial<Record<FieldName, string | string[]>> = {}): PipelineState {
  return {
    ...mockState(fields),
    runMetadata: {
      runId: 'mock-legacy-run',
      transitionSequence: 0,
      workflowPlanFingerprint: LEGACY_DEFAULT_PLAN.workflowFingerprint,
      workflowPlanSnapshot: LEGACY_DEFAULT_PLAN_SNAPSHOT,
    },
  }
}

// Keep the fixture on the production default Workflow identity while opting its frozen interaction
// policy into AFK. This lets CLI tests exercise the default-track preparation path and still satisfy
// the authoritative WorkflowRun/StepVisit identity binding.
const MOCK_AFK_PLAN = compileEffectiveWorkflowPlan('default', {
  name: 'default',
  interaction: { version: 'v1', mode: 'afk' },
  steps: [{
    id: 'build', label: 'Build', gate: null,
    skills: [], inputs: [], outputs: [], guards: [], transitions: [],
  }],
})
const MOCK_AFK_PLAN_SNAPSHOT = workflowPlanSnapshot(MOCK_AFK_PLAN)

/** A canonical frozen AFK WorkflowRun fixture; bindAutomationPolicy fills its exact loop iteration. */
export function mockAfkState(
  fields: Partial<Record<FieldName, string | string[]>> = {},
): PipelineState {
  return {
    ...mockState({ track: 'backend', workflow: MOCK_AFK_PLAN.id, phase: 'build', ...fields }),
    runMetadata: {
      runId: 'mock-run',
      transitionSequence: 0,
      workflowPlanFingerprint: MOCK_AFK_PLAN.workflowFingerprint,
      workflowPlanSnapshot: MOCK_AFK_PLAN_SNAPSHOT,
    },
  }
}

// === StateStore mock：支持单 state 或 name→state 映射（status/list 多 change 场景） ===

type StateInput = PipelineState | Record<string, PipelineState>

function isSingleState(s: StateInput): s is PipelineState {
  return 'fields' in s && 'opaqueTail' in s
}

export function mockStore(states: StateInput = mockState()) {
  const lookup = (changeDir: string): PipelineState => {
    if (isSingleState(states)) return states
    const name = changeDir.split('/').pop() ?? ''
    const s = states[name]
    if (!s) throw new Error(`ENOENT: 状态文件不存在: ${changeDir}/.pipeline.yaml`)
    return s
  }
  const write = spy(async (
    _changeDir: string, _state: PipelineState, _intent?: StateWriteIntent,
  ): Promise<StateWriteResult> => ({ projection: { status: 'updated' } }))
  return {
    read: spy(async (changeDir: string): Promise<PipelineState> => lookup(changeDir)),
    write,
    // 测试会在运行中替换 `store.write` 做故障注入/时序记录；getter 保证锁内入口始终委托给
    // 当下那一个 spy，同时维持既有 `store.write.calls` 断言的观测契约。
    get writeUnderLock() { return this.write },
    get: spy(
      async (changeDir: string, field: FieldName): Promise<string | string[] | undefined> =>
        lookup(changeDir).fields[field],
    ),
    set: spy(async (_changeDir: string, _field: FieldName, _value: string | string[]): Promise<void> => {}),
    setMany: spy(
      async (_changeDir: string, _kv: Partial<Record<FieldName, string | string[]>>): Promise<void> => {},
    ),
    cas: spy(
      async (_changeDir: string, _field: FieldName, _expect: string, _next: string): Promise<boolean> => true,
    ),
    casMany: spy(
      async (
        _changeDir: string, _field: FieldName, _expects: readonly string[],
        _kv: Partial<Record<FieldName, string | string[]>>,
      ): Promise<boolean> => true,
    ),
    init: spy(
      async (opts: InitOptions): Promise<string> => `${opts.repoRoot}/openspec/changes/${opts.name}`,
    ),
    inspectProjection: spy(async (_changeDir: string) => ({
      status: 'current' as const, revision: 0, revisionId: 'mock-revision',
    })),
    repairProjection: spy(async (_changeDir: string, _opts?: { forceCanonical?: boolean }) => ({
      status: 'current' as const, revision: 0, revisionId: 'mock-revision',
    })),
    importLegacyProjection: spy(async (_changeDir: string): Promise<LegacyImportResult> => ({
      projection: { status: 'updated' }, ignoredProtectedFields: [],
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withLock: spy(async (_changeDir: string, fn: () => Promise<any>): Promise<any> => fn()),
  }
}

export type MockStore = ReturnType<typeof mockStore>

/**
 * WorkflowRunRepository mock（W1 第二增量）：真调 store.withLock/read/write（保持既有
 * `deps.store.withLock.calls`/`deps.store.write.calls` 断言的有效性——mockStore.write 本身
 * 是 no-op spy，不会让 read 反映之前的 write，跟 mockStore 一贯的"固定 lookup + 记调用"
 * 语义保持一致，不新增第二套状态语义）。run/record 的大多数字段值仍是简化占位——commit()
 * 返回值的字段内容不被 cmdTransition 消费，只依赖 commit() 真调用了 store.write。但
 * transact() 内 `run.workflowId` 例外：G1 TransitionApplication（2026-07-17）落地后，
 * kernel 用 `tx.run.workflowId === 'default'` 判定 default/custom 双轨路由（此前 cmdTransition
 * 自己走 resolveWorkflowName(state) 判定，完全不读 tx.run，这份 mock 硬编码 'default' 无害；
 * 现在路由判定权柄转移到 tx.run 上，必须真镜像生产 FsWorkflowRunRepository（见
 * kernel/src/state/workflow-run-repository.ts deriveRun）同样对 state 调 resolveWorkflowName，
 * 否则非 default workflow 的用例会被误判成 default 轨、路由到错误分支）。
 * 直接实现真实 WorkflowRunRepository 类型（不发明并行 mock 形状），确保这份 mock 与生产
 * 接口同步漂移即报错，而不是悄悄型变。
 */
export function mockWorkflowRunRepository(store: MockStore, clock: () => string = () => FIXED_CLOCK): WorkflowRunRepository {
  let sequence = 0
  let automationPolicy: WorkflowRun['automationPolicy']
  let loopId: string | undefined
  let iterationId: string | undefined
  let workflowActionAuthority: WorkflowRun['workflowActionAuthority']
  return {
    initChange: async (opts): Promise<{ changeDir: string; run: WorkflowRun }> => {
      const changeDir = await store.init(opts)
      return {
        changeDir,
        run: {
          id: 'mock-run', workflowId: 'default', currentStep: '', lifecycle: 'active',
          transitionSequence: 0, transitionHead: undefined, createdAt: '', updatedAt: '',
        },
      }
    },
    establishRun: async (changeDir: string): Promise<WorkflowRun> => {
      await store.read(changeDir) // 触发既有 read 断言路径一致；mockStore 的 write 是 no-op spy，
      // establishRun 在 mock 层面只需保证幂等返回值形状正确，不需要真的让后续 read 看到 runMetadata
      // （同 mockStore 一贯"固定 lookup + 记调用"的语义，见文件头部说明）。
      return {
        id: 'mock-run', workflowId: 'default', currentStep: '', lifecycle: 'active',
        transitionSequence: sequence, transitionHead: undefined, createdAt: '', updatedAt: '', automationPolicy,
        policyId: automationPolicy?.policy_id, policyVersion: automationPolicy?.policy_version, loopId, iterationId,
        workflowActionAuthority,
      }
    },
    bindAutomationPolicy: async (changeDir, policy, binding): Promise<WorkflowRun> => {
      const state = await store.read(changeDir)
      if (automationPolicy !== undefined && automationPolicy.policy_version !== policy.policy_version) {
        throw new Error('WorkflowRun policy is immutable')
      }
      automationPolicy = policy
      if (binding !== undefined) {
        if (loopId !== undefined && loopId !== binding.loopId) throw new Error('WorkflowRun loop binding is immutable')
        loopId = binding.loopId
        iterationId = binding.iterationId
      }
      if (state.runMetadata?.workflowPlanSnapshot !== undefined) {
        state.runMetadata.automationPolicy = policy
        state.runMetadata.loopId = loopId
        state.runMetadata.iterationId = iterationId
      }
      return {
        id: state.runMetadata?.runId ?? 'mock-run',
        workflowId: resolveWorkflowName(state), currentStep: '', lifecycle: 'active',
        transitionSequence: sequence, transitionHead: undefined, createdAt: '', updatedAt: '', automationPolicy,
        policyId: policy.policy_id, policyVersion: policy.policy_version, loopId, iterationId,
        workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
        workflowPlanSnapshot: state.runMetadata?.workflowPlanSnapshot,
        workflowActionAuthority,
      }
    },
    bindWorkflowActionAuthority: async (changeDir, snapshot): Promise<WorkflowRun> => {
      const state = await store.read(changeDir)
      workflowActionAuthority = snapshot
      return {
        id: state.runMetadata?.runId ?? 'mock-run',
        workflowId: resolveWorkflowName(state), currentStep: '', lifecycle: 'active',
        transitionSequence: sequence, transitionHead: undefined, createdAt: '', updatedAt: '', automationPolicy,
        policyId: automationPolicy?.policy_id, policyVersion: automationPolicy?.policy_version, loopId, iterationId,
        workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
        workflowPlanSnapshot: state.runMetadata?.workflowPlanSnapshot,
        workflowActionAuthority,
      }
    },
    transact: async <T,>(changeDir: string, fn: (tx: WorkflowRunTransaction) => Promise<T>): Promise<T> =>
      store.withLock(changeDir, async () => {
        const state = await store.read(changeDir)
        let committed = false
        const run: WorkflowRun = {
          id: 'mock-run', workflowId: resolveWorkflowName(state), currentStep: '', lifecycle: 'active',
          transitionSequence: sequence, transitionHead: undefined, createdAt: '', updatedAt: '', automationPolicy,
          policyId: automationPolicy?.policy_id, policyVersion: automationPolicy?.policy_version, loopId, iterationId,
          workflowActionAuthority,
        }
        const tx: WorkflowRunTransaction = {
          run,
          state,
          commit: async (nextFields, draft): Promise<CommitResult> => {
            if (committed) throw new Error('mockWorkflowRunRepository: 一次 transaction 只能提交一次')
            committed = true
            sequence += 1
            const writeResult = await store.writeUnderLock(
              changeDir, { fields: nextFields, opaqueTail: state.opaqueTail },
            )
            const record: TransitionRecord = {
              schemaVersion: 1, id: `mock-record-${sequence}`, runId: 'mock-run', sequence,
              policyId: automationPolicy?.policy_id, policyVersion: automationPolicy?.policy_version,
              loopId, iterationId,
              // 与 run.workflowId 同源（resolveWorkflowName(state)），不再硬编码 'default'——
              // 生产 record.workflowId 就是这么来的，mock 造假数据会让未来检查 result.record 的
              // 测试拿到与 state 矛盾的值（第 1 轮 TransitionApplication review 点名的 fidelity 债）。
              workflowId: run.workflowId, event: draft.event, from: draft.from, to: draft.to,
              effects: [], actor: draft.actor, observedAt: clock(),
            }
            return {
              run: { ...run, transitionSequence: sequence, transitionHead: record.id },
              record,
              projection: writeResult.projection,
            }
          },
        }
        return fn(tx)
      }),
  }
}

// === FlowEngine mock：契约相位图（open→…→archive，build⇄verify，archive 自环） ===

export const TEST_MANIFEST: ManifestData = {
  phases: PHASES,
  transitions: {
    open: ['explore'],
    explore: ['spec'],
    spec: ['build'],
    build: ['verify'],
    verify: ['ship', 'build'],
    ship: ['archive'],
    archive: ['archive'],
  },
  reviewPhases: ['explore', 'spec', 'verify'],
}

function phaseOf(state: PipelineState): Phase {
  const v = state.fields.phase
  return (Array.isArray(v) ? v.join(',') : v) as Phase
}

export function mockFlow(manifest: ManifestData = TEST_MANIFEST) {
  return {
    manifest,
    legalTransitions: spy((phase: Phase): readonly Phase[] => manifest.transitions[phase] ?? []),
    transition: spy((state: PipelineState, to: Phase, clock?: () => string): TransitionResult => {
      const from = phaseOf(state)
      const legal = manifest.transitions[from] ?? []
      if (!legal.includes(to)) throw new IllegalTransitionError(from, to)
      const next: PipelineState = {
        ...state,
        fields: { ...state.fields, phase: to, phase_status: 'pending', updated_at: clock?.() ?? '' },
      }
      return { from, to, state: next }
    }),
    guardCheck: spy((_state: PipelineState, _ctx?: GuardContext): GuardResult => ({ pass: true, failures: [] })),
  }
}

export type MockFlow = ReturnType<typeof mockFlow>

// === EffectiveSkillResolver（G2 P5）：artifact register 单测用缺省 resolver ===

/**
 * artifact register 单测用 manifest skill 表（覆盖 explore/spec/verify × pm/frontend/backend；
 * 含 a|b 备选 token 与 mandatory/recommended 去重）。缺相位（open/build/ship/archive）→ skillsFor 返 []
 * → resolveDefault 空集（正是「空 effective skill 集拒绝」用例的来源）。`as unknown as SkillTable`
 * 与本文件 DEFAULT_MANIFEST_SKILLS 同款（部分表 + skillsFor 对缺键返 []）。
 */
const TEST_MANDATORY_SKILLS = {
  explore: {
    frontend: ['opsx:explore|openspec-explore', 'superpowers:brainstorming', 'grill-with-docs'],
    backend: ['opsx:explore|openspec-explore', 'improve-codebase-architecture'],
  },
  spec: {
    pm: ['opsx:propose|openspec-propose', 'superpowers:brainstorming', 'superpowers:writing-plans', 'grill-with-docs'],
    frontend: ['opsx:propose|openspec-propose', 'superpowers:writing-plans'],
    backend: ['superpowers:writing-plans'],
  },
  verify: {
    frontend: ['superpowers:verification-before-completion'],
    free: ['superpowers:verification-before-completion'],
  },
} as unknown as SkillTable
const TEST_RECOMMENDED_SKILLS = {
  explore: { frontend: ['search-first'] },
} as unknown as SkillTable

/** 缺省 EffectiveSkillResolver（artifact register 单测用）；makeDeps 可经 opts.resolver 覆写注入自定义 resolver。 */
const testEffectiveSkillResolverBase = createEffectiveSkillResolver({
  mandatorySkills: TEST_MANDATORY_SKILLS,
  recommendedSkills: TEST_RECOMMENDED_SKILLS,
})
export const testEffectiveSkillResolver: EffectiveSkillResolver = {
  ...testEffectiveSkillResolverBase,
  // Transition unit tests isolate event/guard mapping. Real mandatory-Skill enforcement is covered
  // by integration tests using the production manifest-backed resolver.
  resolveRequired: () => [],
  resolveDefaultMandatory: () => [],
}

// === DoctorProbes mock：缺省全健康（全绿基线），单测按检查面逐项覆写 ===

/**
 * 缺技能检测缺省 fixture：manifestSkills 两表均取真实 bundled token，故没有宿主级额外安装前置。
 * 缺失态测试应显式注入不在 registry 的自定义 workflow skill，确保 setup 不会掩盖扩展缺口。
 */
const DEFAULT_MANIFEST_SKILLS: { mandatory: SkillTable; recommended: SkillTable } = {
  mandatory: { build: { frontend: ['test-driven-development', 'openspec-propose'] } } as unknown as SkillTable,
  recommended: { build: { frontend: ['search-first'] } } as unknown as SkillTable,
}

export function mockDoctorProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: () => 'v22.5.0',
    gitAvailable: async () => true,
    // Keep the default probe rooted at the checked-out fixture so strict canonical provenance
    // loading exercises the real v3 registry instead of a generic cwd fallback.
    pluginRoot: process.cwd(),
    manifestError: () => null,
    fileExists: () => true,
    fileExecutable: () => true,
    dirExists: () => true,
    env: () => undefined,
    statuslineConfigured: () => true,
    nativeRuntimeHost: async () => 'claude',
    codexAuthStatus: async () => ({ state: 'authenticated' }),
    runVerifySkills: async () => ({ code: 0, output: '[verify-skills] OK' }),
    productIdentity: async () => {
      const releaseId = `sha256-${'a'.repeat(64)}`
      return {
        state: 'native' as const,
        expectedVersion: '1.0.2',
        host: 'claude' as const,
        hostPluginVersion: '1.0.2',
        hostPluginRoot: '/native/tenon',
        stableTargetTag: 'v1.0.2',
        stableTargetCommit: 'a'.repeat(40),
        hostTargetExact: true,
        hostPayloadDigest: 'b'.repeat(64),
        runtimePluginVersion: '1.0.2',
        runtimeReleaseId: releaseId,
        runtimePayloadDigest: 'b'.repeat(64),
        payloadDigestExact: true,
        dashboardServerVersion: '1.0.2',
        dashboardReleaseId: releaseId,
      }
    },
    // 默认 registry 全部 bundled，空的宿主级扫描仍是 packaged workflow 的双绿基线。
    installedSkillNames: () => new Set(),
    // Codex normal-chat 就绪面：缺省 fixture 代表安装器已投递完整 contract skills。
    codexProjectSkillNames: () => new Set([
      'tenon', 'tenon-open', 'tenon-explore', 'tenon-spec', 'tenon-build', 'tenon-verify',
      'tenon-ship', 'tenon-archive', 'openspec-propose', 'openspec-explore', 'openspec-apply-change',
      'openspec-archive-change', 'brainstorming', 'grill-with-docs', 'improve-codebase-architecture',
      'writing-plans', 'test-driven-development', 'verification-before-completion',
      'finishing-a-development-branch', 'browser-qa', 'e2e-testing',
    ]),
    hostPluginInventory: async () => ({ kind: 'native', host: 'claude', enabledIds: new Set(['tenon@tenon']) }),
    manifestSkills: () => DEFAULT_MANIFEST_SKILLS,
    // AFK 就绪四检（R1）：缺省全就绪（docker 可用 / 镜像在位 / 两 runner 凭证已配）→ afk:* 四绿基线；
    // 单测按需覆写 afkReadiness 制造 docker 缺 / 镜像缺 / 凭证缺 各态。
    afkReadiness: async () => ({
      ok: true as const,
      docker: { available: true },
      image: { configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' },
      credentials: {
        'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: true, source: 'host-env' as const } },
        codex: {
          OPENAI_API_KEY: { set: true, source: 'host-env' as const },
          CODEX_HOME: { set: true, source: 'host-env' as const },
        },
      },
    }),
    ...overrides,
  }
}

// === 依赖装配 ===

export interface TestDeps extends CliDeps {
  store: MockStore
  flow: MockFlow
  listChanges: Recorded<[string], Promise<string[]>>
  listChangeDirs: Recorded<[string], Promise<string[]>>
  outLines: string[]
  errLines: string[]
  breadcrumbs: Array<[string, string]>
  historyEntries: Array<[string, HistoryEntry]>
  reviewMarkers: string[]
  /** breadcrumb/history/reviewMarker 三个收尾副作用的真实调用顺序（G1 REFACTOR 回归锚：
   * 曾经把 CLI 原有的 breadcrumb→history→review-marker 顺序悄悄改乱，靠这个数组钉死）。 */
  tailCallOrder: string[]
  /** registerProject 收到的 repoRoot 记录（v5 T2 决策 D：init best-effort 自动登记） */
  registeredRoots: string[]
}

export interface MakeDepsOpts {
  state?: PipelineState
  states?: Record<string, PipelineState>
  /** listChanges 返回值；缺省 = states 的 key 集合（无 states 则空） */
  changes?: string[]
  cwd?: string
  /** readGateMarkers 返回值（inbox 用），缺省空 */
  gateMarkers?: GateMarkerInfo[]
  /** readHistoryRaw 返回值（import 幂等检查用），缺省空串 */
  historyRaw?: string
  /** check 命令 guard 文件面注入（BACKLOG #12），缺省 undefined = lite 纯字段面 */
  guardCtx?: (name: string) => GuardFileContext
  /** doctor 探针覆写（BACKLOG #26b）；缺省全健康 = 全绿基线 */
  doctor?: Partial<DoctorProbes>
  /** EffectiveSkillResolver 覆写（G2 P5 artifact register）；缺省 testEffectiveSkillResolver */
  resolver?: EffectiveSkillResolver
  /** OpenSpec evidence reader 覆写；缺省为已通过的 test double，真实账本语义由 kernel 集成测试覆盖。 */
  documentEvidence?: CliDeps['documentEvidence']
  /** Git HEAD / in-place 工作区基线能力覆写；供 transition/check 的真实 barrier 单测使用。 */
  gitHeadSha?: CliDeps['gitHeadSha']
  workspaceFingerprint?: CliDeps['workspaceFingerprint']
  /** Declared identity; defaults to Tester <tester@tenon.test>. */
  user?: CliDeps['user']
}

export const FIXED_CLOCK = '2026-07-06T00:00:00Z'

export function makeDeps(o: MakeDepsOpts = {}): TestDeps {
  const outLines: string[] = []
  const errLines: string[] = []
  const breadcrumbs: Array<[string, string]> = []
  const historyEntries: Array<[string, HistoryEntry]> = []
  const reviewMarkers: string[] = []
  const tailCallOrder: string[] = []
  const registeredRoots: string[] = []
  const changes = o.changes ?? (o.states ? Object.keys(o.states) : [])
  const store = mockStore(o.states ?? o.state ?? mockState())
  // Track Registry：单测 cwd（缺省 '/repo'，无 .pipeline/tracks.yaml）→ loadTrackRegistry 返回
  // 内建 Track builtin-only，requireTrack/assertWorkflowAllowed 行为与旧写死 TRACKS 校验逐字一致。
  // 上下文里 workflowExists/skillProfiles 只在 tracks.yaml 存在时被 validateTrackRegistry 查——
  // 单测 cwd 无该文件，故取内建 skill profile 集合、workflowExists 恒 default 即可（不被消费）。
  const trackCtx: TrackValidationContext = {
    workflowExists: (id) => id === 'default',
    skillProfiles: new Set(['pm', 'frontend', 'backend']),
  }
  const emptyConfig: ProjectTrackConfig = { version: 1 }
  const deps: TestDeps = {
    store,
    // Mock states intentionally do not materialize the real binding sidecar. Keep this explicit
    // trusted verifier for legacy unit fixtures; tests that exercise production fail-closed
    // behavior remove the property and use cmdTransition's real reader.
    reviewGateBinding: async () => true,
    runRepo: mockWorkflowRunRepository(store),
    // R3：无记忆化（每次 fresh load）。单测 cwd 无 tracks.yaml → 内建 Track，恒新鲜。
    loadRegistry: () => loadTrackRegistry(o.cwd ?? '/repo', trackCtx),
    // registry 锁 mock：无 fs，直接以「当前 deps.loadRegistry() 快照」回调（late-bind——fields/init
    // 测试常覆写 deps.loadRegistry 注入自定义轨，故这里读 deps.loadRegistry 而非构造期捕获）。
    withRegistryLock: async (cb) => cb({ registry: deps.loadRegistry(), config: emptyConfig }),
    // mutate-under-lock 无 mock 语义：tracks CRUD 全走 *.integration.test.ts 真 fs（本 mock 拒调）。
    mutateRegistry: async () => {
      throw new Error('makeDeps mock 未实现 mutateRegistry —— tracks CRUD 请用真 fs 集成测试')
    },
    flow: mockFlow(),
    resolver: o.resolver ?? testEffectiveSkillResolver,
    documentEvidence: o.documentEvidence ?? (async (
      _root: string,
      _changeDir: string,
      phase: DocumentContractPhase,
    ): Promise<DocumentEvidenceReport> => ({
      phase,
      hasLedger: true,
      pass: true,
      blockers: [],
      items: [],
    })),
    cwd: o.cwd ?? '/repo',
    env: () => undefined,
    user: o.user ?? (() => ({ id: 'tester@tenon.test', name: 'Tester', slug: 'tester-at-tenon.test', source: 'env', trust: 'declared' })),
    userConfigPath: () => '/repo/.tenon-test/user.json',
    io: {
      out: (line: string) => outLines.push(line),
      err: (line: string) => errLines.push(line),
    },
    clock: () => FIXED_CLOCK,
    gitHeadSha: o.gitHeadSha,
    workspaceFingerprint: o.workspaceFingerprint,
    listChanges: spy(async (_root: string): Promise<string[]> => changes),
    // 严格候选枚举（Track CRUD 引用扫描专用）。mock 世界里所有 change 都有 state（无「目录在但不可读」态），
    // 故与 listChanges 同返 changes 集；且 tracks CRUD 走真 fs 集成测试（mutateRegistry mock 拒调），本值不被消费。
    listChangeDirs: spy(async (_root: string): Promise<string[]> => changes),
    guardCtx: o.guardCtx,
    doctor: mockDoctorProbes(o.doctor),
    readGateMarkers: async () => o.gateMarkers ?? [],
    readHistoryRaw: async (_dir: string) => o.historyRaw ?? '',
    writeBreadcrumb: async (changeDir: string, content: string) => {
      tailCallOrder.push('breadcrumb')
      breadcrumbs.push([changeDir, content])
    },
    history: {
      append: async (changeDir: string, entry: HistoryEntry) => {
        tailCallOrder.push('history')
        historyEntries.push([changeDir, entry])
      },
    },
    writeReviewMarker: async (content: string) => {
      tailCallOrder.push('reviewMarker')
      reviewMarkers.push(content)
    },
    registerProject: async (repoRoot: string) => {
      registeredRoots.push(repoRoot)
    },
    outLines,
    errLines,
    breadcrumbs,
    historyEntries,
    reviewMarkers,
    tailCallOrder,
    registeredRoots,
  }
  return deps
}
