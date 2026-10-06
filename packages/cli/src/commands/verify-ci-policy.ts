/**
 * `tenon verify --ci` 的策略判定部分：选出判定用的步骤，用与转换门禁同一份代码（evaluateTestEvidence）
 * 判定当前步骤策略，再把阻塞 / 提示映射成带位置的发现。CI 里不读本机封存（seal: 'none'），
 * 候选代码指纹取自本次检出的树。
 */
import {
  ChangedFilesUnavailableError, TEST_BLOCKER_LABELS, TEST_NOTICE_LABELS, changeStartOfFields, declaredTestOutputs, evaluateTestEvidence,
  integrityDiffInSession,
  type CandidateMode, type ChangedFilesSession, type CiFinding, type EffectiveWorkflowPlan, type PipelineState,
  type SuiteVerdict, type TestEvidenceReport, type TestRunRecordV2,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { localeOf } from '../i18n/messages.js'
import { candidateClues, resolveBaseRef } from './verify-ci-git.js'
import { shallowReason, verifyMsg } from './verify-ci-text.js'

type Step = EffectiveWorkflowPlan['workflow']['steps'][number]

function declaresTests(step: Step): boolean {
  return (step.tests?.length ?? 0) > 0 || step.test_policy !== undefined
}

/**
 * 判定用的步骤：显式指定的；否则当前 phase，它没有声明测试时取它之前最近一个声明了的步骤
 * （已完结的任务停在终态步骤，证据在 verify）。phase 不在步骤表里（状态异常）时取最后一个声明了的步骤。
 */
export function resolveEvaluatedStep(
  deps: CliDeps,
  plan: EffectiveWorkflowPlan,
  phase: string,
  override: string | undefined,
): { readonly step: string | null } | { readonly error: string } {
  const steps = plan.workflow.steps
  if (override !== undefined) {
    return steps.some((step) => step.id === override) ? { step: override } : { error: verifyMsg(deps, 'verify.stepNotInWorkflow', { step: override, workflow: plan.id }) }
  }
  const index = steps.findIndex((step) => step.id === phase)
  const from = index === -1 ? steps.length - 1 : index
  for (let i = from; i >= 0; i--) {
    const step = steps[i]
    if (step !== undefined && declaresTests(step)) return { step: step.id }
  }
  return { step: null }
}

export interface PolicyRun {
  readonly report: TestEvidenceReport
}

export async function runPolicy(input: {
  readonly deps: CliDeps
  readonly changeDir: string
  readonly change: string
  readonly plan: EffectiveWorkflowPlan
  readonly stepId: string
  readonly state: PipelineState
  readonly slug: string
  readonly candidate: (() => Promise<string>) | undefined
  readonly session: ChangedFilesSession
  readonly shallow: boolean
}): Promise<PolicyRun> {
  const { deps } = input
  const start = changeStartOfFields(input.state.fields)
  const report = await evaluateTestEvidence({
    repoRoot: deps.cwd,
    changeDir: input.changeDir,
    changeName: input.change,
    plan: input.plan,
    stepId: input.stepId,
    context: {
      user: { id: input.slug, name: input.slug, slug: input.slug },
      seal: 'none',
      now: () => Date.parse(deps.clock()),
      ...(input.candidate === undefined ? {} : { currentCandidate: input.candidate }),
      changedFiles: async () => {
        if (input.shallow) throw new ChangedFilesUnavailableError(shallowReason(deps))
        return input.session.changedFiles({ ...start, baseBranch: await resolveBaseRef(deps.cwd, start.baseBranch) })
      },
      // 测试完整性：与转换门禁同一份判定（`integrity: block` 挡住，缺省 notice 只提示）；读不出起点以来的改动行时
      // 由策略失败关闭（block → files-diff-unavailable）或提示未检查（notice → files-unchecked），不降级成「没有信号」。
      integrityDiff: async (accept) => {
        if (input.shallow) throw new ChangedFilesUnavailableError(shallowReason(deps))
        return integrityDiffInSession(input.session, { ...start, baseBranch: await resolveBaseRef(deps.cwd, start.baseBranch) })(accept)
      },
    },
  })
  return { report }
}

/** 阻塞 / 提示可能指向的文件（SARIF 位置）；不知道时缺省，渲染层落在任务的 .pipeline.yaml。 */
function pathFor(code: string, subject: string | undefined, relDir: string, recordFile: string | undefined, brokenFile: string | undefined): string | undefined {
  if (code === 'record-chain-broken') return brokenFile
  if (code === 'test-plan-missing' || code === 'test-plan-tampered' || code === 'waiver-unapproved') return `${relDir}/test-plan.yaml`
  if (code === 'test-catalog-missing' || code === 'test-kind-missing') return '.tenon/tests/catalog.yaml'
  if (code.startsWith('protected-file-') || code.startsWith('test-file-') || code.startsWith('known-failure-')) {
    return code.startsWith('known-failure-') ? '.tenon/tests/known-failures.yaml' : subject
  }
  return recordFile
}

type PolicyKind = 'blocker' | 'notice'

/**
 * 策略判定给的阻塞 / 提示句子是中文（测试体系的判定在 kernel 里，句子里带着具体对象与原因）。中文输出原样用它；
 * 英文输出用同一个码的英文短标签加上它指向的对象（套件 id、文件路径等），修复命令照原样列在 `fix` 里。
 */
function policyMessage(deps: CliDeps, kind: PolicyKind, code: string, message: string, subject: string | undefined): string {
  if (localeOf(deps) === 'zh') return message
  const labels: Readonly<Record<string, { readonly en: string } | undefined>> = kind === 'blocker' ? TEST_BLOCKER_LABELS : TEST_NOTICE_LABELS
  const label = labels[code]?.en ?? code
  return subject === undefined ? label : `${label}: ${subject}`
}

export async function policyFindings(input: {
  readonly deps: CliDeps
  readonly report: TestEvidenceReport
  readonly change: string
  readonly relDir: string
  readonly recordsRelDir: string | null
  /** 判定用的链断了时，第一个出问题的记录文件（仓库相对路径）。 */
  readonly brokenFile: string | undefined
  readonly mode: CandidateMode
  /** 判定用的链上的记录：候选不一致的线索要读记录里的 `git_head`。 */
  readonly records: readonly TestRunRecordV2[]
}): Promise<readonly CiFinding[]> {
  const { report, change, relDir } = input
  const out: CiFinding[] = []
  const policy = report.policy
  const verdicts = new Map<string, SuiteVerdict>((policy?.suites ?? []).map((suite) => [suite.suite, suite]))
  const recordFile = (suite: string | undefined): string | undefined => {
    const runId = suite === undefined ? undefined : verdicts.get(suite)?.run_id
    return runId === undefined || input.recordsRelDir === null ? undefined : `${input.recordsRelDir}/${runId}.json`
  }
  const candidateStale: SuiteVerdict[] = []
  for (const blocker of policy?.blockers ?? []) {
    const verdict = blocker.subject === undefined ? undefined : verdicts.get(blocker.subject)
    if (blocker.code === 'test-stale' && verdict?.staleBecause?.length === 1 && verdict.staleBecause[0] === 'candidate') {
      candidateStale.push(verdict)
      continue
    }
    const path = pathFor(blocker.code, blocker.subject, relDir, recordFile(blocker.subject), input.brokenFile)
    out.push({
      code: blocker.code, severity: blocker.blocking ? 'error' : 'warning', change, source: 'policy',
      message: policyMessage(input.deps, 'blocker', blocker.code, blocker.message, blocker.subject),
      ...(blocker.fix === undefined ? {} : { fix: blocker.fix }),
      ...(blocker.subject === undefined ? {} : { subject: blocker.subject }),
      ...(path === undefined ? {} : { path }),
    })
  }
  for (const notice of policy?.notices ?? []) {
    const path = pathFor(notice.code, notice.subject, relDir, recordFile(notice.subject), input.brokenFile)
    out.push({
      code: notice.code, severity: 'note', change, source: 'policy',
      message: policyMessage(input.deps, 'notice', notice.code, notice.message, notice.subject),
      ...(notice.fix === undefined ? {} : { fix: notice.fix }),
      ...(notice.subject === undefined ? {} : { subject: notice.subject }),
      ...(path === undefined ? {} : { path }),
    })
  }
  if (candidateStale.length > 0) out.push(await candidateFinding({ ...input, change }, candidateStale, recordFile(candidateStale[0]?.suite)))
  if (policy === undefined) {
    for (const item of report.items) {
      if (!item.test.required || item.status === 'passed') continue
      out.push({
        code: item.status === 'stale' ? 'test-stale' : item.status === 'failed' ? 'test-failed' : 'test-not-run',
        severity: 'error', change, source: 'policy', subject: item.test.id,
        message: verifyMsg(input.deps, 'verify.testStatus', { label: item.test.label ?? item.test.id, id: item.test.id, status: item.status }),
        fix: `tenon test run ${change} ${item.test.id}`,
      })
    }
  }
  return out
}

async function candidateFinding(
  input: { readonly deps: CliDeps; readonly change: string; readonly mode: CandidateMode; readonly records: readonly TestRunRecordV2[] },
  stale: readonly SuiteVerdict[],
  path: string | undefined,
): Promise<CiFinding> {
  const { deps } = input
  const earliest = [...stale].filter((verdict) => verdict.finished_at !== undefined)
    .sort((left, right) => (left.finished_at ?? '') < (right.finished_at ?? '') ? -1 : 1)[0]
  const record = earliest?.run_id === undefined ? undefined : input.records.find((item) => item.run_id === earliest.run_id)
  const sep = verifyMsg(deps, 'verify.listSep')
  const list = (files: readonly string[], more: number): string => `${files.join(sep)}${more > 0 ? verifyMsg(deps, 'verify.listMore', { count: more }) : ''}`
  const clues = earliest?.finished_at === undefined
    ? undefined
    : await candidateClues(deps.cwd, { gitHead: record?.git_head ?? null, finishedAt: earliest.finished_at, declared: await declaredTestOutputs(deps.cwd) })
  const parts: string[] = []
  if (clues?.followedBy !== undefined && clues.changedLater.length > 0) {
    parts.push(verifyMsg(deps, 'verify.candidateChangedLater', { commit: clues.followedBy, files: list(clues.changedLater, clues.changedLaterMore) }))
  } else {
    parts.push(verifyMsg(deps, clues?.followedBy === undefined ? 'verify.candidateWorkspaceCauses' : 'verify.candidateNothingLater',
      clues?.followedBy === undefined ? {} : { commit: clues.followedBy }))
  }
  if (clues !== undefined && clues.extraHere.length > 0) {
    parts.push(verifyMsg(deps, 'verify.candidateExtraHere', { files: list(clues.extraHere, clues.extraHereMore) }))
  }
  return {
    code: 'candidate-mismatch', severity: input.mode === 'warn' ? 'warning' : 'error', change: input.change, source: 'policy',
    subject: stale.map((verdict) => verdict.suite).join(','),
    message: verifyMsg(deps, 'verify.candidateMismatch', { suites: stale.map((verdict) => verdict.suite).join(sep), hint: parts.join('') }),
    fix: `tenon test run ${input.change} --stage`,
    ...(path === undefined ? {} : { path }),
  }
}
