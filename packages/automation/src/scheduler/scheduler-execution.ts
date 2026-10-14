import { type AutomationConfig, type AutomationState, type RunOutcome } from '../types.js'
import type {
  ExecutionContext, ExecutionPreparationPort, PrepareOutcome, PreparationFailureReason, PreparedExecutionContext,
} from '../admission/execution-context.js'
import { consumeIssuedPreparedContext } from '../admission/execution-context.js'
import type {
  ActivateResult, AdmissionDenial, ReserveResult, RunSettlement, WorkflowAuthorityClaimCapabilityV1,
} from '../admission/loop-admission.js'
import { classifyFailure } from './classify.js'
import { createSemaphore } from './semaphore.js'
import { evaluateVerificationGate, isBoundaryVerifiedResult, type VerificationGateResult } from '../verifier/verifier.js'
import { validateVerificationResult } from '@tenon/kernel'
import { certifyLifecycleOutcome, isCertifiedLifecycleOutcome } from '../lifecycle/outcome.js'
import { isSettled } from '../queue/claim.js'
import { settleSuccess } from '../queue/state-machine.js'

import {
  ExecutionWiringValidatorUnconfiguredError,
  canonicalizeRunOutcome,
  classifyRoundFailure,
  errText,
  explicitTerminal,
  expectedSubjectFor,
  isBaseAdvancedFailure,
  preparationPolicyFor,
  sanitize,
  sanitizePath,
  terminalToRunResult,
  verificationGateFor,
  type ExecutionWiringValidationResult,
  type ActivationCompensation,
  type AdmissionPort,
  type AfkObserver,
  type HandleResult,
  type RoundFailure,
  type RoundOutcomeEntry,
  type RoundReport,
  type RunRoundOptions,
  type Scheduler,
  type SchedulerDeps,
  type Terminal,
  type TerminalCommit,
} from './scheduler-support.js'
import type { MutableReport } from './scheduler-support.js'
import { createSchedulerOutcomes, type TryLedger } from './scheduler-outcomes.js'
import type { AfkSkillInvocationHandle } from '../skillInvocationAfkLifecycle.js'

class SchedulerInterruptedError extends Error {
  readonly _tag = 'SchedulerInterruptedError'
}

export interface SchedulerExecutionDeps {
  readonly scheduler: SchedulerDeps
  readonly semaphore: ReturnType<typeof createSemaphore>
  readonly inFlight: Set<string>
  readonly abortControllers: Map<string, AbortController>
  readonly shutdownCompletions: Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>
  readonly activeSkillInvocations: Map<string, readonly AfkSkillInvocationHandle[]>
  readonly validateExecutionWiring: NonNullable<SchedulerDeps['validateExecutionWiring']>
  readonly outcomes: ReturnType<typeof createSchedulerOutcomes>
  readonly applyDenial: (report: MutableReport, change: string, denial: AdmissionDenial) => void
  readonly tryLedger: TryLedger
  readonly settleTerminal: (
    report: MutableReport,
    context: PreparedExecutionContext,
    terminal: Terminal,
    options: {
      outcome?: RunOutcome
      err?: unknown
      classification?: ReturnType<typeof classifyFailure>
      ran: boolean
    },
  ) => Promise<void>
}

export function createSchedulerExecution(input: SchedulerExecutionDeps) {
  const {
    scheduler: deps,
    semaphore,
    inFlight,
    abortControllers,
    shutdownCompletions,
    activeSkillInvocations,
    validateExecutionWiring,
    outcomes,
    applyDenial,
    tryLedger,
    settleTerminal,
  } = input
  const { state, runChange, config, admission } = deps
  const observer = deps.observer
  const {
    applyFailure, emit, emitTerminal, handleActivationFailure, handlePreparationFailure,
    handlePreparationThrow, settlementFor, tryResetScheduledToQueued, writeBackSuccess,
  } = outcomes
  const handleOne = async (
    name: string,
    report: MutableReport,
    preparation: ExecutionPreparationPort,
    expectedLoopId: string | undefined,
    expectedAutonomyLevel: AutomationConfig['level'] | null | undefined,
    authorityClaim: WorkflowAuthorityClaimCapabilityV1,
  ): Promise<HandleResult> => {
    await semaphore.acquire()
    let phase: RoundFailure['phase'] = 'admission'
    try {
      if (report.halted) return { ok: true, change: name } // 前序候选触发 halt-round，停止后续 admission（良性跳过）

      // ── ① 原子 preflight（claim 之前，governance+ledger 锁内重读 registry+ledger）。reserve 只对
      //    「治理/业务拒绝」返 ok=false；ledger/registry I/O 错 throw → 落顶层 catch 归 failures ──
      phase = 'admission'
      const res = expectedLoopId === undefined && expectedAutonomyLevel === undefined
        ? await admission.reserve(name)
        : await admission.reserve(name, { expectedLoopId, expectedAutonomyLevel })
      if (!res.ok) {
        applyDenial(report, name, res) // denial 是治理常态，不进 failures、不改 ok
        return { ok: true, change: name }
      }
      let ctx = res.context
      report.admitted++

      // H11：命令层 scan 前检查不能替代此处——registry/skill 文件可能在两者间变化，且 SDK/AFK
      // 可直接进入 scheduler。此闸拿 reserve 刚解析出的 loop_id fresh 校验，仍早于 claim/sandbox。
      let wiring: ExecutionWiringValidationResult
      try {
        wiring = await validateExecutionWiring(ctx)
      } catch (error) {
        await tryLedger(report, name, 'settlement', () => admission.settleLost(ctx))
        return {
          ok: false,
          change: name,
          failure: classifyRoundFailure(name, 'admission', error),
        }
      }
      if (!wiring.ok) {
        await tryLedger(report, name, 'settlement', () => admission.settleLost(ctx))
        if (wiring.governancePaused !== true) report.pausePending.push(ctx.loop_id)
        report.entries.push({
          change: name,
          loopId: ctx.loop_id,
          disposition: 'denied',
          reason: `execution-wiring-${wiring.status}`,
        })
        return {
          ok: false,
          change: name,
          failure: {
            change: name,
            phase: 'admission',
            kind: 'config',
            message: sanitize(
              `loop「${ctx.loop_id}」execution wiring ${wiring.status}（${wiring.dimension}）：${wiring.reason}`,
            ),
          },
        }
      }

      // ── fresh authority + claim：重验授权事实（项目层读冻结计划里所选分支的 automation）后才 queued→scheduled ──
      phase = 'claim'
      const claimResult = await authorityClaim.claim(
        ctx,
        (expectedTrackId) => {
          const authority = ctx.workflow_action_authority
          return state.claim(name, expectedTrackId, authority === undefined ? undefined : {
            workflowRunId: authority.workflow_run_id,
            workflowId: authority.workflow_id,
            workflowFingerprint: authority.workflow_fingerprint,
            loopId: authority.loop_id,
            iterationId: authority.iteration_id,
          })
        },
      )
      if (!claimResult.ok) {
        applyDenial(report, name, claimResult)
        return { ok: true, change: name }
      }
      ctx = claimResult.context
      const won = claimResult.claimed
      if (!won) {
        phase = 'settlement'
        await tryLedger(report, name, 'settlement', () => admission.settleLost(ctx)) // 幂等关闭扣 0
        report.entries.push({ change: name, loopId: ctx.loop_id, disposition: 'claim-lost', result: 'skipped', reason: 'claim-lost' })
        return { ok: true, change: name }
      }

      // ── H10 §3：prepareSkillBundle（claim 之后、activate 之前——设计定稿精确顺序）。未 prepared
      //    绝不放行到 activate/runChange：RunChange 类型本身已收窄为 PreparedExecutionContext，
      //    这里是编译期约束落地成真实调用顺序的地方。 ──
      phase = 'preparation'
      let prep: PrepareOutcome
      try {
        prep = await preparation.prepare(ctx)
      } catch (e) {
        // preparation 内部 ledger I/O 意外抛错（非结构化 reason）：#6 同款结构化补偿，绝不空吞。
        return await handlePreparationThrow(report, name, ctx, e)
      }
      if (!prep.ok) {
        return await handlePreparationFailure(report, name, ctx, prep)
      }
      const preparedCtx = prep.context
      const sameAdmissionIdentity =
        preparedCtx.attempt_id === ctx.attempt_id
        && preparedCtx.reservation_id === ctx.reservation_id
        && preparedCtx.loop_id === ctx.loop_id
        && preparedCtx.change === ctx.change
        && preparedCtx.policy_epoch === ctx.policy_epoch
        && preparedCtx.skill_bundle_id === ctx.skill_bundle_id
      const canonicalCasPath = preparedCtx.preparedKind !== 'loop-bundle'
        || preparedCtx.skillBundle.casRelativePath === `.pipeline/loops/skill-snapshots/sha256/${preparedCtx.skillBundle.snapshotSha256}`
      // skill_bundle_id 是 reserve 在治理锁内冻结的权威绑定：有具名 profile 的 loop 只能产出
      // loop-bundle；缺席/null 的非 loop 才能产出 non-loop。包内发行 WeakSet 只证明对象由工厂
      // 构造，不证明调用方选对了互斥分支，因此这里必须独立核对。
      const preparedKindMatchesBinding = ctx.skill_bundle_id == null
        ? preparedCtx.preparedKind === 'non-loop'
        : preparedCtx.preparedKind === 'loop-bundle'
      if (!consumeIssuedPreparedContext(preparedCtx) || !sameAdmissionIdentity || !canonicalCasPath || !preparedKindMatchesBinding) {
        return await handlePreparationThrow(
          report,
          name,
          ctx,
          new Error('preparation 返回了未由本进程发行、已消费、身份漂移、bundle 分支不符或 CAS 路径不规范的 PreparedExecutionContext'),
        )
      }

      // ── activate：ledger 锁内验证 reservation 未关闭 → append reservation-activated ──
      phase = 'activation'
      let act: ActivateResult
      try {
        act = await admission.activate(preparedCtx)
      } catch (e) {
        // claim 成功但 activation append 失败（ledger I/O）：#6 结构化补偿，绝不空吞。
        return await handleActivationFailure(report, name, preparedCtx, e)
      }
      if (act.status === 'already-terminal') {
        // reserve→activate 之间 recovery 已关闭 reservation（罕见竞态）：复位 queued 待下轮重开，无需 settle。
        await tryResetScheduledToQueued(name)
        report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'activation-failed', reason: 'already-terminal' })
        return { ok: true, change: name }
      }

      // ── ② status recheck（claim 后 running 前）：停用 → 不跑，settle skipped/kill-switch，落 paused ──
      phase = 'state-transition'
      if (!(await admission.isActive(preparedCtx.loop_id))) {
        const won = await state.setAutomationOwnedWithFields(name, 'paused', { automation_cause: 'kill-switch' })
        if (!won) {
          const observed = await state.getAutomation(name).catch(() => '')
          report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'activation-failed', reason: 'ownership-lost' })
          if (isSettled(observed)) return { ok: true, change: name }
          const failure: RoundFailure = {
            change: name,
            phase: 'state-transition',
            kind: 'state-io',
            message: sanitize(`kill-switch state commit ownership-lost 且 automation=${observed || '(空)'}`),
          }
          return { ok: false, change: name, failure }
        }
        phase = 'settlement'
        // H10 r1 阻断3/D5 返工（任务B1）：preparedCtx 现是判别联合，skillBundle 只存在于
        // preparedKind==='loop-bundle' 分支——显式判别窄化。
        await tryLedger(report, name, 'settlement', () => admission.settleWon(preparedCtx, {
          result: 'skipped', reason: 'kill-switch', charge: 'none',
          skillBundleSnapshotSha256: preparedCtx.preparedKind === 'loop-bundle' ? preparedCtx.skillBundle.snapshotSha256 : undefined,
        }))
        report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'settled', result: 'paused', reason: 'kill-switch' })
        emit(name, 'paused')
        return { ok: true, change: name }
      }

      phase = 'state-transition'
      // H7 r7：scheduled→running 仍是一次 owner commit，不能用普通 set 覆盖在 isActive 重查后
      // 并发到达的人工 pause/requeue。CAS 输后只有明确读到非 daemon-owned 状态才可把本次
      // reservation 以零扣账关闭；读失败或仍见 scheduled/running 时所有权事实不明，保留 open
      // 给 recovery，绝不启动 runChange。
      let runningWon: boolean
      try {
        runningWon = await state.setAutomationOwned(name, 'running')
      } catch (err) {
        const failure = classifyRoundFailure(name, 'state-transition', err)
        report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'activation-failed', reason: 'state-write-failed' })
        return { ok: false, change: name, failure }
      }
      if (!runningWon) {
        let observed: string
        try {
          observed = await state.getAutomation(name)
        } catch (err) {
          const failure = classifyRoundFailure(name, 'state-transition', err)
          report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'activation-failed', reason: 'ownership-lost' })
          return { ok: false, change: name, failure }
        }
        if (isSettled(observed)) {
          phase = 'settlement'
          await settleTerminal(report, preparedCtx, 'skipped', { ran: false })
          report.entries.push({
            change: name, loopId: preparedCtx.loop_id,
            disposition: 'activation-failed', result: 'skipped', reason: 'ownership-lost',
          })
          return { ok: true, change: name }
        }
        const failure: RoundFailure = {
          change: name,
          phase: 'state-transition',
          kind: 'state-io',
          message: sanitize(`scheduled→running owner CAS 输且 automation=${observed || '(空)'}`),
        }
        report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'activation-failed', reason: 'ownership-lost' })
        return { ok: false, change: name, failure }
      }
      emit(name, 'running')
      inFlight.add(name)
      const controller = new AbortController()
      abortControllers.set(name, controller)
      let resolveShutdownCompletion: (() => void) | undefined
      const shutdownCompletion = new Promise<void>((resolve) => { resolveShutdownCompletion = resolve })
      shutdownCompletions.set(name, { promise: shutdownCompletion, resolve: () => resolveShutdownCompletion?.() })
      let executedOutcome: RunOutcome | undefined
      let invocationHandles: readonly AfkSkillInvocationHandle[] = []
      try {
        phase = 'execution'
        invocationHandles = await deps.skillInvocations?.start(preparedCtx, new Date().toISOString()) ?? []
        if (controller.signal.aborted) {
          throw new SchedulerInterruptedError('scheduler interrupted while AFK invocation start was in flight')
        }
        if (invocationHandles.length > 0) activeSkillInvocations.set(name, invocationHandles)
        let outcome = canonicalizeRunOutcome(await runChange(preparedCtx, controller.signal), preparedCtx)
        if (controller.signal.aborted) {
          throw new SchedulerInterruptedError('scheduler interrupted while AFK execution was in flight')
        }
        executedOutcome = outcome
        // ── ④ terminal settle 前重查：停用 → 强落 paused（防成功态被写成 merged）──
        // 已发生的物理 merge 是不可逆事实；terminal 重查只能阻止尚未 landed 的 run，不能把已合入
        // base 的结果改写成“kill-switch 未合并”。
        if (outcome.mergeLanded !== true && !(await admission.isActive(preparedCtx.loop_id))) {
          outcome = Object.freeze({ ...outcome, killSwitched: true })
        }
        const terminalCommit = await writeBackSuccess(name, preparedCtx, outcome)
        // state commit 未证实时绝不先关 reservation。物理 merge 已落地且 owner 已被外部终态抢走时，
        // 还要求该外部终态确为 merged；paused/failed 等虽明确，却与不可逆 ref 事实冲突，必须 recovery。
        // 本地 committed 仍遵守 writeBackSuccess 的既有 level/gate 裁决（例如 L1 report-only）。
        if (
          terminalCommit.status === 'recovery-pending'
          || (
            outcome.mergeLanded === true
            && terminalCommit.status === 'external-terminal'
            && terminalCommit.terminal !== 'merged'
          )
        ) {
          const observed = terminalCommit.status === 'recovery-pending'
            ? terminalCommit.observed
            : terminalCommit.terminal
          const detail = terminalCommit.status === 'recovery-pending' && terminalCommit.error !== undefined
            ? errText(terminalCommit.error)
            : `automation=${observed || '(未知)'}`
          const failure: RoundFailure = {
            change: name,
            phase: 'state-transition',
            kind: 'state-io',
            message: sanitize(
              outcome.mergeLanded === true
                ? `merge 已落地但 terminal state 未确认 merged；${detail}`
                : `success terminal state commit 未确认；${detail}`,
            ),
          }
          report.entries.push({
            change: name,
            loopId: preparedCtx.loop_id,
            disposition: 'recovery-pending',
            reason: 'state-write-pending',
          })
          return { ok: false, change: name, failure }
        }
        const settled = terminalCommit.terminal
        phase = 'settlement'
        await settleTerminal(report, preparedCtx, settled, { outcome, ran: true })
        if (invocationHandles.length > 0) {
          await deps.skillInvocations?.finish(invocationHandles)
          activeSkillInvocations.delete(name)
          invocationHandles = []
        }
        if (outcome.mergeJournalPending === true) {
          report.failures.push({
            change: name, phase: 'settlement', kind: 'ledger-io',
            message: 'base ref 已落地，但 merge-landed ledger receipt 写入失败；recovery 必须按 intent + ref 对账',
          })
        }
        emitTerminal(name, settled)
        report.entries.push({ change: name, loopId: preparedCtx.loop_id, disposition: 'settled', result: settled, reason: outcome.killSwitched ? 'kill-switch' : undefined })
      } catch (err) {
        if (executedOutcome?.mergeLanded === true) {
          // update-ref 已成功是不可逆事实；终态 state 写失败不得进通用 retry
          // 分类，否则会把已合并产物重排 queued 再跑一次。state 尚未提交时也绝不能先关
          // reservation：否则 recovery 会把它视为 closed、永久留下 running。保留 running +
          // intent/landed + open reservation，交下一轮先 commitRecoveredMerge 再幂等落 terminal。
          const failure: RoundFailure = {
            change: name, phase: 'state-transition', kind: 'state-io', message: sanitize(errText(err)),
          }
          report.failures.push(failure)
          report.entries.push({
            change: name,
            loopId: preparedCtx.loop_id,
            disposition: 'recovery-pending',
            reason: 'state-write-pending',
          })
          return { ok: false, change: name, failure }
        }
        const executionError = controller.signal.aborted
          ? new SchedulerInterruptedError('scheduler interrupted while AFK execution was in flight')
          : err
        // 执行/结算异常：分类落态 + 关闭 reservation（业务失败路，非 round 基础设施故障——settle I/O 失败另经 tryLedger 记）。
        const failureClassification = classifyFailure(executionError)
        const terminalCommit = await applyFailure(name, executionError, failureClassification)
        if (terminalCommit.status === 'recovery-pending') {
          const detail = terminalCommit.error !== undefined
            ? errText(terminalCommit.error)
            : `automation=${terminalCommit.observed || '(未知)'}`
          const failure: RoundFailure = {
            change: name,
            phase: 'state-transition',
            kind: 'state-io',
            // 两段失败都保留：前半是触发分类/重试的原始执行异常，后半是终态持久化
            // 未确认的恢复信息。只报告后者会把真正根因遮蔽成笼统的 state-write-pending。
            message: sanitize(`execution failure: ${failureClassification.message}；terminal commit 未确认；${detail}`),
          }
          report.entries.push({
            change: name,
            loopId: preparedCtx.loop_id,
            disposition: 'recovery-pending',
            reason: 'state-write-pending',
          })
          return { ok: false, change: name, failure }
        }
        const settled = terminalCommit.terminal
        phase = 'settlement'
        await settleTerminal(report, preparedCtx, settled, { err: executionError, classification: failureClassification, ran: true })
        if (invocationHandles.length > 0) {
          await deps.skillInvocations?.finish(invocationHandles)
          activeSkillInvocations.delete(name)
          invocationHandles = []
        }
        emitTerminal(name, settled)
        const baseAdvanced = isBaseAdvancedFailure(executionError)
        const cleanupFailed = failureClassification.cause === 'container-cleanup'
        const schedulerInterrupted = failureClassification.cause === 'scheduler-interrupted'
        report.entries.push({
          change: name,
          loopId: preparedCtx.loop_id,
          disposition: 'settled',
          result: settled,
          reason: baseAdvanced ? 'base-advanced' : cleanupFailed ? 'container-cleanup' : undefined,
        })
        // G² 子问题1：base 被第三方推进不是普通 per-change 冲突，是并发异常——settle 为 conflict 留现场之外，
        // 另记一条 round failure 使 ok=false（CLI 非零、不打印跑完一轮）。H14 r3 同样要求容器清理失败
        // fail-loud：即便已按 conflict 安全落态，也不能让 round/CLI 报成功。普通 content-conflict 不进此表。
        if (baseAdvanced || cleanupFailed || schedulerInterrupted) {
          report.failures.push(classifyRoundFailure(name, 'execution', executionError))
        }
      } finally {
        inFlight.delete(name)
        abortControllers.delete(name)
        activeSkillInvocations.delete(name)
        shutdownCompletions.get(name)?.resolve()
        shutdownCompletions.delete(name)
      }
      return { ok: true, change: name }
    } catch (error) {
      // 顶层兜底（reserve/claim/isActive/settleLost 等 phase 的意外 throw）：结构化归 failures，绝不吞成成功。
      return { ok: false, change: name, failure: classifyRoundFailure(name, phase, error) }
    } finally {
      semaphore.release()
    }
  }

  /** 幂等关闭 reservation（commit marker）；ledger 写失败记进 report（failures + ledgerFailures），不 throw、不打印假成功。
   *  H10：调用点恒是 prepareSkillBundle 成功后的 preparedCtx（settlementFor 据此把
   *  skillBundleSnapshotSha256 带进 RunSettlement）。 */
  return { handleOne }
}
