/**
 * `tenon review request|acknowledge` —— review 出口的显式两阶段协议。
 *
 * request 只能在当前 workflow 声明为 review 的 step 调用：先将 pending receipt 原子写入
 * canonical state，再落 versioned hook marker。acknowledge 由 Codex UserPromptSubmit 或用户显式
 * CLI 调用，经 kernel 共享 application 写入 approved receipt 并清理 marker（review-acknowledge.ts）。transition 只消费 exact-phase-and-event approved
 * receipt: a decision to return from verify to build must never authorize verify-pass (or vice versa).
 */
import {
  evaluateDocumentEvidence,
  isDocumentContractPhase,
  isDocumentPolicyStep,
  resolveStep,
  stepExitTransitions,
  reviewGateApprovedFor,
  reviewGateMatches,
  reviewGatePendingFor,
  reviewGateRequestPatch,
  reviewGateStatus,
  reviewGateBindingMatches,
  readCurrentRunRevision,
  timestampAfter,
  INTERACTION_PROJECTION_WRITE_FAILED,
  assertOwner,
} from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { requireActor } from '../userIdentity.js'
import { refuseArchived } from '../archivedGuard.js'
import { cmdCheck } from './check.js'
import { recordHistory } from './fields.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { createInteractionCapture } from '../interaction-emitter.js'
import {
  readReviewGateBindingForRequest,
  refreshReviewGateBinding,
  writeReviewMarker,
} from './review-binding.js'
import { cmdReviewAcknowledge } from './review-acknowledge.js'
import { resolveReviewEvent as resolveReviewEventFromStep } from './review-event.js'

type ReviewStep = {
  readonly phase: string
  readonly workflow: string
  readonly executionModel: 'phase-manifest' | 'step-graph'
  readonly events: readonly string[]
}

export interface ReviewOpts {
  readonly event?: string
  /** Explicit user-delegated review confirmation for the active Change only. */
  readonly delegated?: boolean
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function resolveReviewStep(deps: CliDeps, state: PipelineState): ReviewStep {
  const phase = scalar(state, 'phase')
  const plan = effectiveWorkflowForState(deps, state)
  if (!plan) throw new Error(`workflow '${String(state.fields.workflow ?? '')}' 未找到或不可编译`)
  const step = resolveStep(plan.workflow, phase)
  if (!step) throw new Error(`step '${phase}' 不在 workflow '${plan.id}' 里`)
  if (step.gate !== 'review') throw new Error(`workflow '${plan.id}' 的 step '${phase}' 未声明 gate=review`)
  return {
    phase,
    workflow: plan.id,
    executionModel: plan.capabilities.execution.model,
    events: stepExitTransitions(plan, phase, state).map((transition) => transition.event),
  }
}

/**
 * `verify-fail` is an intentional rollback, not the successful verify exit. Its transition policy
 * deliberately has no success guards, so running `tenon check` here would make a failure path
 * impossible to review. We still require a real report and its governed OpenSpec evidence before
 * asking a human to select the rollback.
 */
async function checkVerifyFailReadiness(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
): Promise<number> {
  const blockers: string[] = []
  const report = scalar(state, 'verification_report')
  const fileExists = deps.guardCtx?.(name)?.fileExists
  if (report === '' || report === 'null') {
    blockers.push(`verify-fail 决策要求 verification_report 非空（当前='${report || 'null'}'）`)
  } else if (fileExists?.(report) === false) {
    blockers.push(`verify-fail 决策要求 verification_report 文件存在（当前='${report}'）`)
  }

  const plan = effectiveWorkflowForState(deps, state)
  const documentPolicy = plan?.capabilities.documents.policy
  if (documentPolicy) {
    const phase = scalar(state, 'phase')
    if (!isDocumentPolicyStep(documentPolicy, phase) || !isDocumentContractPhase(phase)) {
      blockers.push(`受 OpenSpec 文档契约治理的 workflow 当前 phase 非法（当前='${phase || '空'}'）`)
    } else {
      // A failure exit must remain possible precisely when implementation or upstream documents
      // drifted. Requiring the successful verify evidence set here deadlocks the only governed
      // route back to build. The rollback decision therefore requires the fresh, digest-bound
      // verification report only; the next successful exit re-evaluates the complete contract.
      const evidence = deps.documentEvidence
        ? await deps.documentEvidence(deps.cwd, dir, phase)
        : await evaluateDocumentEvidence(deps.cwd, dir, phase, {
          recordKinds: ['verification-report'],
          readKinds: [],
        }, documentPolicy)
      blockers.push(...evidence.blockers.map((blocker) => `document: ${blocker}`))
    }
  }

  deps.io.out(`[CHECK] ${name} (phase=verify, event=verify-fail)`)
  if (blockers.length === 0) {
    deps.io.out('  [PASS] verify-fail 回退证据已就绪')
    return 0
  }
  for (const blocker of blockers) deps.io.out(`  [FAIL] ${blocker}`)
  deps.io.out(`  [FAIL] 共 ${blockers.length} 项未通过`)
  return 2
}

async function checkReviewRequestReadiness(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  step: ReviewStep,
  event: string,
): Promise<number> {
  if (step.executionModel === 'phase-manifest' && step.phase === 'verify' && event === 'verify-fail') {
    return checkVerifyFailReadiness(deps, name, dir, state)
  }
  // A successful outgoing edge must satisfy the same public exit check that transition will
  // re-evaluate under its own lock. This keeps an agent from freezing knowingly incomplete output.
  return cmdCheck(
    deps,
    name,
    step.executionModel === 'step-graph' ? { event } : undefined,
  )
}

export async function cmdReview(
  deps: CliDeps,
  sub: string,
  name: string | undefined,
  opts: ReviewOpts = {},
): Promise<number> {
  if (sub !== 'request' && sub !== 'acknowledge') {
    deps.io.err('ERROR: 用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated]')
    return 1
  }
  if (!name || !isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name ?? ''}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  if (await refuseArchived(deps, name)) return 1
  const dir = changeDir(deps.cwd, name)
  const interaction = deps.interaction === undefined
    ? undefined
    : createInteractionCapture(deps.interaction, deps.clock)
  try {
    if (sub === 'request') {
      if (opts.delegated === true) {
        deps.io.err('ERROR: --delegated 只可用于 review acknowledge；request 仍必须先完成真实 review 证据')
        return 1
      }
      const actor = requireActor(deps)
      if (actor === null) return 1
      const preflight = await deps.store.read(dir)
      assertOwner(name, preflight.fields, actor)
      const preflightStep = resolveReviewStep(deps, preflight)
      const event = resolveReviewEventFromStep(preflightStep, opts.event)
      const check = await checkReviewRequestReadiness(deps, name, dir, preflight, preflightStep, event)
      if (check !== 0) return check
      let requested: {
        phase: string
        event: string
        requestedAt: string
        alreadyPending: boolean
        replacedReceipt: boolean
      } | undefined
      await deps.store.withLock(dir, async () => {
        const state = await deps.store.read(dir)
        assertOwner(name, state.fields, actor)
        const beforeRevision = interaction === undefined ? undefined : await readCurrentRunRevision(dir)
        const step = resolveReviewStep(deps, state)
        const lockedEvent = resolveReviewEventFromStep(step, opts.event)
        if (step.phase !== preflightStep.phase || lockedEvent !== event) {
          throw new Error('review request 期间当前 phase 或可选 event 已变化；请重新运行该命令')
        }
        const existingStatus = reviewGateStatus(state)
        if (existingStatus !== null && !reviewGateMatches(state, step.phase)) {
          throw new Error(`检测到属于 phase '${scalar(state, 'review_gate_phase')}' 的残留 review receipt；请先诊断 state 后重试`)
        }
        const existingBinding = await readReviewGateBindingForRequest(dir)
        const bindingMatches = reviewGateBindingMatches(existingBinding, state, step.phase, event)
        if (reviewGateApprovedFor(state, step.phase, event) && bindingMatches) {
          throw new Error(`phase '${step.phase}' 的 event '${event}' 已获确认；请直接执行该 transition，不能重复 request`)
        }
        const existingAt = scalar(state, 'review_requested_at')
        if (reviewGatePendingFor(state, step.phase, event) && bindingMatches) {
          await refreshReviewGateBinding(dir, state, step.phase, event, existingAt || deps.clock())
          requested = {
            phase: step.phase, event, requestedAt: existingAt || deps.clock(), alreadyPending: true, replacedReceipt: false,
          }
          if (interaction !== undefined && beforeRevision !== undefined) {
            try {
              await interaction.recordReviewRequested({
                changeDir: dir,
                changeName: name,
                state,
                revision: beforeRevision,
                beforeRevision,
                event,
                requestedAt: existingAt || deps.clock(),
                suppressed: true,
                clock: deps.clock(),
              })
            } catch (error) {
              deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} interaction projection 写入失败（canonical review pending 已存在）: ${errMsg(error)}`)
            }
          } else if (interaction !== undefined) {
            deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} interaction projection 未写入（缺 canonical run/workflow/state anchor；canonical review pending 未改变）`)
          }
          return
        }
        const requestedAt = timestampAfter(existingAt, deps.clock)
        const requestedState: PipelineState = {
          ...state,
          fields: { ...state.fields, ...reviewGateRequestPatch(step.phase, event, requestedAt) },
        }
        await deps.store.writeUnderLock(dir, requestedState, { kind: 'set-many' })
        await refreshReviewGateBinding(dir, requestedState, step.phase, event, requestedAt, { tolerateUnreadable: true })
        const afterRevision = interaction === undefined ? undefined : await readCurrentRunRevision(dir)
        if (interaction !== undefined && beforeRevision !== undefined && afterRevision !== undefined) {
          try {
            await interaction.recordReviewRequested({
              changeDir: dir,
              changeName: name,
              state: requestedState,
              revision: afterRevision,
              beforeRevision,
              event,
              requestedAt,
              clock: requestedAt,
            })
          } catch (error) {
            deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} interaction projection 写入失败（canonical review request 已提交）: ${errMsg(error)}`)
          }
        } else if (interaction !== undefined) {
          deps.io.err(`WARN: ${INTERACTION_PROJECTION_WRITE_FAILED} interaction projection 未写入（缺 canonical run/workflow/state anchor；canonical review request 已提交）`)
        }
        requested = {
          phase: step.phase,
          event,
          requestedAt,
          alreadyPending: false,
          // Replacing a different/legacy receipt can only revoke a prior decision; it always
          // creates a fresh pending request and therefore never grants the new event permission.
          replacedReceipt: existingStatus !== null,
        }
      })
      if (!requested) throw new Error('review request 未产生 receipt')
      const markerOk = await writeReviewMarker(deps, requested.phase, requested.event, name, requested.requestedAt)
      if (!requested.alreadyPending) {
        await recordHistory(deps, dir, {
          ts: requested.requestedAt,
          kind: 'tool',
          raw: `review:request phase=${requested.phase} event=${requested.event}${requested.replacedReceipt ? ' replaced=true' : ''}`,
        })
      }
      deps.io.out(
        `[REVIEW] ${name} phase=${requested.phase} event=${requested.event} ` +
        `${requested.alreadyPending ? '仍待确认' : '已请求人工确认'}`,
      )
      return markerOk ? 0 : 2
    }
    return await cmdReviewAcknowledge(deps, name, dir, opts)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}
