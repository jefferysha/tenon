/**
 * `tenon verify --ci` 的策略判定部分：选出判定用的步骤，用与转换门禁同一份代码（evaluateTestEvidence）
 * 判定当前步骤策略，再把阻塞 / 提示映射成带位置的发现。CI 里不读本机封存（seal: 'none'），
 * 候选代码指纹取自本次检出的树。
 */
import {
  ChangedFilesUnavailableError, changeStartOfFields, evaluateTestEvidence,
  type CandidateMode, type ChangedFilesSession, type CiFinding, type EffectiveWorkflowPlan, type PipelineState,
  type SuiteVerdict, type TestEvidenceReport,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { candidateFilesTouchedSince, resolveBaseRef } from './verify-ci-git.js'

type Step = EffectiveWorkflowPlan['workflow']['steps'][number]

function declaresTests(step: Step): boolean {
  return (step.tests?.length ?? 0) > 0 || step.test_policy !== undefined
}

/**
 * 判定用的步骤：显式指定的；否则当前 phase，它没有声明测试时取它之前最近一个声明了的步骤
 * （已完结的任务停在终态步骤，证据在 verify）。phase 不在步骤表里（状态异常）时取最后一个声明了的步骤。
 */
export function resolveEvaluatedStep(
  plan: EffectiveWorkflowPlan,
  phase: string,
  override: string | undefined,
): { readonly step: string | null } | { readonly error: string } {
  const steps = plan.workflow.steps
  if (override !== undefined) {
    return steps.some((step) => step.id === override) ? { step: override } : { error: `step '${override}' 不在 workflow '${plan.id}' 里` }
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
        if (input.shallow) throw new ChangedFilesUnavailableError('浅克隆缺少任务起点之前的历史（actions/checkout 需要 fetch-depth: 0）')
        return input.session.changedFiles({ ...start, baseBranch: await resolveBaseRef(deps.cwd, start.baseBranch) })
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

export async function policyFindings(input: {
  readonly deps: CliDeps
  readonly report: TestEvidenceReport
  readonly change: string
  readonly relDir: string
  readonly recordsRelDir: string | null
  /** 判定用的链断了时，第一个出问题的记录文件（仓库相对路径）。 */
  readonly brokenFile: string | undefined
  readonly mode: CandidateMode
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
      code: blocker.code, severity: blocker.blocking ? 'error' : 'warning', change, source: 'policy', message: blocker.message,
      ...(blocker.fix === undefined ? {} : { fix: blocker.fix }),
      ...(blocker.subject === undefined ? {} : { subject: blocker.subject }),
      ...(path === undefined ? {} : { path }),
    })
  }
  for (const notice of policy?.notices ?? []) {
    const path = pathFor(notice.code, notice.subject, relDir, recordFile(notice.subject), input.brokenFile)
    out.push({
      code: notice.code, severity: 'note', change, source: 'policy', message: notice.message,
      ...(notice.fix === undefined ? {} : { fix: notice.fix }),
      ...(notice.subject === undefined ? {} : { subject: notice.subject }),
      ...(path === undefined ? {} : { path }),
    })
  }
  if (candidateStale.length > 0) out.push(await candidateFinding(input, candidateStale, recordFile(candidateStale[0]?.suite)))
  if (policy === undefined) {
    for (const item of report.items) {
      if (!item.test.required || item.status === 'passed') continue
      out.push({
        code: item.status === 'stale' ? 'test-stale' : item.status === 'failed' ? 'test-failed' : 'test-not-run',
        severity: 'error', change, source: 'policy', subject: item.test.id,
        message: `测试 ${item.test.label ?? item.test.id}（${item.test.id}）状态 ${item.status}`,
        fix: `tenon test run ${change} ${item.test.id}`,
      })
    }
  }
  return out
}

async function candidateFinding(
  input: { readonly deps: CliDeps; readonly change: string; readonly mode: CandidateMode },
  stale: readonly SuiteVerdict[],
  path: string | undefined,
): Promise<CiFinding> {
  const earliest = stale.map((verdict) => verdict.finished_at).filter((value): value is string => value !== undefined).sort()[0]
  const touched = earliest === undefined ? [] : await candidateFilesTouchedSince(input.deps.cwd, earliest)
  const hint = touched.length === 0 ? '' : `；记录完成之后提交改动过：${touched.join('、')}`
  return {
    code: 'candidate-mismatch', severity: input.mode === 'warn' ? 'warning' : 'error', change: input.change, source: 'policy',
    subject: stale.map((verdict) => verdict.suite).join(','),
    message: `套件 ${stale.map((verdict) => verdict.suite).join('、')} 的最近一次运行绑定的代码与本次检出的树不同（代码在测试之后变了，或检出的树与测试时的工作区不一致）${hint}`,
    fix: `tenon test run ${input.change} --stage`,
    ...(path === undefined ? {} : { path }),
  }
}
