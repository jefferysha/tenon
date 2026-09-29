/**
 * `tenon agent next | prompt | record` —— 步骤 agent 的排定、交接与登记。
 *
 * Tenon 只负责排顺序、渲染提示词、记录结论与校验候选版本；模型一律由宿主跑（父设计 §6）。
 * 没有 start / abandon：`prompt` 既开始也续跑，`next` 看状态。`prompt` 为当前宿主生成任务冻结 agent 的
 * 专属子代理文件（agent-host.ts），返回 `subagent_type`；库的增删改查在 agent-library.ts。
 *
 * exit 0 = 正常，1 = 用法 / IO / 记录损坏，2 = 被拦下（未轮到、宿主不支持、候选已变）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_REPORTS_DIR,
  appendAgentRunRow, currentDocumentStepVisitId, evaluateStepAgents, latestTestRun,
  nextAgentWave, parseAgentReport, projectStepAgents, readAgentRuns, readFrozenAgents, renderAgentBlocker,
  severityRank, sha256Hex,
} from '@tenon/kernel'
import { hostAgentName } from '@tenon/kernel'
import type {
  AgentSeverity, AgentRunRow, AgentRunSubagent, AgentView, EffectiveWorkflowPlan, FrozenAgent, HostAgentFileOutcome,
  StepAgentsCapability, TestPolicyReport, TestRunRecordV1,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { ensureChangeHostAgents, fallbackOutcome, hostAgentHostOf } from './agent-host.js'
import { renderAgentPrompt } from './agent-prompt.js'
import { renderTestPolicySummary } from './agent-prompt-tests.js'
import { testsReadyFor } from './agent-tests-ready.js'
import { currentCandidate } from './candidate.js'
import { resolveChangeCommand, type TestCommandContext } from './test-context.js'

const REPORT_MAX_BYTES = 256 * 1024
const ROLE_WORD = { executor: '执行者', reviewer: '评审者' } as const
const STATE_WORD = { idle: '未运行', running: '进行中', done: '已完成', stale: '过期' } as const
const RESULT_WORD = { pass: '通过', fail: '不通过', done: '完成', failed: '失败' } as const

interface AgentContext extends TestCommandContext {
  readonly step: StepAgentsCapability
  readonly stepVisit: string
  readonly candidate: string
  readonly runs: readonly AgentRunRow[]
  readonly frozen: ReadonlyMap<string, FrozenAgent>
  readonly testsReady: { readonly ready: boolean; readonly pending: readonly string[] }
  /** 本步声明了 test_policy 时的策略判定（评审者提示词的 v2 测试摘要读它）。 */
  readonly testPolicy: TestPolicyReport | undefined
}

function stepAgentsOf(plan: EffectiveWorkflowPlan, stepId: string): StepAgentsCapability {
  return plan.capabilities.agents.steps.find((step) => step.stepId === stepId)
    ?? { stepId, executors: [], reviewers: [] }
}

async function resolveAgentCommand(
  deps: CliDeps,
  name: string,
  options: {
    readonly requireOwner: boolean
    /** 读完冻结内容、算候选之前的一步（生成宿主 agent 文件放在这里，候选不会因它而变）。 */
    readonly prepare?: (frozen: ReadonlyMap<string, FrozenAgent>) => Promise<void>
  },
): Promise<AgentContext | number> {
  const base = await resolveChangeCommand(deps, name, options)
  if (typeof base === 'number') return base
  const stepId = str(base.state.fields.phase)
  const step = stepAgentsOf(base.plan, stepId)
  const runId = base.state.runMetadata?.runId
  if (runId === undefined || runId === '') {
    deps.io.err(`ERROR: Change '${name}' 缺少 run 身份，无法记录 agent 运行`)
    return 1
  }
  try {
    const frozen = step.executors.length === 0 && step.reviewers.length === 0
      ? new Map<string, FrozenAgent>()
      : await readFrozenAgents({ changeDir: base.dir, runId, workflowFingerprint: base.plan.workflowFingerprint })
    await options.prepare?.(frozen)
    const tests = await testsReadyFor(deps, base, stepId)
    return {
      ...base,
      step,
      stepVisit: await currentDocumentStepVisitId(base.dir),
      candidate: await currentCandidate(deps, name, base.state, base.plan, stepId),
      runs: await readAgentRuns(base.dir),
      frozen,
      testsReady: tests.ready,
      testPolicy: tests.policy,
    }
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}

const viewJson = (view: AgentView, waiting: readonly { agent: string; for: readonly string[] }[]) => ({
  agent: view.agent,
  role: view.role,
  required: view.required,
  block_at: view.blockAt ?? null,
  depends_on: view.dependsOn,
  reads_tests: view.readsTests,
  state: view.state,
  result: view.result,
  findings: view.findings,
  blocking: view.blocking,
  run_id: view.runId,
  waiting_for: waiting.find((item) => item.agent === view.agent)?.for ?? [],
})

export async function cmdAgentNext(deps: CliDeps, name: string, json: boolean): Promise<number> {
  const context = await resolveAgentCommand(deps, name, { requireOwner: false })
  if (typeof context === 'number') return context
  const views = projectStepAgents(context)
  const { wave, waiting } = nextAgentWave(context)
  const verdict = evaluateStepAgents(context)
  if (json) {
    deps.io.out(JSON.stringify({
      change: name,
      step: context.step.stepId,
      step_visit: context.stepVisit,
      candidate: context.candidate,
      agents: views.map((view) => viewJson(view, waiting)),
      wave,
      pass: verdict.pass,
      // 与人读输出的「全部完成」同一判定：没有进行中的、没有在等的、离开判定通过。
      complete: wave.length === 0 && waiting.length === 0 && verdict.pass
        && views.every((view) => view.state !== 'running'),
      blockers: verdict.blockers,
    }))
    return 0
  }
  for (const view of views) {
    const result = view.result === null ? '' : ` ${RESULT_WORD[view.result]}`
    const findings = view.findings === 0 ? '' : ` 问题 ${view.findings}`
    deps.io.out(`${view.agent} ${ROLE_WORD[view.role]} ${STATE_WORD[view.state]}${result}${findings}`)
  }
  for (const line of waveSummary(name, views, wave, waiting, verdict)) deps.io.out(line)
  return 0
}

/**
 * 「下一波」为空不等于做完了：执行者 prompt 之后还没 record、评审者在等必需测试或别的 agent、
 * 必需评审者打回——这三种情况波次都是空的，从前一律印「全部完成」，运行器照信就走了。
 * 只有没有进行中的、没有在等的、且离开判定通过时才说全部完成；否则逐条说还差什么。
 */
function waveSummary(
  change: string,
  views: readonly AgentView[],
  wave: readonly string[],
  waiting: readonly { readonly agent: string; readonly for: readonly string[] }[],
  verdict: ReturnType<typeof evaluateStepAgents>,
): readonly string[] {
  if (wave.length > 0) return [`下一波：${wave.join(', ')}`]
  const lines: string[] = []
  for (const view of views) {
    if (view.state !== 'running') continue
    lines.push(`进行中：${view.agent}；完成后 tenon agent record ${change} ${view.runId ?? '<run>'}`)
  }
  for (const item of waiting) lines.push(`等待：${item.agent} ← ${item.for.join(', ')}`)
  if (lines.length === 0 && verdict.pass) return ['全部完成']
  if (lines.length === 0) {
    for (const blocker of verdict.blockers) lines.push(`未完成：${renderAgentBlocker(blocker, change)}`)
  }
  return lines
}

function roleOf(step: StepAgentsCapability, agent: string): 'executor' | 'reviewer' | undefined {
  if (step.executors.some((ref) => ref.agent === agent)) return 'executor'
  if (step.reviewers.some((ref) => ref.agent === agent)) return 'reviewer'
  return undefined
}

/**
 * 评审者声明了 `reads_tests` 时，附上目录套件最新运行的摘要（失败用例、flaky、覆盖率对照门槛、基准变化）。
 * `reads_tests` 是本步测试 id 的清单，非空即「这个评审者读测试结果」；没有声明就不附，提示词与之前逐字相同。
 */
function testSummaryFor(context: AgentContext, agent: string): readonly string[] {
  const reads = context.step.reviewers.find((ref) => ref.agent === agent)?.readsTests ?? []
  if (reads.length === 0) return []
  const policy = context.plan.workflow.steps.find((step) => step.id === context.step.stepId)?.test_policy
  return renderTestPolicySummary(context.testPolicy, policy?.coverage)
}

async function testsFor(
  deps: CliDeps,
  context: AgentContext,
  agent: string,
): Promise<readonly { readonly id: string; readonly run: TestRunRecordV1 | undefined }[]> {
  const ids = context.step.reviewers.find((ref) => ref.agent === agent)?.readsTests ?? []
  if (ids.length === 0) return []
  const workflowRunId = context.state.runMetadata?.runId ?? ''
  return Promise.all(ids.map(async (id) => ({
    id,
    run: await latestTestRun(deps.cwd, context.name, context.slug, id, workflowRunId),
  })))
}

export async function cmdAgentPrompt(
  deps: CliDeps,
  name: string,
  agent: string,
  options: { readonly host?: string; readonly json?: boolean },
): Promise<number> {
  const host = hostAgentHostOf(deps, options.host)
  let hostFiles: ReadonlyMap<string, HostAgentFileOutcome> = new Map()
  const context = await resolveAgentCommand(deps, name, {
    requireOwner: true,
    prepare: async (frozen) => {
      if (host !== undefined) hostFiles = await ensureChangeHostAgents(deps, host, frozen)
    },
  })
  if (typeof context === 'number') return context
  const role = roleOf(context.step, agent)
  if (role === undefined) {
    deps.io.err(`ERROR: agent '${agent}' 未在步骤 '${context.step.stepId}' 声明`)
    return 1
  }
  const frozen = context.frozen.get(agent)
  if (frozen === undefined) {
    deps.io.err(`ERROR: agent '${agent}' 未随本任务冻结；重新创建任务或改工作流`)
    return 1
  }
  if (options.host !== undefined && frozen.definition.hosts !== undefined
    && !frozen.definition.hosts.includes(options.host)) {
    deps.io.err(`ERROR: agent '${agent}' 不支持宿主 '${options.host}'`)
    return 2
  }
  const waiting = nextAgentWave(context).waiting.find((item) => item.agent === agent)
  if (waiting !== undefined) {
    deps.io.err(`ERROR: agent '${agent}' 还需等待：${waiting.for.join(', ')}`)
    return 2
  }
  const existing = context.runs.find((row) =>
    row.agent === agent && row.step_visit === context.stepVisit
    && row.status === 'running' && row.candidate === context.candidate)
  const runId = existing?.run_id ?? randomUUID()
  const reportPath = join('openspec', 'changes', name, AGENT_REPORTS_DIR, `${runId}.md`)
  // 专属子代理 `tenon-<name>` 只在宿主文件确实生成（或已是同一份）时下发；否则退回通用子代理并记下。
  const hostFile = host === undefined ? undefined : hostFiles.get(agent) ?? fallbackOutcome(host)
  const subagent: AgentRunSubagent | undefined = host === undefined || hostFile === undefined
    ? undefined
    : { host, type: hostFile.subagentType, native: hostFile.native }
  if (existing === undefined) {
    const row: AgentRunRow = {
      schema: 'agent-run/v1',
      run_id: runId,
      agent,
      agent_digest: frozen.digest,
      role,
      step: context.step.stepId,
      step_visit: context.stepVisit,
      candidate: context.candidate,
      status: 'running',
      result: null,
      findings: [],
      report_path: reportPath,
      report_digest: null,
      actor: context.actor,
      started_at: deps.clock(),
      finished_at: null,
      ...(subagent === undefined ? {} : { subagent }),
    }
    try {
      await mkdir(join(context.dir, AGENT_REPORTS_DIR), { recursive: true })
      await deps.store.withLock(context.dir, () => appendAgentRunRow(context.dir, row))
    } catch (e) {
      deps.io.err(`ERROR: ${errMsg(e)}`)
      return 1
    }
  }
  const blockAt = context.step.reviewers.find((ref) => ref.agent === agent)?.blockAt
  const stepPrompt = context.plan.workflow.steps.find((step) => step.id === context.step.stepId)?.prompt
  const prompt = renderAgentPrompt({
    change: name,
    step: context.step.stepId,
    role,
    runId,
    candidate: context.candidate,
    frozen,
    ...(blockAt === undefined ? {} : { blockAt }),
    reportPath,
    ...(stepPrompt === undefined ? {} : { stepPrompt }),
    tests: await testsFor(deps, context, agent),
    testSummary: testSummaryFor(context, agent),
  })
  const used = existing?.subagent ?? subagent
  deps.io.out(options.json === true
    ? JSON.stringify({
        run_id: runId,
        agent,
        role,
        subagent_type: used?.type ?? null,
        native: used?.native ?? false,
        model: frozen.definition.model ?? null,
        tools: frozen.definition.tools,
        skills: frozen.definition.skills,
        hosts: frozen.definition.hosts ?? null,
        report_path: reportPath,
        prompt,
      })
    : prompt)
  return 0
}

/**
 * 宿主实际用的子代理：prompt 时记下的是计划用的；专属子代理当场不可用（例如会话中途才生成、宿主
 * 还没加载）而退回通用子代理时，`--subagent <type>` 把实际用的记进结束行。
 */
function usedSubagent(deps: CliDeps, row: AgentRunRow, type: string | undefined): AgentRunSubagent | undefined {
  if (type === undefined) return row.subagent
  const host = row.subagent?.host ?? hostAgentHostOf(deps) ?? 'terminal'
  return { host, type, native: type === hostAgentName(row.agent) }
}

export async function cmdAgentRecord(
  deps: CliDeps,
  name: string,
  runId: string,
  json: boolean,
  options: { readonly subagent?: string } = {},
): Promise<number> {
  if (options.subagent !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.subagent)) {
    deps.io.err(`ERROR: --subagent '${options.subagent}' 非法`)
    return 1
  }
  const context = await resolveAgentCommand(deps, name, { requireOwner: true })
  if (typeof context === 'number') return context
  const row = context.runs.find((entry) => entry.run_id === runId)
  if (row === undefined || row.status !== 'running' || row.step_visit !== context.stepVisit) {
    deps.io.err(`ERROR: run '${runId}' 不是本次步骤访问中进行中的运行`)
    return 1
  }
  const reportPath = join(deps.cwd, row.report_path)
  let text: string
  try {
    const info = await stat(reportPath)
    if (info.size > REPORT_MAX_BYTES) {
      deps.io.err(`ERROR: 报告无效：超过 ${REPORT_MAX_BYTES} 字节`)
      return 1
    }
    text = await readFile(reportPath, 'utf8')
  } catch {
    deps.io.err(`ERROR: 报告无效：${row.report_path} 读不到`)
    return 1
  }
  let parsed
  try {
    parsed = parseAgentReport(text, row.role)
  } catch (e) {
    deps.io.err(`ERROR: 报告无效：${errMsg(e)}`)
    return 1
  }
  if (row.role === 'reviewer' && row.candidate !== context.candidate) {
    deps.io.err(`ERROR: 评审期间候选已变化；重跑：tenon agent prompt ${name} ${row.agent}`)
    return 2
  }
  // 评审结论由 Tenon 从 findings 与 block_at 算出，评审者自己不报；执行者自报 done | failed。
  const blockAt: AgentSeverity = context.step.reviewers.find((ref) => ref.agent === row.agent)?.blockAt ?? 'high'
  const blocking = row.role === 'reviewer'
    ? parsed.findings.filter((finding) => severityRank(finding.severity) >= severityRank(blockAt)).length
    : 0
  const subagent = usedSubagent(deps, row, options.subagent)
  const finished: AgentRunRow = {
    ...row,
    ...(subagent === undefined ? {} : { subagent }),
    status: 'finished',
    result: row.role === 'reviewer' ? (blocking > 0 ? 'fail' : 'pass') : parsed.result ?? 'failed',
    findings: parsed.findings,
    report_digest: `sha256:${sha256Hex(text)}`,
    finished_at: deps.clock(),
  }
  try {
    await deps.store.withLock(context.dir, () => appendAgentRunRow(context.dir, finished))
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  deps.io.out(json
    ? JSON.stringify({ ...finished, blocking })
    : `[AGENT] ${name} ${row.agent} ${row.role} result=${finished.result}`
      + ` findings=${parsed.findings.length} blocking=${blocking}`
      + (subagent === undefined ? '' : ` subagent=${subagent.type}${subagent.native ? '' : ' (通用)'}`))
  return 0
}
