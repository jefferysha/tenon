/**
 * transition <name> <event> —— 状态机转换（CONTRACT §3，2026-07-06 oracle 实测回写）。
 * stdout：无（`[TRANSITION] name: old -> new` 走 stderr，对齐老内核 green() 落 stderr）；
 * exit：0 成功 / 1 非法转换、未知事件、事件前置校验不满足或其它错误（老内核实测口径）/
 *       2 非 default workflow 的 step guard 未通过。
 *
 * 编排现在整个下沉进 kernel 单一 TransitionApplication 用例（G1 支点，2026-07-17，见
 * packages/kernel/src/workflow/transition-application.ts）——default/custom 双轨分流、
 * runRepo.transact 事务边界、commit、breadcrumb→history→review-marker 收尾，此前 CLI 与
 * server（server/transition.ts）各自实现一份，现在唯一落在 kernel，两边共调同一个用例
 * （GOAL.md G1 验收目标：消灭这两处复制）。本文件现在只是一层薄 adapter：
 *   ① 校验 change 名 + 把 CliDeps 的 fs/git 原语绑成 TransitionContext/TransitionCommand
 *   ② 调 TransitionApplication.execute()
 *   ③ 把 TransitionApplicationResult 的判别式 kind 精确映射成 exit code + stderr 文案
 *      （文案/exit code 逐字对齐重构前的可观测行为，见 transition.test.ts）。
 *
 * 事件表（flow/transition-table.ts）/ 前置校验 + 副作用（flow/default-event-policy.ts 的
 * DefaultEventPolicy typed guard/action，G2 P3 起）仍是 **kernel 单一真相源**（BACKLOG #25b /
 * GOAL B2），cli 与 server 共消费、不再各持镜像——现在连"怎么编排这些消费"本身也统一了，
 * 不只是事件表数据共享。
 *
 * ── BACKLOG #14 盘点表：老仓 state-transition.sh cmd_transition（case 块逐字对位）──
 * | 事件/面           | 老仓行号  | 副作用/校验                                        | lite 落点 |
 * |-------------------|----------|---------------------------------------------------|-----------|
 * | （全事件）        | L72      | .txn 事务锁串行化                                  | runRepo.transact ✓（锁边界现在由 kernel TransitionApplication 持有）|
 * | （全事件）        | L113     | require_phase：当前 phase == 事件 from             | kernel TransitionApplication（planDefaultTransition）✓（本文件收 event-source-mismatch 映射 stderr）|
 * | （全事件）        | L225-226 | phase=to + phase_status（pending/in_progress/done）| kernel flow.transition ✓（相位序泛化）|
 * | （全事件）        | L227     | green [TRANSITION] from → to（stderr）             | 本文件 ✓（lite 用 ASCII "->"，stderr 面 oracle 不比）|
 * | review 出口       | v2       | exact-phase-and-event approval receipt 后才允许离开 review | kernel TransitionApplication（execute 前置）✓ |
 * | （全事件）        | L267     | transitions_history {at,from,to,event}             | history JSONL ✓（event → raw，与 legacy.ts 导入映射同口径；写盘现在也在 kernel 收尾里）|
 * | （全事件）        | L269-300 | lifecycle hooks（manifest pipeline_hooks，ship 受 auto_commit 闸）| 缺 —— 需 kernel/manifest 派生面（BACKLOG #18）+ M2 hooks 接线，本轮不越权 |
 * | explore-complete  | L120-126 | design_doc 非空/非 null/文件存在                   | kernel DefaultEventPolicy guard ✓ |
 * | spec-complete     | L127-138 | track≠pm → plan 非空/非 null/文件存在              | kernel DefaultEventPolicy guard ✓ |
 * | spec-complete     | L231-237 | track 明确授权后 automation 挂起入队               | automation/lifecycle/spec-complete.ts ✓（仅 queued，不启动 runner） |
 * | build-complete    | L144-147 | build_mode/isolation 必须已设                      | kernel DefaultEventPolicy guard ✓ |
 * | build-complete    | current  | validate_enum isolation ∈ {branch,worktree,in-place}| kernel DefaultEventPolicy guard ✓（set 闸外的纵深防线）|
 * | build-complete    | L150-153 | preset=full ∧ build_mode=direct → direct_override=true | kernel DefaultEventPolicy guard ✓ |
 * | build-complete    | L156-161 | build_sha 由 capability 捕获 canonical build:v1 token；能力缺失/非法 → typed revision blocker | kernel DefaultEventPolicy action ✓ |
 * | verify-pass       | L167-172 | verification_report 非空/非 null/文件存在          | kernel DefaultEventPolicy guard ✓ |
 * | verify-pass       | L173-176 | branch_status == handled                           | kernel DefaultEventPolicy guard ✓ |
 * | verify-pass       | L179-190 | track≠pm → agent/codex_review_result == pass       | kernel DefaultEventPolicy guard ✓ |
 * | verify-pass       | L192-199 | barrier：build_sha 非空非 null ∧ HEAD 可取 ∧ 不等 → 双行 ERROR 拒 | kernel DefaultEventPolicy guard ✓ |
 * | verify-pass       | L201-204 | verify_result=pass + verified_at=now               | kernel DefaultEventPolicy action ✓ |
 * | verify-fail       | L207-210 | verify_result=fail + build_sha=null + phase_status=in_progress | kernel DefaultEventPolicy action ✓（phase_status 在 flow）|
 * | archived          | L213-217 | archived=true + archived_at=now + phase_status=done | kernel DefaultEventPolicy action ✓（phase_status 在 flow）|
 * | ship-complete     | current  | 主规格迁移 receipt 存在时机器应用结果必须身份/摘要一致 | kernel DefaultEventPolicy guard ✓ |
 * | 其它事件          | L219-221 | 无专属校验（open-complete/自定义相位事件）| kernel default 通行 ✓ |
 * 校验失败 = 任何写盘之前 exit 1（老仓 case 校验先于 cmd_set phase），ERROR 文案逐字对齐。
 * 文件存在性经 deps.guardCtx 注入（main.ts/harness 全量注入 = 真实校验；未注入时仅旧文件面
 * 保持兼容，Verify revision assessor 缺失仍 fail-closed）。
 */
import {
  compileWorkflow, createTransitionApplication,
  loadRegistry, loadWorkflow, nodeLoopIoStrict, requireTrackForRoot,
  readReviewGateBinding, renderAgentBlocker, retiredSkillsChangeMessage,
  reviewGateBindingMatches, ownerRequiredMessage,
  TASK_PLAN_CURRENT_FILE, TASK_PLAN_LIMITS, TASK_PLAN_STATE_DIR,
  taskPlanTasksThroughPhaseForChange,
} from '@tenon/kernel'
import { evaluateSpecMigrationEvidence, type TransitionContext } from '@tenon/kernel'
import { enqueueAfterSpecComplete } from '@tenon/automation'
import { errMsg, type CliDeps } from '../deps.js'
import { refuseArchived } from '../archivedGuard.js'
import { changeDir, isValidChangeName, resolveChangeDir } from '../paths.js'
import { requireActor } from '../userIdentity.js'
import { stepAgentBlockersFor } from '../agentGate.js'
import { missingStepSkillTokens } from '../stepSkillGate.js'
import { testEvidenceContextFor } from '../testEvidenceContext.js'
import { resolveBuildRevisionAssessor } from './buildRevisionAssessor.js'

export async function cmdTransition(deps: CliDeps, name: string, event: string): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  if (await refuseArchived(deps, name)) return 1
  const actor = requireActor(deps)
  if (actor === null) return 1

  const dir = resolveChangeDir(deps.cwd, name)
  const guardContext = deps.guardCtx?.(name)
  const tasksPath = guardContext?.changeDirRel === undefined
    ? undefined
    : `${guardContext.changeDirRel}/tasks.md`
  const canonicalStatePath = guardContext?.changeDirRel === undefined
    ? undefined
    : `${guardContext.changeDirRel}/${TASK_PLAN_STATE_DIR}/${TASK_PLAN_CURRENT_FILE}`
  const tasksByteLimit = canonicalStatePath !== undefined && guardContext?.fileExists?.(canonicalStatePath)
    ? TASK_PLAN_LIMITS.maxRevisionBytes
    : TASK_PLAN_LIMITS.maxLegacyProjectionBytes
  // kernel 单源注入面：文件存在性经 guardCtx（缺省降级跳过文件面）；Git HEAD 与 in-place
  // 内容基线均由 production deps 绑定当前 Change。
  const context: TransitionContext = {
    fileExists: guardContext?.fileExists,
    gitHeadSha: deps.gitHeadSha,
    workspaceFingerprint: deps.workspaceFingerprint
      ? (() => {
          const fingerprint = deps.workspaceFingerprint
          return fingerprint ? fingerprint(name) : Promise.reject(new Error('workspace fingerprint capability unavailable'))
      })
      : undefined,
    captureBuildRevision: deps.captureBuildRevision,
    assessBuildRevision: resolveBuildRevisionAssessor(deps, name, dir),
    specMigrationStatus: () => evaluateSpecMigrationEvidence(deps.cwd, dir, name),
    ...(guardContext === undefined
      ? {}
      : { tasksThroughPhase: async (phase) => {
          const bounded = tasksPath === undefined
            ? undefined
            : guardContext.readFileBounded?.(tasksPath, tasksByteLimit)
          if (bounded?.kind === 'invalid') {
            return { pass: false, failure: `${phase} 出口：tasks.md 不可信或超出预算` }
          }
          return taskPlanTasksThroughPhaseForChange(
            dir,
            phase,
            bounded === undefined ? undefined : bounded.kind === 'ok' ? bounded.text : null,
          )
        } }),
  }

  // breadcrumb 收尾由 TransitionApplication 统一编排；review marker 不再在“进入”时由
  // transition 写入，而由 phase 完成后的 `tenon review request` 专职写入。
  const app = createTransitionApplication({
    runRepository: deps.runRepo,
    interaction: deps.interaction,
    // Canonical review authorization is always bound to the sidecar digest. The interaction
    // projection remains optional and must never decide whether a transition is allowed.
    reviewGateBinding: deps.reviewGateBinding ?? (async ({ changeDir, state, phase, event }) => {
      try {
        const binding = await readReviewGateBinding(changeDir)
        return reviewGateBindingMatches(binding, state, phase, event)
      } catch {
        // A corrupt or unreadable binding must fail closed as a review rejection. The
        // transition adapter maps the false result to the stable review-approval-required
        // exit contract instead of surfacing a verifier I/O error as a generic failure.
        return false
      }
    }),
    flow: deps.flow,
    clock: deps.clock,
    history: deps.history,
    breadcrumb: deps.writeBreadcrumb ? { write: deps.writeBreadcrumb } : undefined,
    documentEvidence: deps.documentEvidence,
    testEvidence: testEvidenceContextFor(deps, name),
    ...(deps.testEvidence === undefined ? {} : { testEvidenceReader: deps.testEvidence }),
    resolveTrack: (trackId) => requireTrackForRoot(deps.loadRegistry(), trackId, deps.cwd),
    stepAgentBlockers: async ({ changeDir: targetDir, stepId, plan, state }) =>
      stepAgentBlockersFor({ deps, name, dir: targetDir, stepId, plan, state }),
    // 与 check / status 的出边投影同一个判定；这里持锁，所以顺带把宿主回执落成 history 证据。
    missingStepSkills: async ({ changeDir: targetDir, stepId, capability }) => missingStepSkillTokens({
      deps, changeDir: targetDir, stepId, capability, recordEvidence: true,
    }),
    resolveConstraintContext: async ({ policy }) => {
      const registry = loadRegistry(deps.cwd, nodeLoopIoStrict)
      if (registry.data === null) throw new Error(`loops registry 无法校验：${registry.errors.join('；')}`)
      const loop = registry.data.loops.find((candidate) => candidate.id === policy.loop_id)
      // TENON_AFK is a mode signal, not human evidence: AFK must deny the human gate. Its absence
      // does not prove a human is at the terminal — any process running as the same OS user can
      // unset it. Only the Dashboard/HTTP entry is categorically denied (see server transition.ts).
      return { active: loop?.status === 'active', humanGateSatisfied: deps.env?.('TENON_AFK') !== '1' }
    },
  })

  try {
    const result = await app.execute({
      root: deps.cwd,
      changeDir: dir,
      changeName: name,
      event,
      actor,
      context,
      // loadWorkflow→compileWorkflow：TransitionApplication 收编译产物 WorkflowIR；编译错误
      // （= 基础设施错误）经 execute 抛出，落本文件 catch → ERROR + exit 1（同 loadWorkflow 既有语义）。
      loadWorkflow: (wfName) => {
        const def = loadWorkflow(deps.cwd, wfName)
        return def ? compileWorkflow(def) : null
      },
    })

    switch (result.kind) {
      case 'applied': {
        for (const w of result.warnings) {
          switch (w.kind) {
            case 'build-sha-missing':
              // Legacy ABI signal retained for old kernel producers only. Current freeze action
              // never emits it: missing/invalid capture is a typed revision rejection.
              deps.io.err('WARN: legacy build-sha-missing signal ignored；当前 runtime 要求重新 Build 捕获 canonical revision token')
              break
            case 'projection-write-failed':
              switch (w.projection) {
                case 'state-yaml':
                  deps.io.err(`WARN: state YAML projection 写入失败（canonical 已提交）: ${errMsg(w.cause)}`)
                  break
                case 'breadcrumb':
                  deps.io.err(`WARN: breadcrumb 写入失败: ${errMsg(w.cause)}`)
                  break
                case 'history':
                  deps.io.err(`WARN: history 写入失败: ${errMsg(w.cause)}`)
                  break
                case 'interaction':
                  deps.io.err(`WARN: ${w.code} interaction projection 写入失败（canonical 已提交）: ${errMsg(w.cause)}`)
                  break
              }
              break
          }
        }
        deps.io.err(`[TRANSITION] ${name}: ${result.from} -> ${result.to}`)
        // TransitionApplication 已完成 canonical commit 后才进入 AFK 后置编排。它严格只认
        // spec-complete/spec→build，且在同一 change lock 内复核仍为 build；因此队列故障绝不
        // 回滚已经真实成功的 workflow transition，也不会劫持普通 frontend/backend Build。
        try {
          const auto = await enqueueAfterSpecComplete({
            repoRoot: deps.cwd,
            store: deps.store,
            clock: deps.clock,
            resolveTrackPolicy: (trackId) => requireTrackForRoot(deps.loadRegistry(), trackId, deps.cwd).policyProfile,
          }, {
            changeName: name,
            event,
            from: result.from,
            to: result.to,
          })
          if (auto.kind === 'queued') {
            deps.io.err(`[AFK] ${name} 已由 spec-complete 自动挂队（automation=queued，默认 L1 report-only）`)
          }
        } catch (autoError) {
          deps.io.err(`WARN: ${name} AFK 自动挂队失败（transition 已成功）: ${errMsg(autoError)}`)
        }
        return 0
      }
      case 'owner-required':
        deps.io.err(`ERROR: ${ownerRequiredMessage(name, result.owner)}`)
        return 1
      case 'unknown-event':
        deps.io.err(`ERROR: 未知 event: ${event}`)
        return 1
      case 'event-source-mismatch':
        deps.io.err(`ERROR: illegal transition: ${result.current} -> ${result.to}`)
        return 1
      case 'illegal-transition':
        deps.io.err(`ERROR: illegal transition: ${result.from} -> ${result.to}`)
        return 1
      case 'precondition-violated':
        for (const line of result.lines) deps.io.err(line)
        return 1
      case 'revision-untrusted':
        deps.io.err([
          `ERROR: ${result.blocker.code} reason=${result.blocker.reason} remediation=${result.blocker.remediation}`,
          ...(result.blocker.stateHash === undefined ? [] : [`  stateHash=${result.blocker.stateHash}`]),
          ...(result.blocker.revisionHash === undefined ? [] : [`  revisionHash=${result.blocker.revisionHash}`]),
        ].join('\n'))
        return 1
      case 'workflow-not-found':
        deps.io.err(
          `ERROR: workflow '${result.workflowName}' 未找到（期望 .pipeline/workflows/${result.workflowName}.yaml）`,
        )
        return 1
      case 'retired-skills':
        deps.io.err(`ERROR: ${retiredSkillsChangeMessage(name, result.skills)}`)
        return 1
      case 'document-governance-invalid':
        deps.io.err(`ERROR: ${result.reason}`)
        return 1
      case 'step-not-in-graph':
        deps.io.err(`ERROR: step '${result.stepId}' 不在 workflow '${result.workflowName}' 里`)
        return 1
      case 'event-unsupported':
        deps.io.err(
          `ERROR: step '${result.stepId}' 不支持 event '${result.event}'；该 step 支持：${result.available.join(', ') || '(无)'}`,
        )
        return 1
      case 'step-guard-failed':
        deps.io.err(`ERROR: step '${result.stepId}' guard 未通过：`)
        for (const line of result.failures) deps.io.err(line)
        return 2
      case 'step-skills-incomplete':
        deps.io.err(`ERROR: step '${result.stepId}' 尚未完成声明的 skill：`)
        for (const skillId of result.missing) deps.io.err(`  - ${skillId}`)
        return 2
      case 'step-agents-incomplete':
        deps.io.err(`ERROR: step '${result.stepId}' 的 agent 未通过：`)
        for (const blocker of result.blockers) deps.io.err(`  - ${renderAgentBlocker(blocker, name)}`)
        return 2
      case 'document-evidence-failed':
        deps.io.err(`ERROR: OpenSpec 文档证据未通过（phase=${result.phase}）：`)
        for (const blocker of result.blockers) deps.io.err(`  - ${blocker}`)
        return 1
      case 'test-evidence-failed':
        deps.io.err(`ERROR: 测试证据未通过（step=${result.stepId}）：`)
        for (const blocker of result.blockers) deps.io.err(`  - ${blocker}`)
        return 1
      case 'review-approval-required':
        deps.io.err(
          `ERROR: phase '${result.phase}' 的 event '${result.event}' 尚未取得人工确认；先运行 ` +
          `tenon review request ${name} --event ${result.event}，` +
          '展示产物并等待用户“确认继续”，再重发本次 transition',
        )
        return 2
      case 'constraint-denied':
        deps.io.err(`ERROR: automation constraint denied transition: ${result.reason}`)
        return 1
    }
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}
