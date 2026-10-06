/**
 * `tenon verify --ci` 的单个任务：读已提交的状态与冻结工作流，校验每个用户目录下的记录链，
 * 用转换门禁同一份策略判定当前步骤，再做 CI 独有的检查（计划登记的测试文件、受保护文件的批准、锚点）。
 * 只读；任何一步读不出都变成该任务的 error 发现，不会静默当作通过。
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ChangedFilesUnavailableError, HISTORY_FILE, changeStartOfFields, evaluateAnchor, ownerOf, parseProtectedApprovals,
  protectedApprovalFindings, protectedChangesInSession, readTestPlanState,
  type AnchorEvidence, type CiChangeReport, type CiFinding, type CiText, type CiVerifyOptions, type ChangedFilesSession,
  type EffectiveWorkflowPlan, type PipelineState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { errMsg } from '../deps.js'
import { str } from '../render.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { NO_USER_SLUG, chainFindings, chainSummary, pickEvaluatedChain, readUserChains } from './verify-ci-chains.js'
import { resolveBaseRef } from './verify-ci-git.js'
import { policyFindings, resolveEvaluatedStep, runPolicy } from './verify-ci-policy.js'
import type { SelectedChange } from './verify-ci-select.js'
import { shallowReason, verifyMsg } from './verify-ci-text.js'

export interface VerifyContext {
  readonly deps: CliDeps
  readonly options: CiVerifyOptions
  /** 报告固定文案与 kernel 发现文案的文本源（语言取命令依赖面的 locale）。 */
  readonly text: CiText
  readonly stepOverride: string | undefined
  /** 本次检出的树的候选指纹（跨任务共用一次计算）；`--candidate off` 时 undefined。 */
  readonly candidate: (() => Promise<string>) | undefined
  readonly anchors: readonly AnchorEvidence[]
  readonly session: ChangedFilesSession
  readonly shallow: boolean
}

function ciFinding(change: string, code: string, severity: CiFinding['severity'], message: string, extra: Partial<CiFinding> = {}): CiFinding {
  return { code, severity, change, message, source: 'ci', ...extra }
}

function unreadable(selected: SelectedChange, message: string): CiChangeReport {
  return {
    change: selected.name, dir: selected.relDir, phase: null, step: null, policy: 'none', evaluatedUser: null,
    chains: [], anchor: 'none',
    findings: [ciFinding(selected.name, 'change-unreadable', 'error', message, { path: `${selected.relDir}/.pipeline.yaml` })],
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function planFileFindings(ctx: VerifyContext, selected: SelectedChange): Promise<readonly CiFinding[]> {
  const plan = await readTestPlanState(selected.dir, selected.name)
  if (plan.state !== 'ok') return []
  const out: CiFinding[] = []
  for (const file of plan.plan.files) {
    if (await exists(join(ctx.deps.cwd, ...file.path.split('/')))) continue
    out.push(ciFinding(selected.name, 'plan-file-missing', 'error',
      verifyMsg(ctx.deps, 'verify.planFileMissing', { file: file.path }),
      { path: `${selected.relDir}/test-plan.yaml`, subject: file.path, fix: `tenon test unregister ${selected.name} --file ${file.path}` }))
  }
  return out
}

async function protectedFindings(
  ctx: VerifyContext, selected: SelectedChange, state: PipelineState,
): Promise<readonly CiFinding[]> {
  const { deps } = ctx
  const unavailable = (why: string): readonly CiFinding[] => [ciFinding(
    selected.name, 'protected-diff-unavailable', 'error', verifyMsg(deps, 'verify.protectedDiffUnavailable', { why }),
    { path: `${selected.relDir}/.pipeline-history.jsonl` },
  )]
  if (ctx.shallow) return unavailable(shallowReason(deps))
  const start = changeStartOfFields(state.fields)
  let changes
  try {
    changes = await protectedChangesInSession(deps.cwd, ctx.session, { ...start, baseBranch: await resolveBaseRef(deps.cwd, start.baseBranch) })
  } catch (error) {
    return unavailable(error instanceof ChangedFilesUnavailableError ? error.message : errMsg(error))
  }
  if (changes.length === 0) return []
  const history = await readFile(join(selected.dir, HISTORY_FILE), 'utf8').catch(() => '')
  return protectedApprovalFindings({ change: selected.name, changes, approvals: parseProtectedApprovals(history), text: ctx.text })
}

export async function verifyChange(ctx: VerifyContext, selected: SelectedChange): Promise<CiChangeReport> {
  const { deps } = ctx
  let state: PipelineState
  let plan: EffectiveWorkflowPlan | null
  try {
    state = await deps.store.read(selected.dir)
    plan = effectiveWorkflowForState(deps, state)
  } catch (error) {
    return unreadable(selected, verifyMsg(deps, 'verify.changeUnreadable', { reason: errMsg(error) }))
  }
  if (plan === null) return unreadable(selected, verifyMsg(deps, 'verify.workflowUnresolved', { workflow: str(state.fields.workflow) }))
  const phase = str(state.fields.phase)
  const picked = resolveEvaluatedStep(deps, plan, phase, ctx.stepOverride)
  if ('error' in picked) {
    return { ...unreadable(selected, picked.error), phase, findings: [ciFinding(selected.name, 'step-unresolved', 'error', picked.error)] }
  }
  const owner = ownerOf(state.fields)
  const chains = await readUserChains(deps.cwd, selected.name)
  const evaluated = pickEvaluatedChain(deps, selected.name, owner?.slug ?? null, chains)
  const findings: CiFinding[] = []
  if (evaluated.finding !== undefined) findings.push(evaluated.finding)
  for (const chain of chains) findings.push(...chainFindings(deps, selected.name, chain, chain === evaluated.chain))

  let policy: CiChangeReport['policy'] = 'none'
  if (picked.step === null) {
    findings.push(ciFinding(selected.name, 'no-test-policy', 'note', verifyMsg(deps, 'verify.noTestPolicy', { phase: phase || verifyMsg(deps, 'verify.currentPhase') })))
  } else {
    const { report } = await runPolicy({
      deps, changeDir: selected.dir, change: selected.name, plan, stepId: picked.step, state,
      slug: evaluated.chain?.slug ?? NO_USER_SLUG, candidate: ctx.candidate, session: ctx.session, shallow: ctx.shallow,
    })
    const broken = evaluated.chain?.report
    findings.push(...await policyFindings({
      deps, report, change: selected.name, relDir: selected.relDir, recordsRelDir: evaluated.chain?.relDir ?? null,
      brokenFile: broken?.state === 'broken' && broken.files[0] !== undefined ? `${evaluated.chain?.relDir ?? ''}/${broken.files[0]}` : undefined,
      mode: ctx.options.candidate,
    }))
    policy = findings.some((item) => item.severity === 'error' && (item.source === 'policy')) ? 'fail' : 'pass'
  }
  if (ctx.options.candidate === 'off') {
    findings.push(ciFinding(selected.name, 'candidate-unchecked', 'note', verifyMsg(deps, 'verify.candidateUnchecked')))
  }
  findings.push(...await planFileFindings(ctx, selected))
  findings.push(...await protectedFindings(ctx, selected, state))
  const chain = evaluated.chain
  const anchor = evaluateAnchor({
    change: selected.name,
    user: chain?.slug ?? null,
    anchors: ctx.anchors.filter((item) => item.entry.change === selected.name),
    chain: chain?.report,
    baseDigest: chain?.listing.base?.base,
    requireAnchor: ctx.options.requireAnchor,
    text: ctx.text,
  })
  findings.push(...anchor.findings)
  return {
    change: selected.name, dir: selected.relDir, phase, step: picked.step, policy,
    evaluatedUser: chain?.slug ?? null, chains: chains.map(chainSummary), anchor: anchor.state, findings,
  }
}
