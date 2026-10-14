import type { AutomationPolicySnapshot, EffectiveSkillResolver, LoopEntry, LoopLedgerStore, LoopRegistry, SkillBundleResolutionInput } from '@tenon/kernel'
import {
  admissionDecision, budgetDayOf, buildAttemptContext, compileAutomationPolicySnapshot, compileConstraintPolicy, evaluateConstraintPolicy,
  indexMergeFactsByAttempt, LedgerDegradedError, loopMaterialUnchanged,
  normalizeOnExceed, projectLoopLedger,
  registryContentEpoch, reservedTokensFor, resolveLoopBinding, resolveSkillBundle, withRegistryGovernanceLock,
  type AdmissionBlock, type AttemptContextLedgerSnapshot, type BudgetExceedAction, type BudgetReservationRecord,
  type ChangeLoopBindingRecord, type LedgerRecord, type MergeIntentRecord, type MergeLandedRecord,
  type ReservationActivatedRecord, type RunRecord, type SkillBundleSnapshotRecord, type UsageRecord, type VerificationResult,
} from '@tenon/kernel'
import type { AutomationLevel } from '../types.js'
import type { ProviderStructuredUsage } from '../runner/runner.js'
import type { SkillContentLocator } from '../skills/content-locator.js'
import { buildCanonicalManifest, materializeSkillSnapshot, type MaterializeSkillSnapshotOptions } from '../skills/snapshot-store.js'
import type { SkillSnapshotInput, SkillSnapshotProvenance, SkillSnapshotPublishResult } from '../skills/types.js'
import {
  makeIdGen, markLoopPrepared, markNonLoopPrepared,
  type CapturedExecutionCoordinate, type ExecutionContext, type ExecutionCoordinatePort,
  type ExecutionPreparationPort, type PrepareOutcome, type PreparationFailureReason,
  type PreparedExecutionContext, type PreparedSkillSlot,
} from './execution-context.js'
import {
  DAEMON_OWNED,
  DEFAULT_TTL_MS,
  MAX_RESERVE_RETRIES,
  SkillProfileValidatorUnconfiguredError,
  attemptContextFor,
  isPreparedContext,
  snapshotMatchesPrepared,
  terminalToResult,
  type ActivateResult,
  type ExecutionLiveness,
  type ConfiguredLoopAdmission,
  type LoopAdmissionDeps,
  type MergeIntentJournalInput,
  type MergeLandedJournalInput,
  type RecoveredMergeState,
  type ReserveOutcome,
  type ReserveResult,
  type RunSettlement,
} from './loop-admission-types.js'
import { createAdmissionJournal } from './loop-admission-journal.js'
import {
  bindAndEvaluateAfkWorkflowRun,
  claimWithFreshAfkWorkflowAuthority,
  closeWorkflowAuthorizationDenial,
  compensateWorkflowBindingFailure,
  evaluateMissingAfkWorkflowAdmission,
} from './workflow-action-admission.js'
export function createLoopAdmission(deps: LoopAdmissionDeps): ConfiguredLoopAdmission {
  const {
    repoRoot, ledger, loadRegistry, clock, level, image, getAutomation, isSkillProfileKnown,
    bindAutomationPolicy, bindWorkflowActionAuthority, workflowActionAuthority,
  } = deps
  const ttlMs = deps.reservationTtlMs ?? DEFAULT_TTL_MS
  const newId = deps.newId ?? makeIdGen()
  // #5 orphan reconcile 注入面（缺省保守：liveness unknown、CAS no-op → orphan 保持 open 不误关）。
  const getExecutionLiveness = deps.getExecutionLiveness ?? (async (): Promise<ExecutionLiveness> => 'unknown')
  const resetScheduledToQueued = deps.resetScheduledToQueued ?? (async (): Promise<boolean> => false)
  const failRunningToTerminal = deps.failRunningToTerminal ?? (async (): Promise<boolean> => false)
  const readGitRef = deps.readGitRef
  const isCommitAncestor = deps.isCommitAncestor
  const commitRecoveredMerge = deps.commitRecoveredMerge
  const {
    base,
    buildRecoveredMergeTerminal,
    buildTerminal,
    close,
    closeRecord,
    latestBinding,
    mergeFactsForReservation,
    recordMergeIntent,
    recordMergeLanded,
    recordProviderUsage,
    recoveredMergeState,
    usageAccountingFor,
  } = createAdmissionJournal({ repoRoot, ledger, clock, newId, level })
  const recoverLoopInLock = async (records: readonly LedgerRecord[], loopId: string): Promise<void> => {
    const closed = new Set<string>()
    for (const r of records) if (r.kind === 'run' && r.reservation_id !== undefined) closed.add(r.reservation_id)
    const activatedIds = new Set<string>()
    for (const r of records) if (r.kind === 'reservation-activated') activatedIds.add(r.reservation_id)
    const now = clock()
    for (const r of records) {
      if (r.kind !== 'budget-reservation' || r.loop_id !== loopId) continue
      if (closed.has(r.reservation_id)) continue // 已关闭
      const isActivated = activatedIds.has(r.reservation_id)
      if (!isActivated) continue
      // merge intent 表明 ref CAS 可能已经发生；不论 automation 当前看起来是什么 terminal，
      // 都不能在 ledger 锁内用 generic recovered 吞掉 canonical verification/artifacts。
      if (mergeFactsForReservation(records, r).intent !== undefined) continue
      const automation = await getAutomation(r.change).catch(() => '')
      if (automation !== '' && !DAEMON_OWNED.has(automation)) {
        await close(r.reservation_id, (reservation) => closeRecord(reservation, {
          result: terminalToResult(automation), reason: 'recovered', charge: 'reserved-estimate', now,
          usageAccounting: usageAccountingFor(records, reservation),
        }))
      }
      // scheduled/running（daemon-owned 或读不到）→ orphan：本锁内不动，交 reconcileOrphans。
    }
  }

  /** Orphan reconcile runs outside ledger locks: change CAS and ledger close are independent.
   *  Unknown/alive executions stay open; only explicit dead evidence permits activated recovery. */
  const reconcileOrphans = async (): Promise<void> => {
    const read = await ledger.read(repoRoot).catch(() => null)
    if (read === null || read.rejected.length > 0) return // 读失败/坏行 → 本轮不 reconcile（不猜）
    const closedIds = new Set<string>()
    for (const r of read.records) if (r.kind === 'run' && r.reservation_id !== undefined) closedIds.add(r.reservation_id)
    const activatedIds = new Set<string>()
    for (const r of read.records) if (r.kind === 'reservation-activated') activatedIds.add(r.reservation_id)
    const now = clock()
    for (const r of read.records) {
      if (r.kind !== 'budget-reservation') continue
      if (closedIds.has(r.reservation_id)) continue
      const isActivated = activatedIds.has(r.reservation_id)
      if (!isActivated) {
        if (!(now > r.expires_at)) continue
        const automation = await getAutomation(r.change).catch(() => '')
        if (automation === 'queued') {
          await close(r.reservation_id, (reservation) => closeRecord(reservation, {
            result: 'skipped', reason: 'reservation-expired', charge: 'none', now,
          }))
        } else if (automation === 'scheduled') {
          const won = await resetScheduledToQueued(r.change).catch(() => false)
          if (won) {
            await close(r.reservation_id, (reservation) => closeRecord(reservation, {
              result: 'skipped', reason: 'reservation-expired', charge: 'none', now,
            }))
          }
        }
        continue
      }
      const mergeFacts = mergeFactsForReservation(read.records, r)
      const intent = mergeFacts.intent
      if (intent !== undefined) {
        // landed receipt 是最强证据，无需再读 ref。intent-only 则先信精确 tip==M，
        // tip 已前进时再用明确的 commit ancestry probe 证明 M 在当时 base 历史中。
        let mergeConfirmed = mergeFacts.landed !== undefined
        if (!mergeConfirmed && readGitRef !== undefined) {
          const observed = await readGitRef(intent.base_ref).catch(() => '')
          mergeConfirmed = observed === intent.merged_commit_sha
          if (!mergeConfirmed && observed !== '' && isCommitAncestor !== undefined) {
            mergeConfirmed = await isCommitAncestor(intent.merged_commit_sha, observed).catch(() => false)
          }
        }
        // intent 记录了「可能已进行不可逆 ref CAS」。无论 probe 返回 false、缺席
        // 还是命令错误，都只能表示本轮无法证明 merged；不得继续落普通 orphan failed。
        if (!mergeConfirmed) continue
        // change state 写与 ledger close 分属独立锁：先把不可逆物理事实修复为
        // merged，再幂等关 reservation。两步之间 crash 时下轮重做，不双扣账。
        if (commitRecoveredMerge === undefined) continue
        const recoveredState = recoveredMergeState(mergeFacts.landed)
        await commitRecoveredMerge(r.change, recoveredState)
        await close(r.reservation_id, (reservation) =>
          buildRecoveredMergeTerminal(reservation, intent, mergeFacts.landed, clock()))
        continue
      }
      const automation = await getAutomation(r.change).catch(() => '')
      if (!DAEMON_OWNED.has(automation)) continue // 只处理 daemon-owned（scheduled/running）orphan
      const liveness = await getExecutionLiveness(r.change).catch((): ExecutionLiveness => 'unknown')
      if (liveness !== 'dead') continue // alive / unknown → 保留占 in-flight（不猜）
      if (automation === 'scheduled') {
        const won = await resetScheduledToQueued(r.change).catch(() => false) // change 锁（独立临界区）
        if (won) await close(r.reservation_id, (reservation) => closeRecord(reservation, { result: 'skipped', reason: 'infrastructure-error', charge: 'none', now }))
      } else if (automation === 'running') {
        const settled = await failRunningToTerminal(r.change).catch(() => false) // change 锁（独立临界区）
        if (settled) await close(r.reservation_id, (reservation) => closeRecord(reservation, {
          result: 'failed', reason: 'infrastructure-error', charge: 'reserved-estimate', now,
          usageAccounting: usageAccountingFor(read.records, reservation),
        }))
      }
    }
  }

  /** 由未结算预占派生一条关闭 RunRecord（recover / claim-lost / expired / orphan 共用）。 */
  const reserve = async (change: string, opts?: {
    expectedLoopId?: string
    expectedAutonomyLevel?: AutomationLevel | null
  }): Promise<ReserveResult> => {
    // #5 pre-phase：activated orphan reconcile（ledger 锁之外——change CAS 不得在 ledger 锁内取）。
    await reconcileOrphans()
    // 主临界区按 governance→ledger 锁序重读、判定并落 reservation；epoch 变更时最多重试三次。
    for (let attempt = 1; attempt <= MAX_RESERVE_RETRIES; attempt++) {
      const outcome = await withRegistryGovernanceLock(repoRoot, () => reserveOnce(change, opts))
      if ('retry' in outcome) continue
      if (!outcome.ok) return outcome
      if (bindAutomationPolicy === undefined || bindWorkflowActionAuthority === undefined) {
        return closeWorkflowAuthorizationDenial({
          context: outcome.context,
          authorization: evaluateMissingAfkWorkflowAdmission(),
          clock, close, closeRecord,
        })
      }
      try {
        const { context, run, authorization } = await bindAndEvaluateAfkWorkflowRun({
          change,
          context: outcome.context,
          bindAutomationPolicy,
          bindWorkflowActionAuthority,
          workflowActionAuthority,
        })
        if (authorization.allowed) return { ok: true, context }

        return closeWorkflowAuthorizationDenial({
          context, authorization, workflowRunId: run.id,
          clock, close, closeRecord,
        })
      } catch (bindingError) {
        // reservation 已在 reserveOnce 的 ledger 临界区 durable 落盘；WorkflowRun 绑定位于锁外，
        // 因此绑定或动态 authority provider 失败都必须以零扣费 terminal 补偿关闭，不能把
        // in-flight 额度泄漏到 TTL recovery，也不能降级成普通 authorization denial 让 round 假成功。
        // 原错误仍原样上抛；若补偿本身也失败，则把两项事实都带给上层，且保留 open reservation
        // 供既有 recovery 处理（绝不谎报已关闭）。
        return compensateWorkflowBindingFailure({
          context: outcome.context, bindingError,
          clock, close, closeRecord,
        })
      }
    }
    return { ok: false, action: 'skip-run', reason: 'registry-concurrent-update', detail: `registry 连续 ${MAX_RESERVE_RETRIES} 次在 admission 临界区内变化，放弃本轮（避免活锁）` }
  }

  /** 单次 reserve 临界区（已持 governance 锁）：内层 ledger 锁重读→判定→epoch 复验→append。epoch 变 → { retry }。 */
  const reserveOnce = async (change: string, opts?: {
    expectedLoopId?: string
    expectedAutonomyLevel?: AutomationLevel | null
  }): Promise<ReserveOutcome> => {
    // Stage B 返工 #2：loadRegistry 真实 I/O 故障（EACCES/EIO/EISDIR…）**throw**（不 catch）→ 经
    // withRegistryGovernanceLock 上抛到 scheduler.handleOne 顶层 catch，归 RoundReport.failures（registry-io）
    // 使 ok=false。只有 ENOENT→data:null 才是合法「无 registry」denial（下方 fail-closed skip-run）。
    const reg1 = loadRegistry(repoRoot)
    if (reg1.errors.length > 0) {
      return { ok: false, action: 'skip-run', reason: 'registry-unparseable', detail: `loops.yaml 载入失败：${reg1.errors[0]}` }
    }
    if (reg1.data === null) {
      return { ok: false, action: 'skip-run', reason: 'no-registry', detail: 'loops.yaml 不存在（无 loop 语境，fail-closed）' }
    }
    const registry1 = reg1.data
    const epoch1 = registryContentEpoch(registry1)
    return ledger.withLedgerLock(repoRoot, async (): Promise<ReserveOutcome> => {
      const read1 = await ledger.read(repoRoot)
      if (read1.rejected.length > 0) {
        return { ok: false, action: 'skip-run', reason: 'ledger-degraded', detail: `账本有 ${read1.rejected.length} 条坏行，admission fail-closed` }
      }
      // 归属（snapshot1）只信锁内最新 durable binding，其次最长前缀。targeted run 的 expectedLoopId
      // 是 selector 先前观察值，只做乐观并发复核，绝不能喂给 resolveLoopBinding 的 explicit override。
      const binding = resolveLoopBinding({
        change, latestBindingLoopId: latestBinding(read1.records, change), loops: registry1.loops,
      })
      if (!binding.ok) {
        if (opts?.expectedLoopId !== undefined) {
          return {
            ok: false,
            action: 'skip-run',
            reason: 'binding-changed',
            detail: `selector 预期 change「${change}」归属 loop「${opts.expectedLoopId}」，但锁内最新自然归属无法解析：${binding.detail}`,
          }
        }
        return { ok: false, action: 'skip-run', reason: `binding-${binding.reason}`, detail: binding.detail }
      }
      if (opts?.expectedLoopId !== undefined && binding.loopId !== opts.expectedLoopId) {
        return {
          ok: false,
          action: 'skip-run',
          reason: 'binding-changed',
          detail: `selector 预期 change「${change}」归属 loop「${opts.expectedLoopId}」，锁内最新 durable 自然归属已变为「${binding.loopId}」`,
          loopId: binding.loopId,
        }
      }
      const loop1: LoopEntry = registry1.loops.find((l) => l.id === binding.loopId)!
      if (opts?.expectedAutonomyLevel !== undefined && opts.expectedAutonomyLevel !== null
        && loop1.autonomy_level !== opts.expectedAutonomyLevel) {
        return {
          ok: false,
          action: 'skip-run',
          reason: 'policy-changed',
          detail: `selector 观察到 loop「${loop1.id}」autonomy=${opts.expectedAutonomyLevel}，` +
            `admission 锁内最新值为 ${loop1.autonomy_level}；拒绝沿用过期放权级别`,
          loopId: loop1.id,
        }
      }
      const admissionConstraint = evaluateConstraintPolicy(compileConstraintPolicy(loop1), {
        operation: 'admission', active: loop1.status === 'active', matches: () => false,
      })
      if (!admissionConstraint.allowed) {
        return { ok: false, action: 'skip-run', reason: 'loop-inactive', detail: `loop「${loop1.id}」status=${loop1.status}（非 active，硬拒）`, loopId: loop1.id }
      }
      // H10 §1/§5：缺失或未知 bundle 是持久 wiring 错误；不建 reservation 并暂停 loop。
      // loopMaterialUnchanged 会捕获复验期间的 bundle 变化；未装配校验器则 fail-loud。
      const bundleId1 = loop1.skill_bundle_id
      if (bundleId1 === null || bundleId1 === undefined) {
        return { ok: false, action: 'pause-loop', reason: 'skill-bundle-unwired', detail: `loop「${loop1.id}」skill_bundle_id 未接线（缺省/null）——fail-closed 拒绝 real-run`, loopId: loop1.id }
      }
      if (bundleId1 !== '_all') {
        if (isSkillProfileKnown === undefined) {
          throw new SkillProfileValidatorUnconfiguredError(
            `loop「${loop1.id}」skill_bundle_id="${bundleId1}" 需要具名 profile 存在性校验，但 LoopAdmissionDeps.isSkillProfileKnown 未装配（H10 生产装配见任务7）——fail-closed，不放行、不创建 reservation`,
          )
        }
        if (!isSkillProfileKnown(bundleId1)) {
          return { ok: false, action: 'pause-loop', reason: 'skill-bundle-profile-not-found', detail: `loop「${loop1.id}」skill_bundle_id="${bundleId1}" 不在当前合法 profile 键空间`, loopId: loop1.id }
        }
      }
      const now = clock()
      const automationPolicy = compileAutomationPolicySnapshot(loop1, { capturedAt: now })
      // 崩溃恢复（锁内先行；只 ledger-only 关闭——见 recoverLoopInLock 注释，绝不取 change 锁）。
      await recoverLoopInLock(read1.records, loop1.id)
      // ── epoch reverify（#4；append binding/reservation 之前）：重读 registry 验 epoch 未变。所有受支持
      //    写方都持 governance 锁，正常 epoch 不可能变；此复验捕获人工编辑/未迁移旧写方 → 变则 { retry }。
      const reg2 = loadRegistry(repoRoot)
      if (reg2.data === null || registryContentEpoch(reg2.data) !== epoch1) return { retry: true }
      const registry2 = reg2.data
      const read2 = await ledger.read(repoRoot) // recover 后重读（binding 尚未 append，不影响预算投影）
      // re-resolve binding against snapshot2，验 loop 仍存在/active/物化字段未变（epoch 相等已蕴含，防御复核）。
      const binding2 = resolveLoopBinding({
        change, latestBindingLoopId: latestBinding(read2.records, change), loops: registry2.loops,
      })
      if (opts?.expectedLoopId !== undefined && (!binding2.ok || binding2.loopId !== opts.expectedLoopId)) {
        return {
          ok: false,
          action: 'skip-run',
          reason: 'binding-changed',
          detail: binding2.ok
            ? `selector 预期 change「${change}」归属 loop「${opts.expectedLoopId}」，admission 复验时最新自然归属为「${binding2.loopId}」`
            : `selector 预期 change「${change}」归属 loop「${opts.expectedLoopId}」，admission 复验时自然归属无法解析：${binding2.detail}`,
          loopId: binding2.ok ? binding2.loopId : undefined,
        }
      }
      if (!binding2.ok || binding2.loopId !== binding.loopId) return { retry: true }
      const loop2 = registry2.loops.find((l) => l.id === binding2.loopId)
      if (loop2 === undefined || loop2.status !== 'active' || !loopMaterialUnchanged(loop1, loop2)) return { retry: true }
      // ── epoch 复验通过 → 物化 binding + append reservation ──
      if (binding.materialize) {
        const bindingRecord: ChangeLoopBindingRecord = { ...base(), kind: 'change-loop-binding', change, loop_id: loop2.id, source: 'longest-prefix' }
        await ledger.append(repoRoot, bindingRecord)
      }
      const { tokens, basis } = reservedTokensFor(loop2)
      const onExceed = normalizeOnExceed(loop2.budget.on_exceed)
      const budgetDay = budgetDayOf(now)
      const projection = projectLoopLedger(read2.records, read2.rejected.length, loop2.id, budgetDay)
      const decision = admissionDecision(
        projection,
        { maxRunsPerDay: loop2.budget.max_runs_per_day, maxInFlight: loop2.budget.max_in_flight, maxTokensPerDay: loop2.budget.max_tokens_per_day, onExceed },
        { change, reservedTokens: tokens },
      )
      if (!decision.allowed) {
        return { ok: false, action: decision.block.action, reason: decision.block.limit, detail: decision.detail, loopId: loop2.id, block: decision.block }
      }
      // 判定通过 → append reservation（+ fsync）。这一条 ledger 写严格早于 claim 的 queued→scheduled CAS。
      const reservationId = newId('res')
      const attemptId = newId('att')
      const iterationId = `iteration-${attemptId}`
      const attemptContext = attemptContextFor(read2.records, loop2.id, change)
      await ledger.append(repoRoot, {
        ...base(), kind: 'budget-reservation', reservation_id: reservationId, attempt_id: attemptId,
        iteration_id: iterationId,
        loop_id: loop2.id, change, budget_day: budgetDay, reserved_runs: 1, reserved_tokens: tokens, token_basis: basis,
        limits_snapshot: { max_runs_per_day: loop2.budget.max_runs_per_day, max_in_flight: loop2.budget.max_in_flight, max_tokens_per_day: loop2.budget.max_tokens_per_day, on_exceed: onExceed },
        attempt_context: attemptContext,
        expires_at: new Date(Date.parse(now) + ttlMs).toISOString(),
      })
      const context: ExecutionContext = {
        attempt_id: attemptId, reservation_id: reservationId, loop_id: loop2.id, change,
        iteration_id: iterationId,
        level, runner: loop2.runner, image, admitted_at: now,
        reservation: { runs: 1, tokens, token_basis: basis },
        // H10 §3 步骤1：epoch1 通过了上面 reg2 的 registryContentEpoch(reg2.data) !== epoch1 复验
        // （不等则已 { retry: true }），此刻即 loop2 所在快照的物化 epoch；bundleId1 是 loop1 上
        // 已校验过（非空、_all 或已知具名 profile）的 skill_bundle_id，loopMaterialUnchanged 保证
        // loop2 的值与其相同（见上方判定注释）。
        policy_epoch: epoch1,
        skill_bundle_id: bundleId1,
        automation_policy: automationPolicy,
        attempt_context: attemptContext,
      }
      return { ok: true, context }
    })
  }

  /** ctx + reservation + settlement → terminal RunRecord builder（纯函数，关键字段取自 reservation：
   *  closeReservationIfOpen 会校验一致；reserved_tokens 以 ledger reservation 为权威）。 */
  const activate = async (ctx: ExecutionContext): Promise<ActivateResult> =>
    ledger.withLedgerLock(repoRoot, async (): Promise<ActivateResult> => {
      const read = await ledger.read(repoRoot)
      if (read.rejected.length > 0) {
        throw new LedgerDegradedError(`activate: 账本有 ${read.rejected.length} 条坏行，拒绝在损坏账本上激活 reservation「${ctx.reservation_id}」`)
      }
      const reservations = read.records.filter(
        (record): record is BudgetReservationRecord =>
          record.kind === 'budget-reservation' && record.reservation_id === ctx.reservation_id,
      )
      if (reservations.length !== 1) {
        throw new LedgerDegradedError(`activate: reservation「${ctx.reservation_id}」数量=${reservations.length}，拒绝激活`)
      }
      const reservation = reservations[0]!
      if (reservation.attempt_id !== ctx.attempt_id
        || (reservation.iteration_id !== undefined && ctx.iteration_id !== reservation.iteration_id)
        || reservation.loop_id !== ctx.loop_id || reservation.change !== ctx.change) {
        throw new LedgerDegradedError('activate: context 与 reservation 的 attempt/iteration/loop/change 不一致')
      }
      if (isPreparedContext(ctx)) {
        if (ctx.preparedKind !== 'loop-bundle' || ctx.skill_bundle_id == null) {
          throw new LedgerDegradedError('activate: loop admission 不接受 non-loop PreparedExecutionContext')
        }
        const snapshots = read.records.filter(
          (record): record is SkillBundleSnapshotRecord =>
            record.kind === 'skill-bundle-snapshot' && record.reservation_id === ctx.reservation_id,
        )
        const snapshot = snapshots[0]
        if (snapshots.length !== 1 || snapshot === undefined || !snapshotMatchesPrepared(snapshot, ctx)) {
          throw new LedgerDegradedError(
            `activate: reservation「${ctx.reservation_id}」的 skill-bundle-snapshot 缺失、重复或与 PreparedExecutionContext 不一致`,
          )
        }
      }
      const closed = read.records.some((r) => r.kind === 'run' && r.reservation_id === ctx.reservation_id)
      if (closed) return { status: 'already-terminal' } // recovery/结算已关闭，不追加晚到 activation
      const alreadyActivated = read.records.some((r) => r.kind === 'reservation-activated' && r.reservation_id === ctx.reservation_id)
      if (alreadyActivated) return { status: 'activated' } // TTL 只约束首次 reserve→activate 窗口；幂等重放不倒退

      const activatedAt = clock()
      const activatedAtMs = Date.parse(activatedAt)
      const expiresAtMs = Date.parse(reservation.expires_at)
      if (!Number.isFinite(activatedAtMs) || !Number.isFinite(expiresAtMs)) {
        throw new LedgerDegradedError(`activate: reservation「${ctx.reservation_id}」的 clock/expires_at 不是合法时间戳`)
      }
      if (activatedAtMs > expiresAtMs) {
        await close(ctx.reservation_id, (authoritative) => buildTerminal(ctx, authoritative, {
          result: 'skipped', reason: 'reservation-expired', charge: 'none',
          skillBundleSnapshotSha256:
            isPreparedContext(ctx) && ctx.preparedKind === 'loop-bundle'
              ? ctx.skillBundle.snapshotSha256
              : undefined,
        }))
        return { status: 'already-terminal' }
      }
      await ledger.append(repoRoot, {
        ...base(), kind: 'reservation-activated', reservation_id: ctx.reservation_id, attempt_id: ctx.attempt_id,
        iteration_id: ctx.iteration_id,
        loop_id: ctx.loop_id, change: ctx.change, started_at: activatedAt,
      })
      return { status: 'activated' }
    })

  /** settleWon：幂等关闭 reservation（Stage B 返工 #1，不再直接 ledger.append）。already-closed = 成功幂等。 */
  const settleWon = async (ctx: ExecutionContext, s: RunSettlement): Promise<void> => {
    await ledger.withLedgerLock(repoRoot, async () => {
      const read = await ledger.read(repoRoot)
      if (read.rejected.length > 0) {
        throw new LedgerDegradedError(`settleWon: 账本有 ${read.rejected.length} 条坏行`)
      }
      await close(ctx.reservation_id, (reservation) =>
        buildTerminal(ctx, reservation, s, usageAccountingFor(read.records, reservation)))
    })
  }
  const settleLost = async (ctx: ExecutionContext): Promise<void> => {
    await settleWon(ctx, { result: 'skipped', reason: 'claim-lost', charge: 'none' })
  }
  const isActive = async (loopId: string): Promise<boolean> => {
    // kill-switch 重查是「保守终态修正」用途：registry 消失/坏/I/O 故障一律 fail-closed（视为不 active），
    // 绝不因读故障放行。故此处 catch loadRegistry 的 I/O throw（与 reserve 的 fail-loud 相反：reserve 要
    // round 整体失败，isActive 只要保守判不 active）。
    let reg: { data: LoopRegistry | null; errors: string[] }
    try {
      reg = loadRegistry(repoRoot)
    } catch {
      return false
    }
    if (reg.data === null) return false // registry 消失/坏 → fail-closed（视为不 active）
    const loop = reg.data.loops.find((l) => l.id === loopId)
    return loop !== undefined && loop.status === 'active'
  }
  const claimWithFreshWorkflowAuthority: ConfiguredLoopAdmission['claimWithFreshWorkflowAuthority'] =
    (context, claim) => claimWithFreshAfkWorkflowAuthority({
      context, bindAutomationPolicy, bindWorkflowActionAuthority,
      workflowActionAuthority, claim, clock, close, closeRecord,
    })
  return {
    reserve,
    claimWithFreshWorkflowAuthority,
    workflowAuthorityClaim: { version: 'v1', claim: claimWithFreshWorkflowAuthority },
    activate, recordProviderUsage, settleWon, settleLost,
    recordMergeIntent, recordMergeLanded, isActive,
  }
}
// H10 §3/§8任务5：prepareSkillBundle 编排——claim 成功（queued→scheduled）之后、activate
// （reservation-activated）之前调用（设计定稿精确顺序）。实现「解析 effective slots → 按声明顺序
// 定位内容 → 物化 CAS 快照 → governance→ledger 锁序复核 → 追加 skill-bundle-snapshot 事件」全部
// 步骤（设计 §3 步骤2-7）；「资源根目录」「workflow 坐标获取」等物理装配细节经 deps 注入，本函数
// 不硬编码任何具体 skill 根目录或 workflow 持久化形状（那是 H10 任务7 CLI 生产装配的职责）。
/**
 * `createExecutionPreparation` 的依赖面。刻意不直接注入 `WorkflowRunRepository`（那会让本模块
 * 理解 change 目录/workflow run 持久化形状，越界进 admission 从未涉足的领域）——只注入更高层的
 * `ExecutionCoordinatePort`，由生产装配（任务7）绑定真实 repository/workflow loader；本函数只消费
 * 其产出的 `CapturedExecutionCoordinate`。
 */
