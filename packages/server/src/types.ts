/**
 * server 契约类型 —— dashboard server 的公共形状。
 * server 是 @tenon/kernel 的消费方（只 import 不改）+ node stdlib http，零第三方运行时依赖。
 */
import type { ArtifactService } from '@tenon/automation'
import type {
  DocumentEvidenceItemStatus,
  DocumentStaleReason,
  FieldName,
  FlowEngine,
  MemFs,
  MemPlatform,
  MemPlatformFilter,
  Phase,
  PipelineTodoProjection,
  ProductPaths,
  ReadinessByTransition,
  StateStore,
  OrchestrationLedger,
  WorkflowAction,
  WorkflowDecompositionPolicyV1,
  WorkflowInteractionPolicyV1,
  WorkflowPermissionDenial,
} from '@tenon/kernel'
import type { TraceStoreReader } from './traces.js'
import type { LoopActivationValidator } from './loops.js'
import type { WorkflowDefinitionStatusResponse } from './workflowDefinitionStatus.js'

/** Tenon 产品自有路径。宿主资产发现由 DashboardServerOptions.hostHome 独立表达。 */
export interface ServerPaths extends ProductPaths {
  /** Tenon state root 下的一次性 token 握手文件（0600）。 */
  tokenPath: string
  /** Tenon state root 下的 pidfile（pid/port/version，B4 版本抢占用）。 */
  pidfilePath: string
}

/** snapshot 里单个 change 的投影（.pipeline.yaml 全字段 + 常读字段提升到顶层）。 */
export interface ChangeSnapshot {
  name: string
  path: string
  phase: string
  phase_status: string
  track: string
  preset: string
  archived: string
  updated_at: string
  fields: Record<FieldName, string | string[]>
  /** `assignee` / `created_by` projected as user refs; legacy values are null. */
  owner: import('@tenon/kernel').UserRef | null
  creator: import('@tenon/kernel').UserRef | null
  /** Exact immutable workflow plan used by this Change. */
  workflowPlanFingerprint: string
  /**
   * Frozen/current workflow diagnostic derived from the same canonical state read as this snapshot.
   * Present on the exact-Change reader; optional on the bulk snapshot for rolling compatibility.
   */
  workflowDefinition?: WorkflowDefinitionStatusResponse
  /** Rules projected from the same immutable plan, never from the current workflow name. */
  workflowRules: WorkflowRulesSnapshot
  /** Change/Track-effective guard projection; intentionally not part of immutable plan identity. */
  workflowExecution: WorkflowExecutionSnapshot
  /** Current canonical exact-event review receipt, projected without authority or host details. */
  reviewHandshake: ReviewHandshakeSnapshot
  /** OpenSpec tasks.md projected onto the workflow stages; omitted only for an older server response. */
  todo?: PipelineTodoProjection
  /** Governed OpenSpec artifact/reader evidence, calculated from the immutable document ledger. */
  documents?: DocumentEvidenceSnapshot
  /** Per-step skill execution state (idle / running / done, grouped by wave) derived from the history log. */
  skillRuns?: SkillRunsSnapshot
  /**
   * Fresh host-hook heartbeat for an explicitly bound terminal session. This is dashboard-only
   * observability, not canonical workflow state; omitted as soon as its short lease expires.
   */
  terminalActivity?: TerminalActivitySnapshot
}

export type SkillRunStatus = 'idle' | 'running' | 'done'

export type SkillRunsSnapshot = ReadonlyArray<{
  readonly stepId: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly status: SkillRunStatus; readonly wave: number }>
}>

export type ReviewHandshakeSnapshot =
  | { status: 'not-requested' }
  | { status: 'pending'; event: string; requestedAt: string }
  | {
      status: 'approved'
      event: string
      requestedAt: string
      acknowledgedAt: string
    }

export interface TerminalActivitySnapshot {
  sessionId: string
  heartbeatAt: string
  expiresAt: string
  turnId?: string
}

export interface DocumentEvidenceSnapshot {
  governed: boolean
  phase?: string
  ledgerPresent?: boolean
  pass?: boolean
  blockers: string[]
  items: Array<{
    kind: string
    status: DocumentEvidenceItemStatus
    reason?: DocumentStaleReason
    requiredRead: boolean
    paths: string[]
    producers: string[]
    timeline: Array<{ producer: string; recordedAt: string; readAt?: string; actor?: { id: string; name: string } }>
  }>
}

export interface WorkflowRulesSnapshot {
  executionModel: 'phase-manifest' | 'step-graph'
  steps: string[]
  transitions: Record<string, Array<{ event: string; to: string }>>
  gateByStep: Record<string, 'review' | 'auto' | null>
  labelByStep: Record<string, string>
  outputsByStep: Record<string, string[]>
  policy: {
    schema: 'workflow-policy/v1'
    configured: WorkflowConfiguredPolicySnapshot
    frozen: {
      workflowFingerprint: string
      decomposition: WorkflowDecompositionPolicyV1
      interaction: WorkflowInteractionPolicyV1
      workflowCeiling: {
        status: 'valid'
        grants: readonly WorkflowAction[]
      }
    }
    effective:
      | { status: 'unavailable'; reason: 'authority-input-unavailable' }
      | {
          status: 'available'
          grants: readonly WorkflowAction[]
          denials: readonly (WorkflowPermissionDenial & { readonly action: WorkflowAction })[]
        }
    drift: {
      status: 'current' | 'changed' | 'missing' | 'invalid' | 'unavailable'
      fingerprintChanged: boolean | null
      policyChanged: boolean | null
    }
  }
}

export type WorkflowConfiguredPolicySnapshot =
  | {
      status: 'available'
      workflowFingerprint: string
      decomposition: WorkflowDecompositionPolicyV1
      interaction: WorkflowInteractionPolicyV1
    }
  | { status: 'missing' | 'invalid' | 'unavailable' }

/** Rolling-upgrade projection consumed only by an already-open pre-v1.0.1 Dashboard. */
export interface LegacyWorkflowRulesSnapshot extends Omit<WorkflowRulesSnapshot, 'executionModel' | 'policy'> {
  nonemptyOutputByStep: Record<string, boolean>
}

export interface WorkflowExecutionSnapshot {
  readinessByTransition: ReadinessByTransition
}

export interface CanonicalStateCompatibilityIssueSnapshot {
  severity: 'blocking'
  kind: 'unsupported-canonical-version'
  change: string
  foundVersion: number
  supportedVersion: number
  action: 'upgrade-runtime'
}

export interface LegacyScopeCompatibilityIssueSnapshot {
  severity: 'warning'
  kind: 'legacy-scope-unmerged'
  change: string
  legacyScopePath: string
  action: 'merge-or-remove-legacy-scope'
}

export interface ProjectRepositoryIdentity {
  id: string
  label: string
  workspace_kind: 'primary' | 'worktree'
}

/** 归档只对查看者生效：同一个 change 在别人的快照里仍在 `changes`。 */
export type ArchivedChangeSnapshot = ChangeSnapshot & {
  archive: { archivedAt: string; phase: string; actor: { id: string; name: string; trust: 'declared' } }
}

/** 单个已注册 Project 的聚合（openspec/changes/* 下所有活跃 change）。 */
export interface ProjectSnapshot {
  root: string
  ok: boolean
  changes: ChangeSnapshot[]
  /** 查看者已归档的 change（从 `changes` 划出，故每个聚合读数自动排除它们）。 */
  archived?: ArchivedChangeSnapshot[]
  /** 未提交删除的 change 数；非 git 仓或 git 失败时缺省。 */
  uncommittedDeletions?: number
  repository?: ProjectRepositoryIdentity
  /** Canonical Changes that this runtime intentionally refuses to decode. */
  compatibilityIssues?: (CanonicalStateCompatibilityIssueSnapshot | LegacyScopeCompatibilityIssueSnapshot)[]
  /** Literal marker: more compatibility issues exist beyond the bounded 100-item response. */
  compatibilityIssuesTruncated?: true
  /** Remove only after the declared rolling compatibility window ends. */
  workflowRules: Record<string, LegacyWorkflowRulesSnapshot>
  error?: string
}

/** GET /api/snapshot 的完整响应体：聚合本机所有注册 Project。 */
export interface Snapshot {
  snapshot_protocol: 'tenon-snapshot/v2'
  version: string
  generated_at: string
  /** 能力声明（GOAL B6 起步）：前端按声明渲染，未接线域不谎报。 */
  capabilities: Record<string, boolean>
  project_count: number
  change_count: number
  projects: ProjectSnapshot[]
}

/** GET /api/health 响应体：轻量存活探针 + 本 server 版本（B4）。 */
export interface HealthInfo {
  ok: boolean
  scope: 'global'
  version: string
  /** Present when the server runs from a managed immutable release payload. */
  releaseId?: string
  /** Opaque identity of the canonical machine-state Home served by this process. */
  stateScopeId?: string
  pid?: number
  /** Managed release transaction owner; absent for an ordinary dashboard process. */
  transactionId?: string
}

export type PreemptDecision = 'bind' | 'reuse' | 'preempt'

export interface Pidfile {
  pid: number
  port: number
  version: string
  started?: number
  transactionId?: string
}

export interface DashboardServerOptions {
  version?: string
  /** Immutable managed-release identity used to refresh a same-semver dashboard safely. */
  releaseId?: string
  /** Managed release transaction owner; absent for ordinary dashboard starts. */
  transactionId?: string
  /**
   * 进程装配层已经解析并冻结的产品路径。注入后 Server 不再解释进程环境或从 home 推导状态目录。
   */
  paths: ServerPaths
  /** 仅用于宿主资产发现；省略时复用 paths.homeDir，绝不进入 ServerPaths 或产品状态解析。 */
  hostHome?: string
  /** 覆盖注册表读取（默认读 registryPath 的 JSON 字符串数组）。 */
  registry?: () => string[]
  /** 覆盖 token（默认启动生成一次性随机 token）。 */
  token?: string
  /** ISO8601 UTC 注入时钟（业务码禁散落 new Date()）。 */
  clock?: () => string
  /** SSE 变更轮询间隔（ms，默认 1000；测试传小值加速）。 */
  pollIntervalMs?: number
  /** SSE 心跳间隔（ms，默认 15000）。 */
  heartbeatMs?: number
  store?: StateStore
  flow?: FlowEngine
  /** flow 未注入时从此 manifest 构造（bin 用；测试通常直接注入 flow）。 */
  manifestPath?: string
  /** `git rev-parse HEAD` 注入（build-complete 冻结 SHA 用；缺省跳过 SHA 面）。 */
  gitHeadSha?: (cwd: string) => Promise<string>
  /** in-place build 的内容寻址工作区基线；生产装配为 kernel fingerprintWorkspace。 */
  workspaceFingerprint?: (cwd: string, changeName: string) => Promise<string>
  /**
   * v6 T3：docker CLI 注入面（GET /api/docker/images 等单机资源探测用；缺省真 execFile docker）。
   * 测试喂 fake（hermetic，不起真 docker）；生产零接线。
   */
  execDocker?: import('./dockerImages.js').ExecDockerFn
  /**
   * dashboard-app 构建产物目录（含 index.html + assets/）。设了则 GET / 服务真 SPA
   * （token 注入进 index.html）+ GET /assets/* 静态供给；未设则回退最小落地页（BACKLOG #26c）。
   */
  webRoot?: string
  /**
   * tap 流量查看器数据源（BACKLOG #34d）：注入 @tenon/tap 的 TraceStore 后保留旧 sessions/
   * records API；仅当 adapter 同时支持 timeline reader 时 capabilities.traffic=true，避免新 Dashboard
   * 对旧 records-only adapter 谎报可用。
   * 结构化注入面（不 import tap，守 server 零第三方 + 构建不耦合）；bin 装配见主会话接线清单。
   */
  traceStore?: TraceStoreReader
  /**
   * v9-I：kernel mem 会话检索的 fs 注入面（GET /api/mem/session-link 用）；缺省由 Server 以
   * 显式 hostHome 构造 nodeMemFs(hostHome)，不重新读取 OS home。测试可注入 fixture adapter。
   */
  memFs?: MemFs
  /**
   * Related-session search application seam. Production leaves this unset and the server
   * adapts the bounded kernel use case; HTTP integration tests can inject a controllable
   * runner to prove concurrency and error mapping without depending on host session formats.
   */
  relatedSessionSearch?: RelatedSessionSearchRunner
  /** H11：starter 激活候选的完整运行接线校验；缺省由 manifest + runner roots 生产装配。 */
  validateLoopActivation?: LoopActivationValidator
  /**
   * H11-H14/G1/G2 Operations 生产 CLI 接缝。缺省执行当前仓已构建的真实
   * `packages/cli/dist/tenon.mjs`；测试注入 fake 只核 HTTP/argv 映射。
   */
  runPipelineCli?: import('./operations.js').PipelineCliRunner
  /**
   * H15：Global server 的真实 finite-cadence 时钟。缺省不启用，避免把嵌入式/测试 server
   * 静默变成执行器；生产 main.ts 显式传入配置。执行仍复用 runPipelineCli。
   */
  cadence?: false | Omit<import('./cadence.js').CadenceSchedulerOptions, 'roots' | 'clock' | 'runPipelineCli'>
  /** Track Router 预览计分器；缺省真执行 `grep -ciE`，测试可注入 hermetic scorer。 */
  scoreRouterPattern?: import('./routerPreview.js').RouterPatternScorer
  /** Canonical v2 orchestration ledger. Production defaults to the filesystem ledger; tests may inject a fake. */
  orchestrationLedger?: OrchestrationLedger
  /** Resolve a repository-scoped artifact service after root-anchor validation; snapshot only checks its scope. */
  artifactServiceForRoot?: (root: string, anchor: import('./workflowRootAnchor.js').WorkflowRootAnchor) => ArtifactService | undefined | Promise<ArtifactService | undefined>
  /** Declared identity for a request root (`''` = aggregate view); defaults to kernel resolveTenonUser with the server env. */
  resolveUser?: (root: string) => import('@tenon/kernel').TenonUserResolution
}

export interface DashboardServer {
  /** 一次性 token（同源前端注入 + 写端点校验的真相源）。 */
  readonly token: string
  readonly version: string
  /** 底层 http.Server（真起真监听，测试用 listen(0) 随机端口）。 */
  readonly httpServer: import('node:http').Server
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>
  close(): Promise<void>
}

export interface RelatedSessionSearchRequest {
  root: string
  query: string
  platform: MemPlatformFilter
}

export interface RelatedSessionSearchMatch {
  platform: MemPlatform
  session_id: string
  title?: string
  updated_at?: string
  score: number
  hit_count: number
  excerpt: string
  descendants_merged: number
}

export interface RelatedSessionSearchResponse {
  protocol: 'tenon-related-session-memory/v1'
  query: string
  platform: MemPlatformFilter
  partial: boolean
  warnings: Array<{ code: string; message: string }>
  matches: RelatedSessionSearchMatch[]
}

export type RelatedSessionSearchRunner = (
  request: RelatedSessionSearchRequest,
) => RelatedSessionSearchResponse | Promise<RelatedSessionSearchResponse>

export type { FieldName, FlowEngine, Phase, StateStore }
