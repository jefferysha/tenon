/**
 * transition 域 —— 看板写回端点 POST /api/change/<name>/transition 的转换执行。
 *
 * G1 单一 TransitionApplication 用例（2026-07-17）：CLI（cli/commands/transition.ts）与 server
 * 现在共调同一个 kernel 用例——@tenon/kernel 的 createTransitionApplication。default/
 * custom 双轨分流、前置校验、flow.transition/planStepTransition、副作用、
 * runRepository.transact() 原子提交、breadcrumb→history 收尾，全部下沉进
 * kernel/workflow/transition-application.ts 单一实现（GOAL.md G1 验收目标：消灭 cli/server 两处
 * 复制真相源）。本文件不再自己编排这些步骤，职责收窄为四步 server 接线壳：
 *   1. change 名合法性校验（CHANGE_NAME_RE）+ canonical-or-legacy state 是否存在——kernel 用例的输入契约
 *      假定 change 已确认存在，这两项属于 transition 域之外的纯 HTTP 前置校验，留在本文件。
 *   2. 把 TransitionDeps 的 fs/Git/workspace 原语（fileExists/gitHeadSha/workspaceFingerprint）绑成 TransitionContext。
 *   3. 构造 TransitionCommand（含已绑定 root 的 loadWorkflow 柯里化）并调用
 *      TransitionApplication.execute()。
 *   4. 把 TransitionApplicationResult 精确映射成 HTTP code + JSON body：warnings 里的
 *      projection-write-failed 转译成对应的 stderr WARN 行（best-effort，不影响已成功的
 *      200）。revision rejection 则始终在 commit 前返回 typed 409，不写任何投影。
 * runRepository.transact() 的锁范围覆盖 execute() 整个回调（含 commit + 收尾投影），闭 TOCTOU
 * 的保证不变，只是编排主体从本文件搬进了 kernel 单一实现。
 * 老仓 dashboard 写回 run_transition 是 subprocess 跑 guard+state.sh；lite 走 kernel 直调（真改盘）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  compileWorkflow,
  completedWorkflowSkillsSinceStepEntry,
  createTransitionApplication,
  evaluateSpecMigrationEvidence,
  HISTORY_FILE,
  loadRegistry,
  loadWorkflow,
  nodeLoopIoStrict,
  resolveRequiredSkillSlots,
  stateStorageExistsSync,
  taskPlanTasksThroughPhaseForChange, assessBuildRevisionTrust, createBuildRevisionToken,
  probeBuildRevisionIdentity, readValidatedTransitionHead, safeRevisionHash,
  readReviewGateBinding, reviewGateBindingMatches,
} from '@tenon/kernel'
import type {
  BreadcrumbWriter, EffectiveSkillResolver, FlowEngine, HistoryWriter, StateStore, TrackDefinition,
  TrackPolicyProfile, TransitionApplicationResult, TransitionContext, TransitionRecordStore, WorkflowRunRepository,
} from '@tenon/kernel'
import { enqueueAfterSpecComplete } from '@tenon/automation'

// 事件 → 转移边表：re-export kernel 单一真相源（server/index.ts 对外沿用同名）。
export { TRANSITION_EVENTS, eventEdge } from '@tenon/kernel'
export type { EventEdge } from '@tenon/kernel'
export { readChangeHistory } from './transitionHistory.js'
export type { ChangeHistoryDeps } from './transitionHistory.js'

export interface TransitionDeps {
  store: StateStore
  /**
   * WorkflowRun 持久化提交接缝（W1 第二增量）：transition 收尾统一走 runRepo.transact，
   * 锁的持有范围覆盖整个 callback（含 commit + breadcrumb/history/marker 兼容投影），与
   * cli/commands/transition.ts 共用同一个 kernel 实现，堵死此前锁外副作用可能因并发交错
   * 产生的撕裂。
   */
  runRepo: WorkflowRunRepository
  flow: FlowEngine
  clock: () => string
  /** 相对项目根的文件存在谓词（事件前置校验用；缺省 = 降级跳过文件面，同 lite/GUARD-RULES §7.2）。 */
  fileExists?: (root: string, relPath: string) => boolean
  /** `git rev-parse HEAD`（legacy observation/capture adapter；Verify assessor 缺失时 fail-closed）。 */
  gitHeadSha?: (cwd: string) => Promise<string>
  /** in-place build 的内容寻址工作区基线；缺省时 workspace barrier 降级跳过。 */
  workspaceFingerprint?: (cwd: string, changeName: string) => Promise<string>
  captureBuildRevision?: (cwd: string, isolation: string) => Promise<string>
  assessBuildRevision?: import('@tenon/kernel').TransitionContext['assessBuildRevision']
  /**
   * .pipeline-history.jsonl 记账（G20 / v5-T1）：转换成功后追加一行，形状对齐 CLI 侧
   * cli/commands/transition.ts 的既有口径——kind='transition' + raw=触发它的 event 名
   * （「transition-kind 的 raw = event」不变式）。best-effort：写失败仅 WARN 走 stderr，
   * 绝不影响主写已成功的 200（同 server.ts POST /api/changes 的 kind=init 记账语义）。
   * guard/前置校验拒绝的转换在 withLock 内即抛错，天然零记账。缺省 = 不记账（测试可不注入）。
   */
  history?: HistoryWriter
  /**
   * default/governed custom 的 breadcrumb 收尾。review marker 不属于 transition：相位完成后
   * 由 `tenon review request` 写入 versioned hook projection，避免刚进入 review phase 就锁住
   * 该 phase 的实际工作。best-effort：写失败仅 WARN，不影响主写已成功的 200。
   */
  breadcrumb?: BreadcrumbWriter
  /**
   * HTTP adapter 提供的 effective track policy 解析器。存在时，已提交的 spec-complete 会走
   * automation 的独立 auto-enqueue policy；缺席只用于低层 transition 单测，绝不伪造配置。
   */
  resolveTrackPolicy?: (trackId: string) => TrackPolicyProfile
  resolveTrack?: (trackId: string) => TrackDefinition
  skillResolver?: EffectiveSkillResolver
  /** Runtime mode source used by loop human-gate constraints; injected for deterministic tests. */
  env?: (name: string) => string | undefined
}

export interface TransitionOutcome {
  code: number
  body: Record<string, unknown>
}

const CHANGE_NAME_RE = /^[a-zA-Z0-9_-]+$/

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 已核实的既有死代码（BACKLOG 记录在案，非本次改动引入）：函数体内从未 `throw new
 * NotFoundError(...)`——保留这个类与下面的 catch 分支只是保持原样，删除死代码不在这次
 * 迁移范围内，避免节外生枝。 */
class NotFoundError extends Error {}

/**
 * TransitionApplicationResult.kind → HTTP code + JSON body。逐字对齐改动前本文件里
 * PreconditionError/ConflictError/UnknownEventError（本地异常类）与 IllegalTransitionError
 * （kernel 导入、用于 instanceof 分类）四者共同撑起的分类映射——消息模板一个字都没变，只是
 * 判别式从「捕获到哪个异常类」换成了「读 result.kind」（分流判定现在发生在 kernel
 * createTransitionApplication 内部，这里只做纯映射）。
 */
function mapTransitionResult(name: string, event: string, result: TransitionApplicationResult): TransitionOutcome {
  switch (result.kind) {
    case 'applied': {
      // warnings 逐条转译成 stderr WARN 行（best-effort 收尾失败，不影响已经成功的 200）。
      for (const warning of result.warnings) {
        // Legacy ABI signal only: current revision capture never emits it, and server keeps the
        // historical contract of not projecting this deprecated warning.
        if (warning.kind === 'build-sha-missing') continue
        switch (warning.projection) {
          case 'state-yaml':
            process.stderr.write(`WARN: state YAML projection 写入失败（canonical 已提交）: ${errText(warning.cause)}\n`)
            break
          case 'breadcrumb':
            process.stderr.write(`WARN: breadcrumb 写入失败: ${errText(warning.cause)}\n`)
            break
          case 'history':
            process.stderr.write(`WARN: history 写入失败: ${errText(warning.cause)}\n`)
            break
        }
      }
      return { code: 200, body: { ok: true, name, event, from: result.from, to: result.to } }
    }
    case 'unknown-event':
      return { code: 400, body: { ok: false, error: `未知 event: ${result.event}` } }
    case 'event-source-mismatch':
      return {
        code: 409,
        body: {
          ok: false,
          error: `event '${result.event}' 与当前 phase '${result.current}' 不匹配（期望来自 '${result.expected}'）`,
        },
      }
    case 'illegal-transition':
      return { code: 409, body: { ok: false, error: `illegal transition: ${result.from} -> ${result.to}` } }
    case 'precondition-violated':
      return { code: 409, body: { ok: false, error: result.lines[0], detail: result.lines } }
    case 'revision-untrusted':
      return {
        code: 409,
        body: {
          ok: false,
          error: 'Verify build revision is not trustworthy',
          code: result.blocker.code,
          reason: result.blocker.reason,
          remediation: result.blocker.remediation,
          ...(result.blocker.stateHash === undefined ? {} : { stateHash: result.blocker.stateHash }),
          ...(result.blocker.revisionHash === undefined ? {} : { revisionHash: result.blocker.revisionHash }),
        },
      }
    case 'workflow-not-found':
      return {
        code: 409,
        body: {
          ok: false,
          error: `workflow '${result.workflowName}' 未找到（期望 .pipeline/workflows/${result.workflowName}.yaml）`,
        },
      }
    case 'document-governance-invalid':
      return {
        code: 409,
        body: { ok: false, error: result.reason, code: 'document-governance-invalid' },
      }
    case 'step-not-in-graph':
      return { code: 409, body: { ok: false, error: `step '${result.stepId}' 不在 workflow '${result.workflowName}' 里` } }
    case 'event-unsupported':
      return {
        code: 409,
        body: {
          ok: false,
          error: `step '${result.stepId}' 不支持 event '${result.event}'；该 step 支持：${result.available.join(', ') || '(无)'}`,
        },
      }
    case 'step-guard-failed': {
      // server 原有 PreconditionError 的 {error: lines[0], detail: lines} 形状——注意跟 CLI 不
      // 一样：这句没有 "ERROR:" 前缀、没有结尾冒号（CLI 那份是独立的 stderr 文案套路，两边故意
      // 不同，不是需要对齐的疏漏）。
      const lines = [`step '${result.stepId}' guard 未通过`, ...result.failures]
      return { code: 409, body: { ok: false, error: lines[0], detail: lines } }
    }
    case 'step-skills-incomplete': {
      const lines = [`step '${result.stepId}' 尚未完成声明的 skill`, ...result.missing]
      return {
        code: 409,
        body: { ok: false, error: lines[0], detail: lines, code: 'step-skills-incomplete' },
      }
    }
    case 'document-evidence-failed': {
      const lines = [`OpenSpec 文档证据未通过（phase=${result.phase}）`, ...result.blockers]
      return { code: 409, body: { ok: false, error: lines[0], detail: lines, code: 'document-evidence-failed' } }
    }
    case 'review-approval-required':
      return {
        code: 409,
        body: {
          ok: false,
          error: `phase '${result.phase}' 的产物尚未取得人工确认`,
          code: 'review-approval-required',
        },
      }
    case 'constraint-denied':
      return { code: 409, body: { ok: false, error: `automation constraint denied transition: ${result.reason}` } }
  }
}

export async function performTransition(
  deps: TransitionDeps,
  root: string,
  name: string,
  event: string,
): Promise<TransitionOutcome> {
  if (!name || !CHANGE_NAME_RE.test(name) || name.includes('..')) {
    return { code: 400, body: { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' } }
  }
  const dir = join(root, 'openspec', 'changes', name)
  if (!stateStorageExistsSync(dir)) {
    return { code: 404, body: { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' } }
  }
  // kernel 单源注入面：把 server 的 (root,path)/(cwd) 签名绑成已锚定项目根的 TransitionContext。
  const fileExists = deps.fileExists
  const gitHeadSha = deps.gitHeadSha
  const workspaceFingerprint = deps.workspaceFingerprint
  const captureBuildRevision = deps.captureBuildRevision
  const assessBuildRevision = deps.assessBuildRevision
  const ctx: TransitionContext = {
    fileExists: fileExists ? (p: string): boolean => fileExists(root, p) : undefined,
    gitHeadSha: gitHeadSha ? (): Promise<string> => gitHeadSha(root) : undefined,
    workspaceFingerprint: workspaceFingerprint
      ? (): Promise<string> => workspaceFingerprint(root, name)
      : undefined,
    captureBuildRevision: captureBuildRevision
      ? (isolation): Promise<string> => captureBuildRevision(root, isolation)
      : async (isolation): Promise<string> => {
          const identity = await probeBuildRevisionIdentity(root)
          if (!identity) throw new Error('build revision identity unavailable')
          const kind = isolation === 'in-place' ? 'workspace' as const : 'git' as const
          const revision = kind === 'workspace'
            ? await workspaceFingerprint?.(root, name) ?? ''
            : await gitHeadSha?.(root) ?? ''
          return createBuildRevisionToken(kind, revision, identity).value
        },
    assessBuildRevision: assessBuildRevision === undefined
      ? async (request) => {
          const identity = await probeBuildRevisionIdentity(root)
          const observe = async () => {
            const kind = request.isolation === 'in-place' ? 'workspace' as const : 'git' as const
            const revision = kind === 'workspace'
              ? await workspaceFingerprint?.(root, name) ?? ''
              : await gitHeadSha?.(root) ?? ''
            if (!identity) throw new Error('build revision identity unavailable')
            return { kind, revision, identity }
          }
          const provenance = async () => {
            const validated = await readValidatedTransitionHead(dir)
            if (!validated) return undefined
            const { current, record } = validated
            const stateBuildSha = current.state.fields.build_sha
            return {
              currentStep: String(current.state.fields.phase ?? ''),
              stateHash: safeRevisionHash(current.state.fields),
              stateBuildSha: Array.isArray(stateBuildSha) ? stateBuildSha.join(',') : stateBuildSha,
              recordTo: record.to,
              buildShaEffects: record.effects
                .filter((effect) => effect.field === 'build_sha')
                .map((effect) => typeof effect.to === 'string' ? effect.to : ''),
            }
          }
          return assessBuildRevisionTrust({ ...request, observe, provenance })
        }
      : assessBuildRevision,
    specMigrationStatus: () => evaluateSpecMigrationEvidence(root, dir, name),
    tasksThroughPhase: (phase) => taskPlanTasksThroughPhaseForChange(dir, phase),
  }
  const app = createTransitionApplication({
    runRepository: deps.runRepo,
    flow: deps.flow,
    clock: deps.clock,
    history: deps.history,
    breadcrumb: deps.breadcrumb,
    resolveTrack: deps.resolveTrack,
    reviewGateBinding: async ({ changeDir, state, phase, event }) => {
      try {
        const binding = await readReviewGateBinding(changeDir)
        return reviewGateBindingMatches(binding, state, phase, event)
      } catch {
        return false
      }
    },
    missingStepSkills: async ({ changeDir: targetDir, stepId, capability }) => {
      const slots = resolveRequiredSkillSlots(deps.skillResolver, capability, stepId)
      let historyRaw = ''
      try {
        historyRaw = await readFile(join(targetDir, HISTORY_FILE), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const completed = completedWorkflowSkillsSinceStepEntry(historyRaw, stepId)
      return slots
        .filter((slot) => !slot.alternatives.some((candidate) => completed.has(candidate)))
        .map((slot) => slot.token)
    },
    resolveConstraintContext: async ({ policy }) => {
      const registry = loadRegistry(root, nodeLoopIoStrict)
      if (registry.data === null) throw new Error(`loops registry 无法校验：${registry.errors.join('；')}`)
      const loop = registry.data.loops.find((candidate) => candidate.id === policy.loop_id)
      // Keep server semantics aligned with the CLI: AFK explicitly disables human-gate
      // satisfaction; the default HITL path remains available without inventing identity.
      const env = deps.env ?? ((name: string) => process.env[name])
      return { active: loop?.status === 'active', humanGateSatisfied: env('TENON_AFK') !== '1' }
    },
  })
  try {
    const result = await app.execute({
      root,
      changeDir: dir,
      changeName: name,
      event,
      context: ctx,
      // loadWorkflow→compileWorkflow：TransitionApplication 收编译产物 WorkflowIR；编译错误
      // （= 基础设施错误）经 execute 抛出，落 performTransition 的 catch → 500（同既有非法 workflow 语义）。
      loadWorkflow: (wfName) => {
        const def = loadWorkflow(root, wfName)
        return def ? compileWorkflow(def) : null
      },
    })
    let autoEnqueue: string | undefined
    if (result.kind === 'applied' && deps.resolveTrackPolicy !== undefined) {
      try {
        const auto = await enqueueAfterSpecComplete({
          repoRoot: root,
          store: deps.store,
          clock: deps.clock,
          resolveTrackPolicy: deps.resolveTrackPolicy,
        }, {
          changeName: name,
          event,
          from: result.from,
          to: result.to,
        })
        autoEnqueue = auto.kind
      } catch (autoError) {
        // 状态迁移已 canonical commit；AFK 后置故障只能警告，绝不能把成功的 transition 回报为 500。
        process.stderr.write(`WARN: ${name} AFK 自动挂队失败（transition 已成功）: ${errText(autoError)}\n`)
      }
    }
    const outcome = mapTransitionResult(name, event, result)
    if (autoEnqueue === undefined) return outcome
    return { ...outcome, body: { ...outcome.body, auto_enqueue: autoEnqueue } }
  } catch (e) {
    if (e instanceof NotFoundError) return { code: 404, body: { ok: false, error: '找不到该 change' } }
    return { code: 500, body: { ok: false, error: errText(e) } }
  }
}
