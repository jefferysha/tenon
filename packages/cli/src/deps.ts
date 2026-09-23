/**
 * cli 依赖注入面 —— 命令逻辑全部是接受 CliDeps 的纯函数（CONTRACT §4 agent:cli）。
 * store/flow 按 types.ts 契约注入；测试全 mock，绝不 import kernel 实现。
 */
import type { GitFinishProbe } from './gitWorkspace.js'
import type { BoardSnapshotV2, DocumentContractPhase, DocumentEvidenceReport, EffectiveSkillResolver, FlowEngine, GuardContext, HistoryWriter, InteractionEventRecorder, MutationOutcome, PipelineState, ProjectTrackConfig, RegistrySnapshot, SkillTable, StateStore, TrackRegistry, WorkflowRunRepository, WorkflowPipelinePlanV2 } from '@tenon/kernel'
import type { ArtifactSubmissionService, ExecutionRuntimeV2, SkillActionAuthorityResolver } from '@tenon/automation'
import type { AfkReadiness } from './afkReadiness.js'
import type { CodexAuthStatus } from './codexAuth.js'

export type BoundedFileRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }

/** fs/env 探针半成品；cmdCheck 必须再注入 effective policy 才能组成 kernel GuardContext。 */
export type GuardFileContext = Omit<GuardContext, 'coverageProfile'> & {
  /** 先认证普通文件身份和 byte cap，再物化文本；TaskPlan hostile-input 边界不得用 readFile 代替。 */
  readonly readFileBounded?: (path: string, maxBytes: number) => BoundedFileRead
}

export interface GateMarkerInfo {
  kind: 'confirm' | 'review' | 'interaction'
  /** marker 年龄毫秒（now - mtime） */
  ageMs: number
  /** marker 原文（transition 落的三行格式：相位\n指引\nchange 名，老内核同款） */
  raw: string
}

/**
 * doctor 命令的环境/fs 探针面（BACKLOG #26b，全部由 main.ts 落地、测试全 mock）。
 * 探针只回答事实（存在/可执行/版本），绿黄红裁决是 cmdDoctor 的职责。
 */
export interface CodexSkillDiscovery {
  /** Exact native immutable/plugin root selected for this process; absent means static-only mode. */
  readonly selectedRoot?: string
  readonly projectRoot: string
  /** canonical skill id -> SHA-256 hex */
  readonly selected: ReadonlyMap<string, string>
  readonly project: ReadonlyMap<string, string>
}

export type HostPluginInventorySource =
  | { readonly kind: 'native'; readonly host: 'codex' | 'claude'; readonly enabledIds: ReadonlySet<string>; readonly tenonLoadErrors?: readonly string[] }
  | { readonly kind: 'static' }
  | { readonly kind: 'unavailable'; readonly host: 'codex' | 'claude'; readonly detail: string }

export type DoctorProductIdentity =
  | {
      readonly state: 'native'
      readonly expectedVersion: string
      readonly host: 'codex' | 'claude'
      readonly hostPluginVersion: string | null
      readonly hostPluginRoot: string | null
      readonly stableTargetTag: string
      readonly stableTargetCommit: string
      readonly hostTargetExact: boolean
      /**
       * 冻结的 stable tag 是否刚刚向远端复核过。`doctor` 默认只用安装时留下的那份证明（本地健康
       * 检查不该为此联网几十秒），`--verify-release` 才去 GitHub 复核。false = 本次没复核，
       * `hostTargetExact` 只覆盖本地一致性。
       */
      readonly remoteTargetVerified: boolean
      readonly hostPayloadDigest: string | null
      readonly runtimePluginVersion: string
      readonly runtimeReleaseId: string
      readonly runtimePayloadDigest: string
      readonly payloadDigestExact: boolean
      readonly dashboardServerVersion: string | null
      readonly dashboardReleaseId: string | null
    }
  | {
      readonly state: 'unavailable'
      readonly detail: string
      /**
       * 为什么证不出来，分开报。`network` 是链路问题（远端不可达/超时），不是装坏了；
       * `missing-tag` / `mismatch` 才是发布身份本身的问题；`local` 是本机可信命令或 runtime
       * 清单不满足前提。以前全部塌成一句「发布身份探针失败」，附带一条「重跑 setup/update」的
       * 建议——对断网的用户是错的指令。
       */
      readonly cause: 'network' | 'missing-tag' | 'mismatch' | 'local'
      /** 针对 cause 的修复指引（doctor 直接用作 hint）。 */
      readonly remediation: string
    }

export interface DoctorProbes {
  /** process.version 形如 'v22.1.0' */
  nodeVersion: () => string
  /** `git --version` 能跑通（gitHeadSha / build_sha 记录的前提） */
  gitAvailable: () => Promise<boolean>
  /** 插件仓根（hooks/、templates/、tools/ 的定位锚） */
  pluginRoot: string
  /** templates/manifest.yaml 定位+解析试跑：成功 → null，失败 → 错误消息 */
  manifestError: () => string | null
  fileExists: (absPath: string) => boolean
  fileExecutable: (absPath: string) => boolean
  dirExists: (absPath: string) => boolean
  /** 环境变量读取（TENON_AFK 旁路检测用） */
  env: (name: string) => string | undefined
  /** 用户 settings 是否已把 statusline.sh 接入 statusLine */
  statuslineConfigured: () => boolean
  /**
   * 当前已验证 managed runtime 的原生宿主。statusline 是 Claude Code 的可选终端能力，
   * Codex 没有与其等价的接入点；诊断必须以实际发布来源判定是否适用，不能把 Claude
   * 的缺省配置误报给纯 Codex 安装。
   */
  nativeRuntimeHost: () => Promise<'codex' | 'claude' | null>
  /**
   * 正在跑这条命令的宿主（按进程环境判定，与 `tenon test run` 记 `host.kind` 同一口径）。
   * `nativeRuntimeHost` 说的是 runtime 为哪个宿主安装；用后者判定「当前宿主」会在
   * `setup --codex` 的机器上对着 Claude Code 会话讲 Codex 的话、并跳过 Claude 的检查。
   */
  hostKind: () => 'claude-code' | 'codex' | 'terminal'
  /** 本机 Codex CLI 登录态，与 AFK 容器凭证灯分离；不读取或返回凭证内容。 */
  codexAuthStatus: () => Promise<CodexAuthStatus>
  /** 子进程跑 tools/verify-skills.sh；spawn 失败也折算为非 0 code */
  runVerifySkills: () => Promise<{ code: number; output: string }>
  /** 宿主插件、managed runtime 与 Dashboard 必须共同证明同一编译发布身份。 */
  productIdentity: (options?: { readonly verifyRemote?: boolean }) => Promise<DoctorProductIdentity>
  /** tap 流量代理状态（BACKLOG #34e：敏感能力 doctor 明示）。main.ts 注入 @tenon/tap tapStatus */
  tapStatus?: () => { intercepting: boolean; captureEnabled: boolean; message: string }
  /**
   * 本机已安装技能/插件的「能力名」集合（full-install 批2 A1，缺技能检测）。
   * 对齐老仓 pipeline-doctor.sh:121 口径：扫 ~/.claude/skills + ~/.agents/skills 目录名
   * ＋ ~/.claude/plugins/cache 的插件名与其 skills 子目录名 → Set。main.ts 用 readdirSync 落地
   * （fail-safe：缺根目录跳过）；测试注入 fake Set。命名空间 token（superpowers:brainstorming）
   * 判在位时对本集合查 prefix/suffix（见 doctor checkSkills）。
   */
  installedSkillNames: () => ReadonlySet<string>
  /**
   * 当前 Codex 上下文实际可发现的 skill 目录名（原生插件自身 `skills/` + 非原生 adapter 投递的
   * 项目 `.agents/skills`）。它与全局插件 cache 故意分开：cache 在盘上并不意味着 Codex 已加载它。
   * 缺省 undefined 时 doctor 把 Codex 就绪面标为 yellow，而不是把缓存误报为可调用。
   */
  codexProjectSkillNames?: () => ReadonlySet<string>
  /** 明确区分 native inventory、static adapter 与 native inventory 故障。 */
  hostPluginInventory?: () => Promise<HostPluginInventorySource>
  /** Selected-root aware discovery used to diagnose duplicate projections and shadow conflicts. */
  codexSkillDiscovery?: () => Promise<CodexSkillDiscovery>
  /**
   * manifest 强制/推荐 skill 两表（full-install 批2 A1）。main.ts 用 loadManifest(manifestPath())
   * 派生落地（它持有 bundle 里唯一正确的模板路径锚，故两表走探针注入而非 doctor 侧自读——
   * doctor 被打进 dist/tenon.mjs 后 import.meta.url 深度与 src 不同，自读会错锚）；测试 mock fixture。
   * manifest 解析失败 → null，checkSkills 据此出 yellow「无法核技能」而**非**误报 green。
   */
  manifestSkills: () => { mandatory: SkillTable; recommended: SkillTable } | null
  /**
   * AFK 运行时就绪探测（full-install R1）：docker info / image inspect + 两 runner 凭证 set/未设。
   * main.ts 用 probeAfkReadiness 落地（真 execFile docker + readSecrets 注入 secretsEnv + process.env
   * hostEnv + readAutomationJson().image 解析），测试注入 canned AfkReadiness。docker 不可用是常态：
   * 探针返回 available:false（绝不抛），doctor 据此出 afk:docker **yellow**（AFK 为可选能力，非 red）。
   * 值永不回显（只 set+source）。缺省 undefined = 未装配 → afk:* 四检自身折算 red（探针缺口可见）。
   */
  afkReadiness?: () => Promise<AfkReadiness>
  /** skills/sources.yaml + skills/skills.lock.json + last-update.json 的只读视图；清单或锁无效时返回 error。 */
  upstreamSkillView?: () => import('@tenon/kernel').UpstreamSkillView | { error: string }
  /**
   * 该 skill 的 SKILL.md 允不允许宿主代模型调用；`null` = 读不到字节，因而无从证明。
   * 权威来源是字节本身，不是锁：锁是跨版本线格式，塞不进新字段（见 upstream-sources.ts）。
   */
  skillModelInvocable?: (skillId: string) => boolean | null
}

export interface CliIO {
  /** 写一行到 stdout（实现负责补 '\n'） */
  out(line: string): void
  /** 写一行到 stderr（实现负责补 '\n'） */
  err(line: string): void
}

export interface CliDeps {
  /** Production orchestration runner. Kept injectable so command tests never spawn Codex. */
  orchestrationRuntime?: (changeDir: string) => Promise<ExecutionRuntimeV2>
  /** Freeze a fully validated pipeline supplied by the planner/UI boundary. */
  orchestrationFreezePipeline?: (input: { readonly changeDir: string; readonly pipeline: WorkflowPipelinePlanV2 }) => Promise<BoardSnapshotV2>
  /** Unified document/field/runtime submission boundary. The factory is change-scoped so every
   * projection shares one canonical subject namespace and can inject the current phase policy. */
  artifactSubmission?: (input: { readonly changeDir: string; readonly phase?: string; readonly policy?: import('@tenon/kernel').DocumentGovernancePolicy }) => Promise<ArtifactSubmissionService>
  store: StateStore
  flow: FlowEngine
  /**
   * EffectiveSkillResolver（G2 P5）——artifact register 校验具体 producer 的接缝：default 走 manifest
   * mandatory+recommended、custom 走 step.skills（a|b 备选拆 alternatives）。artifact command 只依赖本
   * 接口、不直接读 manifest/registry；装配处（main.ts / harness）使用 registry-aware resolver，
   * 由 track.policyProfile.skills.profile 映射 manifest 表；register 调用面保持不感知 Registry。
   */
  resolver: EffectiveSkillResolver
  /**
   * WorkflowRun 持久化提交接缝（W1 第二增量）：transition 收尾统一走 runRepo.transact，
   * 锁的持有范围覆盖整个 callback（含 commit + breadcrumb/history/marker 兼容投影），堵死
   * 此前锁外副作用可能因并发交错产生的撕裂。cmdTransition 唯一消费方。
   */
  runRepo: WorkflowRunRepository
  /** Optional append-only interaction projection; canonical operations never depend on it. */
  interaction?: InteractionEventRecorder
  /**
   * Canonical review binding verifier. Production adapters always inject the real sidecar reader;
   * unit harnesses may provide an explicit trusted verifier without making projection availability
   * part of authorization.
   */
  reviewGateBinding?: (input: {
    readonly changeDir: string
    readonly state: PipelineState
    readonly phase: string
    readonly event: string
  }) => Promise<boolean>
  /** Explicit machine-readable Skill contract authority; absent means the Skill layer is missing. */
  resolveSkillActionAuthority?: SkillActionAuthorityResolver
  /**
   * OpenSpec evidence reader seam. Omit it in production: kernel/CLI then read the authoritative
   * hash-bound ledger. It exists so command unit tests can isolate rendering and exit-code logic
   * without weakening the production contract.
   */
  documentEvidence?: (
    root: string,
    changeDir: string,
    phase: DocumentContractPhase,
  ) => Promise<DocumentEvidenceReport>
  /**
   * Test evidence reader seam, with the same contract as `documentEvidence`. Omit it in production:
   * CLI and kernel then read the authoritative per-user run records. It exists so command unit
   * tests with a mocked store can isolate rendering and exit codes without a real repository; the
   * real gate is covered end to end by `test-evidence.integration.test.ts`.
   */
  testEvidence?: import('@tenon/kernel').TestEvidenceReader
  /**
   * 载入项目 Track Registry（GOAL.md 清单 T · R2 校验面切换）：缺 `<cwd>/.pipeline/tracks.yaml`
   * → 内建 Track（builtin-only，行为与「没有本功能」逐字一致）；坏文件 fail-loud。装配处
   * （main.ts / integration-harness realDeps）用 loadTrackRegistry(cwd, ctx) 落地，**每次都从盘读、
   * 不跨命令记忆化**（R3 D4：CRUD 后同进程续用陈旧 registry 是真实竞态源）。**只读用途**
   * （tracks list/show 等）走它；需要「与 change 写原子」的组合校验（init/set track|workflow/
   * set-many/cas）改走 withRegistryLock 在 registry 锁内 fresh-load，别用本无锁读。
   */
  loadRegistry: () => TrackRegistry
  /**
   * registry 生命周期锁内 fresh-load 后运行 cb（R3 D4：锁序 registry→change 的**外层锁**）。
   * init/fields 用它先拿 `.pipeline` 仓级锁、锁内新鲜读 registry，再进各自 change 锁做最终
   * {track,workflow} 组合校验/写——关闭「锁外读 registry、之后才写 change」的跨锁 TOCTOU
   * （含 delete 扫描期与 init/set track 竞争）。损坏 tracks.yaml 在锁内 load 处 fail-loud（cb 不跑）。
   * main.ts/harness 用 kernel withTrackRegistryLock 落地；cb 内禁再取同一 registry 锁（非重入）。
   */
  withRegistryLock: <T>(cb: (snap: RegistrySnapshot) => Promise<T>) => Promise<T>
  /**
   * mutate-under-lock（`tenon tracks` CRUD 专用，R3 D4）：`.pipeline` 仓级锁内 read 最新 raw
   * config → cb（锁内构造 next + 引用扫描）→ 完整 next 校验 → 同锁原子写。不嵌套 writeTrackRegistry、
   * 不隐式 repairCorrupt。main.ts/harness 用 kernel mutateTrackRegistry 落地。
   */
  mutateRegistry: <T>(cb: (snap: RegistrySnapshot) => Promise<{ next: ProjectTrackConfig; result: T }>) => Promise<MutationOutcome<T>>
  /** 项目根：change 定位在 <cwd>/openspec/changes/<name>/ */
  cwd: string
  /** Process environment read boundary; automation transition gates consume TENON_AFK without global reads. */
  env?: (name: string) => string | undefined
  /** Declared identity (`TENON_USER` → user.json → git). Lazy; main.ts resolves once per process. */
  user: () => import('@tenon/kernel').TenonUserResolution
  /**
   * 删除 / 归档 / 取消归档 的唯一实现，与 server 共用同一个 kernel application：原因、拒绝与记录
   * 只在那里决定。缺省 undefined = 未装配，三条子命令直接 exit 1（绝不本地重算一套原因）。
   */
  taskLifecycle?: import('@tenon/kernel').TaskLifecycleApplication
  /** `<configRoot>/user.json`, written by `tenon user set`. */
  userConfigPath: () => string
  /**
   * 资源目录读取面（`tenon resources`）：main.ts 用 kernel loadResourceCatalog 落地，
   * 内建条目在这里按 payload 摘要同步。缺省 undefined = 未装配，命令 exit 1。
   */
  resourceCatalog?: () => Promise<import('@tenon/kernel').ResourceCatalog>
  /**
   * agent 库读取面（`tenon agent`、Change 创建时的冻结）：内建 agent 在这里按 payload 摘要同步。
   * 缺省 undefined = 未装配，创建 Change 时视为空库（工作流引用了 agent 就拒绝创建）。
   */
  agentLibrary?: () => Promise<import('@tenon/kernel').AgentLibrary>
  /**
   * Change 创建后把它引用的 agent 冻结进 `.pipeline-frozen/`；缺省 = kernel ensureAgentFreeze。
   * 只有 mock 掉 store（changeDir 并不真实存在）的单测才覆盖它。
   */
  agentFreeze?: (input: import('@tenon/kernel').AgentFreezeInput) => Promise<unknown>
  /**
   * 本步 agent 阻断的读取面，契约同 documentEvidence / testEvidence：生产不注入，读权威的冻结内容
   * 与运行台账；只有 mock 掉 store 的命令单测用它隔离渲染与退出码，真门禁由 agent.integration.test.ts
   * 端到端覆盖。
   */
  stepAgents?: (input: {
    readonly name: string
    readonly dir: string
    readonly stepId: string
    readonly plan: import('@tenon/kernel').EffectiveWorkflowPlan
    readonly state: import('@tenon/kernel').PipelineState
  }) => Promise<readonly import('@tenon/kernel').AgentBlocker[]>
  /**
   * 上游 hue 的 `scripts/validate.mjs`（`tenon design validate` 用）：path() 返回脚本绝对路径，
   * 技能没装时返回空串；run() 以仓库根为 cwd 执行并返回退出码。缺省 undefined = 未装配，命令 exit 1；
   * 用例注入假实现，永不真的 spawn。
   */
  designValidator?: {
    path: () => string
    run: (script: string, folder: string, cwd: string) => Promise<number>
  }
  /**
   * 立项前置条件：所选分支第一个步骤声明了项目级文档 `role: require` 时，该文档必须先就绪。
   * 返回拒绝原因，null = 可以立项。main.ts 用 kernel designSystemPrecondition 落地；
   * 缺省 undefined = 未装配，立项不做该检查（行为与接线前逐字一致）。
   */
  creationPrecondition?: (input: {
    readonly workflow: string
    readonly track: string
    readonly firstStep: string
    readonly policy?: import('@tenon/kernel').DocumentGovernancePolicy
  }) => Promise<string | null>
  io: CliIO
  /** ISO8601 UTC 注入时钟（CONTRACT §5.6：业务码禁止散落 new Date()） */
  clock: () => string
  /** 枚举 changesRoot 下的活跃 change 目录名（不含 archive 目录）；main.ts 用 fs 实现 */
  listChanges: (changesRoot: string) => Promise<string[]>
  /**
   * 严格枚举 changesRoot 下**所有非 archive 的活跃候选目录名**——与 listChanges 的关键区别：
   * **不做 `.pipeline.yaml` 存在性过滤**（listChanges 会 access 该文件、把缺失/EACCES/半成品目录
   * 剔除出结果）。Track CRUD 的引用扫描（scanActiveChanges）专用：用 listChanges 会让「目录在但
   * .pipeline.yaml 缺失/不可读」的 change 根本不进候选集 → unreadable 恒空 → fail-closed 被绕过误删
   * （codex R3 阻断 D）。本枚举保留全部候选，交由 scanActiveChanges 逐个 store.read 判定可读性
   * （读不了的归 unreadable）。main.ts/harness 用 readdir 落地（只保留目录、排除 archive；缺根 → []）。
   */
  listChangeDirs: (changesRoot: string) => Promise<string[]>
  /**
   * transition 成功后写 openspec/changes/<name>/.breadcrumb（CONTRACT §5.4，
   * hook shim 只 cat 该缓存）。best-effort：失败仅 WARN，不影响已完成的转换。
   */
  writeBreadcrumb?: (changeDir: string, content: string) => Promise<void>
  /** lite 历史 .pipeline-history.jsonl appender（CONTRACT §1）。best-effort。 */
  history?: HistoryWriter
  /**
   * init 成功后把 repoRoot 登记进 Tenon config root 的 projects.json
   * （v5 T2 决策 D：dashboard 项目自动发现）。best-effort：任何注册表故障（损坏/不可写）
   * 只 WARN，绝不影响 init exit 0。main.ts 用 kernel registerProjectRoot 落地。
   */
  registerProject?: (repoRoot: string) => Promise<void>
  /** 读 .pipeline-history.jsonl 原文（缺失 → 空串）。import 幂等哨兵检查用 */
  readHistoryRaw?: (changeDir: string) => Promise<string>
  /** 插件版本（= .claude-plugin/plugin.json 版本；sync 的 cliVersion 真相源）。main.ts 注入 */
  pluginVersion?: string
  /** 读 installed_plugins.json 文本（缺失 → undefined）。sync upgrade-channel 用；kernel 不碰真文件 */
  readInstalledPlugins?: () => Promise<string | undefined>
  /**
   * 读项目根的三门 marker（缺失 → 不出现在数组里）。main.ts 用 fs 实现；
   * 新鲜判定（GATE_FRESH_MS）是 inbox 命令的职责，这里只报原始年龄。
   */
  readGateMarkers?: () => Promise<GateMarkerInfo[]>
  /**
   * v6 T2：Tenon config root 的 secrets.json 读成 env 形状，喂 afk run 的
   * hostEnv 合并（宿主 env 显式非空 > 文件值，沿用 sdk「显式>文件」装配惯例；空串 env 视同缺席，
   * 不吃掉文件值）。best-effort：未注入/读失败 → {}，行为与接线前完全一致（fail-open，不阻断 run）。
   * main.ts 用 resolveRuntimePaths().secretsPath + readSecrets 落地；值不进日志。
   */
  readSecretsEnv?: () => Promise<Record<string, string>>
  /**
   * `git rev-parse HEAD` 的 stdout（trim 后；非 git 仓 → 空串）。
   * 对齐老内核 build-complete 的 `$(git rev-parse HEAD 2>/dev/null || echo "")` 口径：
   * 失败也取 stdout——unborn 仓会捕获到字面 "HEAD"（T6 实测怪癖，oracle parity 需要）。
   */
  gitHeadSha?: () => Promise<string>
  /** 仓库的 git 远端名（`git remote`）；非 git 仓 → []，git 跑不起来 → null。pr_url 的取值闸用它。 */
  gitRemotes?: () => Promise<readonly string[] | null>
  /** 完结提交动作要的 git 事实（gitWorkspace.ts probeGitFinish）；不是 git 仓或 git 跑不起来 → null。 */
  gitFinishProbe?: (change: string) => Promise<GitFinishProbe | null>
  /**
   * in-place build 的内容寻址工作区基线。按 change 名保留调用上下文，防未来基线策略需要排除
   * 当前 change 的控制面；production 由 kernel fingerprintWorkspace 落地。
   */
  workspaceFingerprint?: (changeName: string) => Promise<string>
  /** Trusted Build revision token capture; missing capability fails Build closed. */
  captureBuildRevision?: (isolation: string) => Promise<string>
  /** Physical repository/worktree identity used by the default trust assessor. */
  buildRevisionIdentity?: () => Promise<import('@tenon/kernel').BuildRevisionIdentity | undefined>
  /** Trusted Build revision assessment; missing capability fails Verify closed. */
  assessBuildRevision?: import('@tenon/kernel').TransitionContext['assessBuildRevision']
  /** `tenon review request` 成功后写 versioned <cwd>/.pipeline-pending-review hook 投影。 */
  writeReviewMarker?: (content: string) => Promise<void>
  /** `tenon review acknowledge` 在 canonical approval receipt 成功后移除 hook 投影。 */
  clearReviewMarker?: (change: string, event: string) => Promise<void>
  /**
   * check 命令的 guard 文件面注入（BACKLOG #12 guard 全量校验面）：按 change 名构造
   * GuardFileContext——fileExists/fileNonempty/readFile/dirExists/changeArchived 相对 cwd 解析，
   * changeDirRel=openspec/changes/<name>，automationRunner 读 TENON_AUTOMATION_RUNNER。
   * coverageProfile 不允许由 fs 工厂猜测；cmdCheck 用 requireTrack 的 effective policy 合成。
   */
  guardCtx?: (name: string) => GuardFileContext
  /**
   * `tenon doctor` 健康面探针（BACKLOG #26b）。缺省 undefined = 未装配，
   * doctor 命令直接报错 exit 1（doctor 本身不允许静默降级——它就是降级的观测者）。
   */
  doctor?: DoctorProbes
  /**
   * `-- <command...>` 透传参数（BACKLOG #34-wire，`tenon tap start`用）。main.ts 在调用
   * commander 之前从原始 process.argv 里手工切出，绕开 commander 自身的一个真实 bug：
   * variadic `[args...]` 捕获里的裸 `--`，若前一个 token 是普通位置参数（不以 - 开头），会被
   * commander 静默吞掉；若前一个 token 是形如 `--foo` 的选项样 token 则保留——这是 commander
   * 内部状态机的真实缺陷（已用受控 argv 数组穷举验证），不是本项目误用。缺省 undefined = 无
   * `--` 透传段。
   */
  passthroughArgv?: string[]
  /**
   * H10 §1/§8任务7：skill bundle profile（`skill_bundle_id`）存在性语义校验器——复用 T 线现有
   * profile 校验器（`tracks/validate.ts::profileOk` 消费的同一份 `TrackValidationContext.
   * skillProfiles` 集合：BUILTIN_TRACK_DEFINITIONS 的非 `_all` policy profile ∪ manifest
   * mandatory/recommended 两表已声明的非 `_all` track 键），不另造正则/枚举、不重新解析 manifest。
   * 装配处（main.ts / integration-harness realDeps）用 `(id) => trackCtx.skillProfiles.has(id)`
   * 落地——与 `loadRegistry`/`withRegistryLock` 共用同一个 trackCtx 构造，零额外 I/O。
   *
   * 消费方：
   *   · afk.ts 的 cmdAfk('run') 装配 `createLoopAdmission({ isSkillProfileKnown })`——具名
   *     （非 `_all`）profile 若本函数返回 false → `skill-bundle-profile-not-found`（admission
   *     拒绝、暂停 loop）；`_all` 恒合法，不调用本函数。
   *   · loop-run.ts 的 `--dry-run` wiring 预览（evaluateSkillBundleWiring，见
   *     loop-admission-view.ts）同样用它判 `invalid` vs 可能 `ready`。
   * 缺省 undefined = 未装配：具名 profile 走 fail-closed（loop-admission.ts 对 admission 路径
   * throw `SkillProfileValidatorUnconfiguredError`；wiring 预览路径判 `invalid`），绝不误判成
   * "profile 确实不存在"这一虚假治理事实。
   */
  isSkillProfileKnown?: (profileId: string) => boolean
}

/** 统一错误消息提取（避免各命令散落 String(e) 口径） */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
