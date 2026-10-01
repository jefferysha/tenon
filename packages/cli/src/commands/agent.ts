/**
 * `tenon agent prompt | record`（`next` 在 agent-next.ts）—— 步骤 agent 的交接与登记。
 *
 * Tenon 只负责排顺序、渲染提示词、记录结论与校验候选版本；模型一律由宿主跑（父设计 §6）。
 * 没有 start / abandon：`prompt` 既开始也续跑，`next` 看状态。`prompt` 为当前宿主生成任务冻结 agent 的
 * 专属子代理文件（agent-host.ts），返回 `subagent_type`；库的增删改查在 agent-library.ts。
 *
 * 跨厂商评审：评审者在工作流步骤里声明 `host: codex|claude`（agent 定义可建议一个）时，`prompt` 指明该在哪个宿主上跑；
 * 当前宿主不是它，就把提示词写进文件并给出另一家 CLI 的确切命令（agent-route.ts）——Tenon 不替用户起那个 CLI。
 * `record` 记下登记时的宿主（进程环境判出，或 `--host` 声明）；步骤硬性要求的宿主不符，登记被拒（exit 2），
 * 判定层（kernel evaluateStepAgents）对已有记录同样按登记的宿主校验。候选绑定沿用：评审期间候选变了，登记被拒。
 *
 * exit 0 = 正常，1 = 用法 / IO / 记录损坏，2 = 被拦下（未轮到、宿主不支持、候选已变、宿主不符）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_REPORTS_DIR, KNOWN_AGENT_HOSTS,
  appendAgentRunRow, hostAgentName, hostRunValid, latestTestRun, nextAgentWave, parseAgentReport, renderAgentBlocker,
  reviewerHostRequirement, severityRank, sha256Hex,
} from '@tenon/kernel'
import type {
  AgentRunRow, AgentRunSubagent, AgentSeverity, HostAgentFileOutcome, TestRunRecordV1,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { ensureChangeHostAgents, fallbackOutcome, hostAgentHostOf } from './agent-host.js'
import { resolveAgentCommand, roleOf, type AgentContext } from './agent-context.js'
import { renderAgentPrompt } from './agent-prompt.js'
import { renderTestPolicySummary } from './agent-prompt-tests.js'
import { parseRerunReason, priorRunsOnCandidate, rerunRefusal } from './agent-rerun.js'
import { codexCommand, claudeCommand, hostSourceOf, planRoute, recordCommand, routeLines } from './agent-route.js'

export { cmdAgentNext } from './agent-next.js'

const REPORT_MAX_BYTES = 256 * 1024

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
  options: { readonly host?: string; readonly json?: boolean; readonly rerunReason?: string },
): Promise<number> {
  const rerunReason = parseRerunReason(deps, options.rerunReason)
  if (rerunReason === null) return 1
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
  // 执行宿主要求：步骤声明的（硬）优先，agent 定义的建议只用于路由。
  const stepHost = role === 'reviewer' ? context.step.reviewers.find((ref) => ref.agent === agent)?.host : undefined
  const requirement = reviewerHostRequirement(stepHost, role === 'reviewer' ? frozen.definition.host : undefined)
  const existing = context.runs.find((row) =>
    row.agent === agent && row.step_visit === context.stepVisit
    && row.status === 'running' && row.candidate === context.candidate)
  // 评审者防刷（F8）：同一份代码上已经有结论，再开一次必须写明原因；没有原因的重跑在判定里取最严结论。
  // 登记的宿主不符的评审是无效裁决，不算「已有结论」。
  const priorOnCandidate = role === 'reviewer' && existing === undefined
    ? priorRunsOnCandidate(context.runs, agent, context.stepVisit, context.candidate, stepHost)
    : []
  if (priorOnCandidate.length > 0 && rerunReason === undefined) {
    deps.io.err(rerunRefusal(name, agent, priorOnCandidate))
    return 2
  }
  const runId = existing?.run_id ?? randomUUID()
  const reportPath = join('openspec', 'changes', name, AGENT_REPORTS_DIR, `${runId}.md`)
  const promptFile = join('openspec', 'changes', name, AGENT_REPORTS_DIR, `${runId}.prompt.md`)
  const route = planRoute({ requirement, current: options.host ?? host, change: name, runId, promptFile })
  // 专属子代理 `tenon-<name>` 只在宿主文件确实生成（或已是同一份）时下发；否则退回通用子代理并记下。
  // 要去另一个宿主跑时，本宿主的子代理不参与，不记。
  const hostFile = host === undefined ? undefined : hostFiles.get(agent) ?? fallbackOutcome(host)
  const subagent: AgentRunSubagent | undefined = host === undefined || hostFile === undefined || route.runOn !== null
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
      ...(priorOnCandidate.length > 0 && rerunReason !== undefined ? { rerun_reason: rerunReason } : {}),
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
    ...(requirement.host === 'any' ? {} : { recordHost: requirement.host }),
  })
  if (route.runOn !== null) {
    try {
      await writeFile(join(deps.cwd, promptFile), prompt, 'utf8')
    } catch (e) {
      deps.io.err(`ERROR: ${errMsg(e)}`)
      return 1
    }
  }
  const used = existing?.subagent ?? subagent
  if (options.json === true) {
    deps.io.out(JSON.stringify({
      run_id: runId,
      agent,
      role,
      subagent_type: used?.type ?? null,
      native: used?.native ?? false,
      model: frozen.definition.model ?? null,
      tools: frozen.definition.tools,
      skills: frozen.definition.skills,
      hosts: frozen.definition.hosts ?? null,
      host: {
        required: route.required,
        source: route.source,
        enforced: route.enforced,
        current: route.current,
        run_on: route.runOn === null ? null : {
          host: route.runOn.host, command: route.runOn.command, prompt_file: route.runOn.promptFile, record: route.runOn.record,
        },
      },
      report_path: reportPath,
      prompt,
    }))
    return 0
  }
  if (route.runOn !== null) {
    for (const line of routeLines(agent, route)) deps.io.out(line)
    return 0
  }
  deps.io.out(prompt)
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
  options: { readonly subagent?: string; readonly host?: string } = {},
): Promise<number> {
  if (options.subagent !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.subagent)) {
    deps.io.err(`ERROR: --subagent '${options.subagent}' 非法`)
    return 1
  }
  if (options.host !== undefined && !KNOWN_AGENT_HOSTS.includes(options.host)) {
    deps.io.err(`ERROR: --host '${options.host}' 不是已知宿主（${KNOWN_AGENT_HOSTS.join(' | ')}）`)
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
  // 登记的宿主：进程环境判出的，或登记者用 --host 声明的（评审在另一个宿主里跑完、由原宿主登记时用它）。
  const detected = hostAgentHostOf(deps)
  const host = options.host ?? detected
  const stepHost = row.role === 'reviewer' ? context.step.reviewers.find((ref) => ref.agent === row.agent)?.host : undefined
  if (!hostRunValid(stepHost, host)) {
    const required = stepHost === 'claude' || stepHost === 'codex' ? stepHost : 'codex'
    const promptFile = join('openspec', 'changes', name, AGENT_REPORTS_DIR, `${row.run_id}.prompt.md`)
    deps.io.err(`ERROR: 评审者 '${row.agent}' 须在 ${required} 上运行，这次登记的宿主是 ${host ?? '未知（终端里请用 --host 声明）'}，结论无效、未登记；`
      + `在 ${required} 上运行：${required === 'codex' ? codexCommand(promptFile) : claudeCommand(promptFile)}；`
      + `评审写完报告后：${recordCommand(name, row.run_id, required)}`)
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
    ...(host === undefined ? {} : { host, host_source: hostSourceOf(options.host, detected) }),
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
      + (host === undefined ? '' : ` host=${host}${finished.host_source === 'declared' ? ' (声明)' : ''}`)
      + (subagent === undefined ? '' : ` subagent=${subagent.type}${subagent.native ? '' : ' (通用)'}`))
  return 0
}
