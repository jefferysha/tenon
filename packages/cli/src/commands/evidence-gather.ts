/**
 * `tenon evidence export` 的数据装配：把一个任务在某个提交上的事实读成 EvidenceBundle（kernel 里的纯数据）。
 * 只读。记录链必须完好——不为坏链或空链背书。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HISTORY_FILE, changeStartOfFields, createChangedFilesSession, isWorkspaceCandidatePath, linesToRanges, ownerOf, readAgentRuns,
  readTestPlanState,
  type EvidenceAgentRun, type EvidenceBundle, type EvidenceFileChange, type EvidenceRecordSummary, type EvidenceStepVisit,
  type PipelineState, type TestRunRecordV2,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { pickEvaluatedChain, readUserChains } from './verify-ci-chains.js'
import { resolveBaseRef } from './verify-ci-git.js'

const MAX_FILES = 2000

export type GatherResult =
  | { readonly ok: true; readonly bundle: EvidenceBundle }
  | { readonly ok: false; readonly code: number; readonly message: string }

function recordSummary(record: TestRunRecordV2): EvidenceRecordSummary {
  return {
    run_id: record.run_id, step: record.step, started_at: record.started_at, finished_at: record.finished_at,
    result: record.result, digest: record.digest,
    suites: record.suites.map((suite) => ({
      suite: suite.suite, kind: suite.kind, scope: suite.scope, result: suite.result, duration_ms: suite.duration_ms,
      totals: suite.totals, coverage_lines: suite.coverage?.lines ?? null,
    })),
  }
}

/** 历史里的转换行 → 步骤停留：第一条转换的 from 从创建时刻起，每次转换关上一段、开下一段。 */
export function stepVisitsFromHistory(historyText: string, createdAt: string | null): readonly EvidenceStepVisit[] {
  const seen = new Set<string>()
  const transitions: { from: string; to: string; ts: string }[] = []
  for (const line of historyText.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    const kind: unknown = Reflect.get(row, 'kind')
    const from: unknown = Reflect.get(row, 'from')
    const to: unknown = Reflect.get(row, 'to')
    const ts: unknown = Reflect.get(row, 'ts')
    const id: unknown = Reflect.get(row, 'transitionRecordId')
    if (kind !== 'transition' || typeof from !== 'string' || typeof to !== 'string' || typeof ts !== 'string') continue
    if (typeof id === 'string') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    transitions.push({ from, to, ts })
  }
  const first = transitions[0]
  if (first === undefined) return []
  const visits: { step: string; entered_at: string; left_at: string | null }[] = [
    { step: first.from, entered_at: createdAt ?? first.ts, left_at: null },
  ]
  for (const item of transitions) {
    const open = visits.at(-1)
    if (open !== undefined) open.left_at = item.ts
    visits.push({ step: item.to, entered_at: item.ts, left_at: null })
  }
  return visits
}

function agentRuns(rows: Awaited<ReturnType<typeof readAgentRuns>>): readonly EvidenceAgentRun[] {
  return rows.map((row) => ({
    run_id: row.run_id, agent: row.agent, role: row.role, step: row.step, result: row.result, findings: row.findings.length,
    started_at: row.started_at, finished_at: row.finished_at, host: row.subagent?.host ?? null,
  }))
}

async function changedFiles(deps: CliDeps, state: PipelineState): Promise<{ files: readonly EvidenceFileChange[]; truncated: boolean }> {
  const session = createChangedFilesSession(deps.cwd)
  const start = changeStartOfFields(state.fields)
  const lines = await session.changedLines({ ...start, baseBranch: await resolveBaseRef(deps.cwd, start.baseBranch) })
  const all = [...lines]
    .filter(([path]) => isWorkspaceCandidatePath(path))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return {
    files: all.slice(0, MAX_FILES).map(([path, set]) => ({ path, ranges: linesToRanges(set) })),
    truncated: all.length > MAX_FILES,
  }
}

export async function gatherEvidence(deps: CliDeps, input: {
  readonly change: string
  readonly dir: string
  readonly commit: string
  /** 指定哪个用户目录的链；缺省取任务负责人的。 */
  readonly user: string | undefined
  /** 是否需要文件与行区间（只有 Agent Trace 用）。 */
  readonly withFiles: boolean
}): Promise<GatherResult> {
  let state: PipelineState
  try {
    state = await deps.store.read(input.dir)
  } catch (error) {
    return { ok: false, code: 1, message: `任务状态读不出：${errMsg(error)}` }
  }
  const chains = await readUserChains(deps.cwd, input.change)
  const owner = ownerOf(state.fields)
  const chain = input.user === undefined
    ? pickEvaluatedChain(input.change, owner?.slug ?? null, chains).chain
    : chains.find((item) => item.slug === input.user)
  if (chain === undefined) {
    return { ok: false, code: 2, message: `任务 ${input.change} 没有可导出的测试记录链${input.user === undefined ? '（负责人没有记录；用 --user 指定用户目录）' : `（用户 ${input.user} 没有记录）`}` }
  }
  if (chain.report.state !== 'intact') {
    return { ok: false, code: 2, message: `用户 ${chain.slug} 的记录链${chain.report.state === 'broken' ? `已断（${chain.report.reason}）` : '是空的'}，拒绝导出：不为坏链背书` }
  }
  const history = await readFile(join(input.dir, HISTORY_FILE), 'utf8').catch(() => '')
  const plan = await readTestPlanState(input.dir, input.change)
  let changed: { files: readonly EvidenceFileChange[]; truncated: boolean } = { files: [], truncated: false }
  if (input.withFiles) {
    try {
      changed = await changedFiles(deps, state)
    } catch (error) {
      return { ok: false, code: 1, message: `读不出任务起点以来的改动文件：${errMsg(error)}` }
    }
  }
  const records = chain.report.active
  const last = records.at(-1)
  const createdAt = str(state.fields.created_at)
  return {
    ok: true,
    bundle: {
      tenon: deps.pluginVersion ?? 'unknown',
      change: input.change,
      workflow: str(state.fields.workflow) || 'default',
      track: str(state.fields.track),
      phase: str(state.fields.phase),
      owner: owner?.slug ?? null,
      created_at: createdAt === '' ? null : createdAt,
      exported_at: deps.clock(),
      commit: input.commit,
      chain: { user: chain.slug, head: chain.report.head, records: records.length },
      last_result: last?.result ?? 'fail',
      plan_digest: plan.state === 'ok' ? plan.digest : null,
      records: records.map(recordSummary),
      agents: agentRuns(await readAgentRuns(input.dir).catch(() => [])),
      steps: stepVisitsFromHistory(history, createdAt === '' ? null : createdAt),
      files: changed.files,
      files_truncated: changed.truncated,
    },
  }
}
