/**
 * 契约类型 —— 与 docs/CONTRACT.md 互为镜像。
 * 字段序/引号/列表语义以老内核 state-init.sh heredoc 为准，改动 = human gate（LOOP.md）。
 */
import type { CoverageProfile, ReviewSeed, TrackId } from './tracks/types.js'
import type { AutomationPolicySnapshot } from './loops/automation-policy.js'
import type { WorkflowPlanSnapshot } from './workflow/effective-plan.js'
/**
 * Review-gate v2 fields are append-only state schema additions. Keeping the group named lets the
 * canonical reader recognise precisely one historical shape written before this feature, without
 * weakening the closed schema for arbitrary missing fields. The YAML compatibility projection
 * omits the entire group while every value is blank, then writes all receipt fields together for a live
 * receipt; canonical state always retains the complete group.
 */
export const REVIEW_GATE_FIELDS = [
  'review_gate_phase',
  'review_gate_status',
  'review_gate_event',
  'review_requested_at',
  'review_acknowledged_at',
  'review_acknowledged_via',
] as const
export type ReviewGateField = (typeof REVIEW_GATE_FIELDS)[number]
export const REVIEW_GATE_FIELD_DEFAULTS: Readonly<Record<ReviewGateField, string>> = {
  review_gate_phase: '',
  review_gate_status: '',
  review_gate_event: '',
  review_requested_at: '',
  review_acknowledged_at: '',
  review_acknowledged_via: 'unknown',
}
export const PRE_VERIFY_REVIEW_FIELD = 'pre_verify_review_result' as const
export const PRE_VERIFY_REVIEW_DEFAULT = 'pending'
export const FIELD_ORDER = [
  'track', 'preset', 'created_by', 'assignee', 'phase', 'phase_status',
  'design_doc', 'plan', 'verification_report', 'build_mode', 'isolation', 'build_sha',
  'agent_review_result', 'codex_review_result', 'verify_result', 'branch_status', 'direct_override',
  'prd_path', 'pr_url',
  'automation', 'automation_queued_at', 'automation_sandbox', 'automation_worktree',
  'automation_attempts', 'automation_last_error', 'automation_preserved_path',
  'branch', 'base_branch', 'scope', 'related_files', 'spec_scope', 'depends_on',
  'created_at', 'updated_at', 'verified_at', 'archived_at', 'archived',
  'workflow',
  // v5 T4（决策 G）：沙箱内当前阶段（automation runner 检出 [TRANSITION] 行运行期回写；run 结算
  // 清空）。host 阶段（phase 字段）在 run 结束后才结算，两者并存不冲突。**新字段必须追加在末尾**
  // （同 workflow 先例）：老版本窄解析器遇到首个未知 key 起整段进 opaqueTail——新字段若插在中段，
  // 老读者会把其后所有真字段（branch/base_branch/workflow…）当不透明尾巴，回写时用缺省值再造一份
  // → 重复 key 静默腐蚀；放末尾则老读者只把这一行当尾巴逐字保留，混版本读写无损。
  'automation_current_phase',
  // F-b（2026-07-13）：失败成因结构化 tag——automation 写入端按 error _tag 干净判定落盘
  // （cancelled/conflict/timeout/verify-fail/agent-exit/no-op，开放集），空串=未知（基础设施类
  // 不写，读取端 fallback regex 分类 automation_last_error 文本）。与 automation_last_error
  // **同写同清**（写点见 automation scheduler/lifecycle/sdk），杜绝「消息换了、成因还是旧的」撕裂。
  // 末尾追加理由同 automation_current_phase（老窄解析器 opaqueTail 腐蚀警告见上）。
  'automation_cause',
  // Review-gate v2：review 是“完成当前相位产出后再由人确认离开”的出口协议，而不是进入
  // explore/spec/verify 时就阻断相位工作。字段一起记录确切 phase、event、状态和两次时间，令
  // transition 能拒绝无确认的离开，同时让 UserPromptSubmit 的确认留在 canonical state 中。event
  // 必须是待离开 phase 的确切出边，不能让 verify-fail 的确认误授权给 verify-pass（反之亦然）。
  // 其中 review_acknowledged_via 是后续追加字段，必须放在整个 FIELD_ORDER 最末尾；否则旧窄解析器会把它后面的真字段误收进 opaqueTail，混版本回写时可能制造重复 key。
  'review_gate_phase', 'review_gate_status', 'review_gate_event', 'review_requested_at', 'review_acknowledged_at',
  // Build→Verify 全量收敛门：新实现 visit 必须重新完成完整 diff/契约/发行门禁审查，不能继承
  // 上一候选的 pass。继续严格末尾追加，使旧窄解析器把这一行及其后的提交元数据原样保留。
  PRE_VERIFY_REVIEW_FIELD,
  'review_acknowledged_via',
] as const
export type FieldName = (typeof FIELD_ORDER)[number]
export const LIST_FIELDS = ['scope', 'related_files', 'spec_scope', 'depends_on'] as const satisfies readonly FieldName[]

export const PHASES = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'] as const
export type Phase = (typeof PHASES)[number]
export const DOCUMENT_PROFILE_IDS = ['legacy-full', 'document-v1'] as const
export type DocumentProfileId = (typeof DOCUMENT_PROFILE_IDS)[number]
export const DOCUMENT_LOCALES = ['zh-CN', 'en'] as const
export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number]

// track 合法性全集不再是 types.ts 的写死常量：运行时权威改由动态 Track Registry 承载
// （GOAL.md 清单 T · R2）。内建 Track 的 id/默认/排序单一真相源在 tracks/builtins.ts 的
// BUILTIN_TRACK_IDS；任意 track id 的运行时校验走 registry 的 requireTrack（应用层校验，
// 见 cli/commands/{fields,init}.ts 与 server POST /api/changes）。故 InitOptions.track
// 收成开放的 TrackId=string——闭集判定挪到 registry，不再由本类型收窄。

/** 门 marker 文件名（项目根），age ≤ GATE_TTL_MS[kind] 视为新鲜（age > TTL 才陈旧，同老内核 fresh()） */
export const GATE_MARKERS = ['.pipeline-pending-confirm', '.pipeline-pending-review', '.pipeline-pending-interaction'] as const

/**
 * 门 marker TTL 分级（BACKLOG #13，对齐老内核 pipeline-gate.sh，勿改回统一值）：
 *   - confirm 300s：正常流程同轮 AskUserQuestion 即清（秒级），300s 只是「漏确认」安全网，
 *     把残留误判的爆炸半径从 30 分钟降到 5 分钟。
 *   - review / interaction 1800s：要跨整个决策 phase（explore/spec/verify 常 >5min），
 *     若缩到 300s 会在 phase 中途被 fresh 判定清掉 → 绕过强制复核。
 * bash 侧镜像：hooks/gate.sh、hooks/statusline.sh（纯 bash 红线，无法 import——改这里必须同步改那边）。
 */
export const GATE_TTL_MS = {
  confirm: 300_000,
  review: 1_800_000,
  interaction: 1_800_000,
} as const satisfies Record<GateKind, number>

export type GateKind = 'confirm' | 'review' | 'interaction'

/** @deprecated BACKLOG #13 起门 TTL 分级（见 GATE_TTL_MS），统一 15min 仅为旧调用面向后兼容保留 */
export const GATE_FRESH_MS = 15 * 60 * 1000

/**
 * AFK 沙箱镜像缺失时的一键构建提示（full-install R1 · P1-X1 防漂移单一真相源）。
 * server `afkReadiness` 与 cli `probeAfkReadiness`/`setup runtime` 同 import 此常量——
 * 镜像不在本机时，就绪面对两侧给出**逐字一致**的构建命令，杜绝两处各写字面串静默分叉。
 */
export const SANDCASTLE_BUILD_HINT = 'bash tools/sandcastle/build.sh'

export interface CredentialLight {
  set: boolean
  source?: 'host-env' | 'secrets-file' | 'default-home'
}

/**
 * CODEX_HOME 认证存在性纯判定：显式配置优先且失败时不偷偷回退默认目录；未显式配置时才检查
 * 默认目录。调用方负责把目录映射到 auth.json 并执行文件可读性检查，本函数不承担任何 I/O。
 */
export function codexHomeCredentialLight(
  explicitCodexHome: string | undefined,
  defaultCodexHome: string | undefined,
  hasReadableAuth: (codexHome: string) => boolean,
): CredentialLight {
  if (explicitCodexHome !== undefined && explicitCodexHome !== '') {
    return hasReadableAuth(explicitCodexHome)
      ? { set: true, source: 'host-env' }
      : { set: false }
  }
  if (defaultCodexHome && hasReadableAuth(defaultCodexHome)) {
    return { set: true, source: 'default-home' }
  }
  return { set: false }
}

/**
 * Codex 宿主认证获取引导的固定命令契约。CLI setup/update/doctor 共用这些字段，避免各入口
 * 复制登录命令并漂移。这里没有、也不得出现任何凭证值；API Key 只通过 stdin 交给 Codex。
 */
export const CODEX_AUTH_GUIDANCE = {
  cli: '安装或更新官方 Codex CLI：`npm install -g @openai/codex`；验证：`codex --version`',
  chatgpt: 'ChatGPT 订阅：如果你的方案包含 Codex，运行 `codex login`（无需另设 API Key）',
  device: '远程或无浏览器环境：运行 `codex login --device-auth`',
  apiKey:
    'Platform API Key：在 https://platform.openai.com/api-keys 创建后，运行 ' +
    '`printenv OPENAI_API_KEY | codex login --with-api-key`（Platform 按用量计费）',
  verify: '验证认证状态：`codex login status`',
} as const

/**
 * 前置条件缺失时的「怎么获取」引导 —— 单一真相源（防漂移，同 SANDCASTLE_BUILD_HINT 先例）。
 * cli `setup runtime` 就绪清单与 `doctor afk:*` 检查、以及（未来）server 同 import 此常量:
 * 缺凭证 / 缺 docker 时不只报「缺」，而是给出**逐字一致**的「怎么拿」下一步，杜绝两处各写字面串
 * 静默分叉。凭证只引导获取路径（可执行命令 / 官方地址），绝不回显任何凭证值（同 secrets 纪律）。
 */
export const PREREQ_HINTS = {
  /** claude-code 凭证 CLAUDE_CODE_OAUTH_TOKEN 缺 —— 生成长期 OAuth token。 */
  claudeToken: '运行 `claude setup-token` 生成长期 OAuth token',
  /** codex 凭证 OPENAI_API_KEY 缺 —— 两条路(ChatGPT 账户登录 / 建 API key)。 */
  openaiKey:
    `${CODEX_AUTH_GUIDANCE.chatgpt}；${CODEX_AUTH_GUIDANCE.apiKey}；${CODEX_AUTH_GUIDANCE.verify}`,
  /** docker daemon 不可用 —— 装 OrbStack 或 Docker Desktop（不自动装，需用户自行安装）。 */
  docker: '装 OrbStack（orbstack.dev，轻量，推荐 macOS）或 Docker Desktop（docker.com）——不自动装，需你自行安装',
} as const

/**
 * .pipeline.yaml 内部提交元数据（W1 第二增量：WorkflowRun 持久化接缝）——不进 FIELD_ORDER，
 * 不可被 `tenon set` 改写。序列化在 FIELD_ORDER 字段之后、opaqueTail 之前；老版本窄解析器
 * 遇到首个未知 key（`pipeline_run_id`）起整段当 opaqueTail 逐字保留，混版本读写无损（同
 * workflow/automation_current_phase 等既有「新字段必须追加在末尾」先例）。
 */
export interface RunMetadata {
  runId: string
  transitionSequence: number
  /** 尚未发生过任何 canonical transition 的新 change 合法地没有 head。 */
  transitionHead?: string
  /** Runtime-merged document governance identity; persisted in a rollback-compatible sidecar. */
  documentProfile?: DocumentProfileId
  /** SHA-256 of the canonical document policy selected at initialization. */
  documentGovernanceFingerprint?: string
  /** SHA-256 of the complete workflow-owned effective plan selected at initialization. */
  workflowPlanFingerprint?: string
  /** Runtime-only immutable plan; persisted in a separate rollback-compatible sidecar. */
  workflowPlanSnapshot?: WorkflowPlanSnapshot
  /** Immutable policy snapshot bound before an autonomous attempt starts. */
  automationPolicy?: AutomationPolicySnapshot
  /** H9 governed identity；两者只在 automationPolicy 已绑定时成对存在。 */
  loopId?: string
  iterationId?: string
}

/** `.pipeline.yaml` adapter 指向的 canonical revision；不属于 WorkflowRun domain state。 */
export interface StateProjectionMetadata {
  stateRevision: number
  stateRevisionId: string
  stateDigest: string
}

export interface PipelineState {
  fields: Record<FieldName, string | string[]>
  /** 缺省 undefined = 尚未升级到 run 身份的老 change（首次经 WorkflowRunRepository.transact
   * 提交时在同一把锁内生成）。 */
  runMetadata?: RunMetadata
  /** 仅 YAML adapter 读写使用；canonical revision 内不存这份派生元数据。 */
  projectionMetadata?: StateProjectionMetadata
  /** 老内核 base64 历史区等未知尾块——读时跳过、写回原样逐字保留 */
  opaqueTail: string
}

export interface InitOptions {
  repoRoot: string
  name: string
  /** registry 已校验的 track id（合法性由调用方经 requireTrack 保证；store.init 只负责落盘，不再收窄闭集）。 */
  track: TrackId
  /** requireTrack 得到的 effective policy 值；StateStore 不按 track id 猜测能力。 */
  reviewSeed: ReviewSeed
  preset: string
  user?: string
  /** 测试注入时钟；业务码禁止散落 new Date() */
  clock?: () => string
  /**
   * W1 第二增量：预生成的 run 身份，随 init 的独占创建（`wx`）一次性写入 .pipeline.yaml，
   * 不是创建后再补一次 write（第五轮 codex review 抓到：两步之间有竞态窗口，且第二步失败会
   * 被调用方吞掉、init 仍报成功，"新 change 身份已钉死"这条保证名不副实）。不提供 → 产出的
   * change 没有 runMetadata（老行为，供不需要 run 身份的调用方/测试用，StateStore 本身不
   * 依赖 WorkflowRunRepository，不自己生成 ID）。
   */
  runId?: string
  /** Presentation locale pinned in a rollback-safe Change sidecar; omitted callers receive the product default. */
  documentLocale?: DocumentLocale
  /**
   * Files that must become visible in the same directory publication as the initial canonical
   * state. Paths are project-internal, relative to the new Change root, and published only after
   * the complete private candidate has been prepared.
   */
  initialFiles?: readonly {
    readonly relativePath: string
    readonly content: string
  }[]
  /**
   * custom workflow 首态覆盖（W1 第二增量收口，第 7 轮 codex review P1）：提供时，init 的独占
   * 创建一次性把 workflow/phase 写成这里给的值，不是先建 default/open 再补一次 setMany——
   * 调用方（CLI cmdInit / server POST /api/changes）已经用 loadWorkflow+firstStep 校验过
   * workflow 存在且非空，这里只负责原子落盘，不重新校验语义合法性。缺省 = default workflow 的
   * open 首态（老行为不变）。
   */
  initialWorkflow?: {
    workflow: string
    phase: string
    /** Custom workflow declared `openspec_contract: required`; initialize its evidence ledger with state. */
    openspecContract?: boolean
    /** Custom workflow declared any versioned document contract; initialize its evidence ledger atomically. */
    documentContract?: boolean
    /** Governance identity pinned beside the run; booleans above remain compatibility assembly hints. */
    documentProfile?: DocumentProfileId
    /** Exact canonical policy identity; omitted only by profile-only runs written by older versions. */
    documentGovernanceFingerprint?: string
    /** Exact workflow graph/Skill/document/review capability identity. */
    workflowPlanFingerprint?: string
    /** Exact immutable execution plan published with the Change. */
    workflowPlanSnapshot?: WorkflowPlanSnapshot
  }
}

/** Canonical state revision 的提交原因；与 workflow transition sequence 分轴计数。 */
export type StateMutationKind =
  | 'init'
  | 'migration'
  | 'replace'
  | 'set'
  | 'set-many'
  | 'cas'
  | 'cas-many'
  | 'automation'
  | 'transition'
  | 'legacy-import'

/** StateStore writer 向 canonical revision 传递的审计关联。 */
export interface StateWriteIntent {
  readonly kind: StateMutationKind
  readonly transitionRecordId?: string
}

export type StateProjectionStatus =
  | { readonly status: 'legacy' }
  | { readonly status: 'current'; readonly revision: number; readonly revisionId: string }
  | { readonly status: 'missing'; readonly revision: number; readonly revisionId: string }
  | { readonly status: 'stale'; readonly revision: number; readonly revisionId: string }
  | { readonly status: 'legacy-compatible'; readonly revision: number; readonly revisionId: string }
  | { readonly status: 'drift'; readonly revision: number; readonly revisionId: string; readonly reason: string }

export interface StateWriteResult {
  readonly projection:
    | { readonly status: 'updated' }
    | { readonly status: 'pending'; readonly error: unknown }
}

export interface RepairProjectionOptions {
  /** 只有用户明确选择 canonical 覆盖未知 drift 时才传 true。 */
  readonly forceCanonical?: boolean
}

export interface StateStore {
  read(changeDir: string): Promise<PipelineState>
  /**
   * 严格按 FIELD_ORDER 全量写回；值命中四闸（": " / " #" / 换行 / 首引号）→ throw。
   * 公开入口自行取得 change 锁，保证 canonical revision/current 发布不会产生同代分叉。
   */
  write(changeDir: string, state: PipelineState, intent?: StateWriteIntent): Promise<StateWriteResult>
  /**
   * 仅供已处于 `withLock(changeDir, ...)` 临界区的组合事务使用；不会重复取得不可重入锁。
   * 锁外调用是调用方 bug；一般消费者必须使用 `write()`。
   */
  writeUnderLock(changeDir: string, state: PipelineState, intent?: StateWriteIntent): Promise<StateWriteResult>
  get(changeDir: string, field: FieldName): Promise<string | string[] | undefined>
  set(changeDir: string, field: FieldName, value: string | string[]): Promise<void>
  setMany(changeDir: string, kv: Partial<Record<FieldName, string | string[]>>): Promise<void>
  /** compare-and-set：当前值 === expect 才写；返回是否写入 */
  cas(changeDir: string, field: FieldName, expect: string, next: string): Promise<boolean>
  /**
   * 多值 compare-and-set：guard 字段命中任一 expect 时，在同一把锁、同一次
   * 原子写中提交整批字段。不命中返回 false 且零写入。
   */
  casMany(
    changeDir: string,
    field: FieldName,
    expects: readonly string[],
    kv: Partial<Record<FieldName, string | string[]>>,
  ): Promise<boolean>
  /** 返回创建的 change 目录绝对路径 */
  init(opts: InitOptions): Promise<string>
  /** 只读检查 YAML adapter 与 canonical current 的关系；canonical 损坏会直接抛错。 */
  inspectProjection(changeDir: string): Promise<StateProjectionStatus>
  /** 修复缺失/已知滞后 adapter；未知 drift 默认拒绝，显式 forceCanonical 才覆盖。 */
  repairProjection(changeDir: string, opts?: RepairProjectionOptions): Promise<StateProjectionStatus>
  /** 用户显式选择把 drifted legacy YAML 导入为一条新的 canonical mutation。 */
  importLegacyProjection(changeDir: string): Promise<StateWriteResult>
  /** mkdir 原子锁（含陈锁回收），锁内串行执行 fn */
  withLock<T>(changeDir: string, fn: () => Promise<T>): Promise<T>
}

export interface ManifestData {
  phases: readonly Phase[]
  /** from-phase -> 合法目标（build⇄verify 双向在此表达） */
  transitions: Readonly<Record<Phase, readonly Phase[]>>
  /** 引擎侧真读——构造性修复老内核 state-transition.sh 硬编码欠账 */
  reviewPhases: readonly Phase[]
}

export interface TransitionResult {
  from: Phase
  to: Phase
  state: PipelineState
}

export interface GuardResult {
  pass: boolean
  failures: string[]
  blockers?: readonly import('./workflow/build-revision.js').BuildRevisionBlocker[]
  /**
   * 非阻断告警（BACKLOG #12 加法扩展）：老 guard 的 yellow 提示面
   * （coverage 豁免 / 覆盖阻塞层明细等）。无告警时省略本键（lite 调用面 toEqual 兼容）。
   */
  warnings?: string[]
}

/**
 * guardCheck 的注入依赖（BACKLOG #12 加法扩展，全部可选）。
 * 老 guard 在项目根以 bash 直接摸文件系统；kernel 纯函数化后由 CLI 注入等价原语。
 * 未注入某能力时，依赖该能力的检查静默跳过（guardCheck(state) 退化为 lite 纯字段面，
 * 语义盘点见 packages/kernel/src/flow/GUARD-RULES.md §7.2）。
 * 所有路径参数均为**相对项目根**的相对路径（老 guard 运行于项目根，字段值直接 `[ -f ]`）。
 */
export interface GuardContext {
  /** requireTrack 得到的 effective coverage policy；coverage 不按 state.track 猜测矩阵。 */
  coverageProfile: CoverageProfile
  /**
   * canonical state 存在性。提供时优先于旧 `.pipeline.yaml` fileNonempty 探针；调用方必须实现
   * current-first、仅 current 缺失才兼容 legacy YAML 的选择，不能把损坏 current 降级成 YAML。
   */
  stateExists?: (changeDirRel: string) => boolean
  /** 文件存在（老 guard `[ -f ]`：file_exists / yaml_file_exists 谓词） */
  fileExists?: (relPath: string) => boolean
  /** 文件存在且非空（老 guard file_nonempty：`[ -f ] && [ -s ]`） */
  fileNonempty?: (relPath: string) => boolean
  /** 读文件文本，不存在 → undefined（tasks.md 勾选统计 / design_doc coverage 块解析） */
  readFile?: (relPath: string) => string | undefined
  /** 区分可信 current、无 canonical 的 legacy 与已存在但不可信的 invalid；Markdown 不得自行授信。 */
  canonicalTasksProjectionStatus?: (input: Readonly<{ changeDirRel: string; tasksMarkdown: string }>) => 'current' | 'legacy' | 'invalid'
  /** 目录存在（depends_on 活跃 change 判定：openspec/changes/<dep>） */
  dirExists?: (relPath: string) => boolean
  /** dep 已归档：openspec/changes/archive/*-<dep> 目录存在（老 guard find -name "*-$dep"） */
  changeArchived?: (dep: string) => boolean
  /** Active dependency directories must be judged by their canonical state only. */
  activeChangeArchived?: (dep: string) => boolean
  /** 当前 change 目录相对项目根（openspec/changes/<name>）；change 内产物检查的路径锚点 */
  changeDirRel?: string
  /** TENON_AUTOMATION_RUNNER=1 调度器旁路（build 相位 automation=queued 闸的逃生口） */
  automationRunner?: boolean
}
export interface FlowEngine {
  manifest: ManifestData
  legalTransitions(phase: Phase): readonly Phase[]
  /** 非法转换 → throw IllegalTransitionError（cli 层映射 exit 2） */
  transition(state: PipelineState, to: Phase, clock?: () => string): TransitionResult
  /** ctx 缺省 = lite 纯字段面；注入 GuardContext 后为老 guard 全量校验面（BACKLOG #12 加法） */
  guardCheck(state: PipelineState, ctx?: GuardContext): GuardResult
}

export interface HistoryEntry {
  ts: string
  /**
   * tool/prompt/import 为老仓历史导入扩展（BACKLOG #11，加法、不影响 .pipeline.yaml 兼容）；
   * tool-start = PreToolUse 写下的「技能开始」标记，只供 dashboard 投影 running 态，不是完成证据。
   */
  kind: 'transition' | 'set' | 'init' | 'tool' | 'tool-start' | 'prompt' | 'import'
  field?: string
  from?: string
  to?: string
  by?: string
  /** 导入的原始载荷（工具名+详情 / Q|A / 事件名） */
  raw?: string
  /**
   * 存在 = 这行 JSONL 只是某条 canonical TransitionRecord 的兼容投影（该 change 有 canonical
   * 链时，真相以链上记录为准，这行不重复计入）；缺失 = legacy/import/非 canonical writer
   * 产生的 transition，链存在与否都原样保留（W1 第二增量：history 合并边界从时间戳比较改成
   * 逐条来源标记，见 workflow-run-repository.ts commit() 与 history.ts
   * transitionRecordToHistoryEntry）。
   */
  transitionRecordId?: string
}

export interface HistoryWriter {
  /** append 一行 JSON 到 changeDir/.pipeline-history.jsonl */
  append(changeDir: string, entry: HistoryEntry): Promise<void>
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: Phase, public readonly to: Phase) {
    super(`illegal transition: ${from} -> ${to}`)
  }
}

export class QuoteGateError extends Error {
  constructor(public readonly field: FieldName, public readonly reason: string) {
    super(`quote gate rejected write to ${field}: ${reason}`)
  }
}
