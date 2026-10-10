/**
 * 剩余阻断：验证轮次上限用完后，必需评审者在当前候选上仍然不通过，用户在评审确认里明确接受它们，任务才能带着这些
 * 未解决的发现前进。这里是它的数据面（纯函数）：评审请求时冻结的待接受项、确认后落下的接受记录，以及它们的严格解码。
 *
 * 两类数据都存在评审冻结清单的边车 `.pipeline-review-waivers.json`（review-waivers.ts）里——它是 gate 已经保护的写入位置
 * （agent 的编辑类工具与 shell 写入都被拒，只有 `tenon review` 在 Change 锁内写），不另起一个没有写保护的新文件：
 *   · `residual`：待接受项（请求时冻结，绑定那一次请求，确认后清掉）；
 *   · `accepted`：接受记录（跨请求保留，每个评审者只留最新一条，总数有上限）。
 *
 * 接受绑定**评审者 + 被接受的那次运行 id + 当时的代码候选**（kernel `evaluateStepAgents` 逐项核对）：代码变了，或评审者
 * 有了新的判定运行（包括同一候选上带 `--rerun-reason` 的重跑），旧的接受自然对不上、不再生效。剩余阻断只覆盖评审者；
 * 失败的必需测试仍走步骤测试豁免。解码失败一律当作没有记录（失败关闭：什么都不接受）。
 */
import { AGENT_NAME_RE } from '../agents/types.js'
import type { AcceptedResidualRef, AgentBlocker } from '../workflow/agent-verdict.js'
import { formatAuditDetail } from './audit.js'
import { hasUnsafeDisplayChars, waiverReasonText } from './step-test-waivers.js'

export const RESIDUAL_KEY_PREFIX = 'reviewer:'
/** 边车里最多保留的接受记录数（最旧的先丢），边车文件不会无界增长。 */
export const MAX_ACCEPTED_RESIDUALS = 20
/** 一项待接受项最多带几条发现摘要。 */
export const RESIDUAL_SUMMARY_MAX = 5

const CANDIDATE_RE = /^(?:sha256:|workspace:sha256:)[0-9a-f]{64}$|^git:[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SUMMARY_LINE_MAX = 400

/** 请求时冻结的一项待接受的剩余阻断。 */
export interface FrozenResidual {
  /** `reviewer:<agent>`。 */
  readonly key: string
  /** 判定所依据的那次评审运行。 */
  readonly runId: string
  /** 评审时的代码候选（当前候选）。 */
  readonly candidate: string
  /** 阻断级发现数。 */
  readonly findings: number
  /** 阻断级发现的单行摘要（`<级别> <位置> <说明>`，最多 5 条，已清洗）。 */
  readonly summary: readonly string[]
}

/** 确认之后落下的接受记录。 */
export interface ResidualAcceptance {
  readonly key: string
  readonly runId: string
  readonly candidate: string
  readonly findings: number
  readonly acceptedBy: string
  readonly acceptedAt: string
}

/**
 * 本次确认刚落下的接受：接受记录 + 冻结时的发现摘要。摘要只用于任务历史行，不写进边车的接受记录
 * （边车里的 `accepted` 保持固定形状，解码是严格的）。
 */
export interface AcceptedResidual extends ResidualAcceptance {
  readonly summary: readonly string[]
}

export function residualKey(agent: string): string {
  return `${RESIDUAL_KEY_PREFIX}${agent}`
}

/** `reviewer:<agent>` → agent；不是剩余阻断的键（或 agent 名非法）为 undefined。 */
export function residualAgent(key: string): string | undefined {
  if (!key.startsWith(RESIDUAL_KEY_PREFIX)) return undefined
  const agent = key.slice(RESIDUAL_KEY_PREFIX.length)
  return AGENT_NAME_RE.test(agent) ? agent : undefined
}

/**
 * 判定里「评审者不通过」的阻断 → 待接受项。只有带运行 id 与候选的才能绑定，缺一不冻结（接受无从落到具体的一次运行上）。
 * 评审者的发现是评审者（常是模型）写的文字，展示前折成单行、截短，去掉能伪造代码块或标签的字符，
 * 以及 C0 / C1 控制字符与双向覆盖 / 隔离字符（终端转义序列、文字方向反转）。
 */
export function residualFromBlockers(blockers: readonly AgentBlocker[]): readonly FrozenResidual[] {
  const items: FrozenResidual[] = []
  for (const blocker of blockers) {
    if (blocker.kind !== 'reviewer-failed' || blocker.runId === undefined || blocker.candidate === undefined) continue
    if (!AGENT_NAME_RE.test(blocker.agent) || blocker.blocking.length === 0) continue
    items.push({
      key: residualKey(blocker.agent),
      runId: blocker.runId,
      candidate: blocker.candidate,
      findings: blocker.blocking.length,
      summary: blocker.blocking.slice(0, RESIDUAL_SUMMARY_MAX)
        .map((finding) => waiverReasonText(`${finding.severity} ${finding.location} ${finding.message}`)),
    })
  }
  return items
}

/** 逐条列给用户的行（`review request` 输出；与豁免的列出同一风格）。 */
export function residualLines(items: readonly FrozenResidual[]): readonly string[] {
  if (items.length === 0) return []
  return [
    `[REVIEW] 待接受的剩余阻断 ${items.length} 项（验证轮次已用完；用户的确认同时接受下列评审者仍然不通过的结论，`
      + '接受只对所列的那次运行和代码候选有效，代码再变或评审者有新的运行就要重新确认。请连同发现一并展示给用户）：',
    ...items.flatMap((item) => [
      `  ${item.key} — ${item.findings} 个阻断级发现（运行 ${item.runId}，候选 ${item.candidate}）`,
      ...item.summary.map((line) => `    · ${line}`),
    ]),
  ]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameKeys(item: Record<string, unknown>, expected: string): boolean {
  return Object.keys(item).sort().join(',') === expected
}

function decodeBinding(item: Record<string, unknown>): { key: string; runId: string; candidate: string; findings: number } | undefined {
  const key = text(item.key)
  const runId = text(item.runId)
  const candidate = text(item.candidate)
  if (key === undefined || residualAgent(key) === undefined) return undefined
  if (runId === undefined || !RUN_ID_RE.test(runId)) return undefined
  if (candidate === undefined || !CANDIDATE_RE.test(candidate)) return undefined
  if (typeof item.findings !== 'number' || !Number.isInteger(item.findings) || item.findings < 1) return undefined
  return { key, runId, candidate, findings: item.findings }
}

/**
 * 待接受项的严格解码：键名、运行 id、候选、发现数、摘要的形状有一处不对，整组读不出。
 * 摘要里含控制字符或双向覆盖 / 隔离字符（冻结时已去掉，出现只可能是手工改过清单）同样整份拒收。
 */
export function decodeResidual(value: unknown): readonly FrozenResidual[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: FrozenResidual[] = []
  for (const raw of value as unknown[]) {
    if (!isObject(raw) || !sameKeys(raw, 'candidate,findings,key,runId,summary')) return undefined
    const binding = decodeBinding(raw)
    const summary = raw.summary
    if (binding === undefined || !Array.isArray(summary) || summary.length > RESIDUAL_SUMMARY_MAX) return undefined
    const lines: string[] = []
    for (const line of summary as unknown[]) {
      if (typeof line !== 'string' || line === '' || line.length > SUMMARY_LINE_MAX || hasUnsafeDisplayChars(line)) return undefined
      lines.push(line)
    }
    out.push({ ...binding, summary: lines })
  }
  return out
}

/** 接受记录的严格解码（同上，失败关闭；确认人与时间也不许含控制字符或双向字符，它们会进历史行与提示）。 */
export function decodeAccepted(value: unknown): readonly ResidualAcceptance[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ACCEPTED_RESIDUALS) return undefined
  const out: ResidualAcceptance[] = []
  for (const raw of value as unknown[]) {
    if (!isObject(raw) || !sameKeys(raw, 'acceptedAt,acceptedBy,candidate,findings,key,runId')) return undefined
    const binding = decodeBinding(raw)
    const acceptedBy = text(raw.acceptedBy)
    const acceptedAt = text(raw.acceptedAt)
    if (binding === undefined || acceptedBy === undefined || acceptedAt === undefined) return undefined
    if (hasUnsafeDisplayChars(acceptedBy) || hasUnsafeDisplayChars(acceptedAt)) return undefined
    out.push({ ...binding, acceptedBy, acceptedAt })
  }
  return out
}

/**
 * 把冻结的待接受项落成接受记录。同一评审者只留最新一条（再次被接受就替换旧的）；超过上限丢最旧的。
 * 重试同一次确认得到同一份结果（幂等）。`added` 另带冻结时的发现摘要（历史行用），`all`（写进边车）不带。
 */
export function acceptFrozenResiduals(input: {
  readonly frozen: readonly FrozenResidual[]
  readonly existing: readonly ResidualAcceptance[] | undefined
  readonly acceptedBy: string
  readonly acceptedAt: string
}): { readonly added: readonly AcceptedResidual[]; readonly all: readonly ResidualAcceptance[] } {
  const records: ResidualAcceptance[] = input.frozen.map((item) => ({
    key: item.key, runId: item.runId, candidate: item.candidate, findings: item.findings,
    acceptedBy: input.acceptedBy, acceptedAt: input.acceptedAt,
  }))
  const kept = (input.existing ?? []).filter((old) => !records.some((item) => item.key === old.key))
  return {
    added: records.map((record, index) => ({ ...record, summary: input.frozen[index]?.summary ?? [] })),
    all: [...kept, ...records].slice(-MAX_ACCEPTED_RESIDUALS),
  }
}

/**
 * 任务历史里的接受行：`review.residual-accepted reviewer=… run=… candidate=… findings=… by=… summary=…`
 * （kind `tool`，与豁免批准的 `test:waiver-approve …` 同一形态；CLI 与 Dashboard 的确认共用）。
 *
 * `summary=` 是冻结时的发现摘要，最多 5 条，各条用 `|` 连接；条内空白折成 `_`（审计行的统一写法），
 * 条内的 `|` 换成全角 `｜`，所以整行仍是一行、可按 `|` 拆回各条。这里再清洗一遍（控制字符、超长、反引号与尖括号），
 * 不依赖调用方传来的已经干净。没有摘要时不带 `summary=`，与加摘要之前逐字相同。
 * 最坏情况（5 条 × 每条约 200 个字符）整行远小于 4 KiB，历史写入器对单行没有长度上限，也不需要。
 */
export function residualAcceptedRaw(
  item: Pick<ResidualAcceptance, 'key' | 'runId' | 'candidate' | 'findings'> & { readonly summary?: readonly string[] },
  approver: string,
): string {
  const summary = (item.summary ?? []).slice(0, RESIDUAL_SUMMARY_MAX)
    .map((line) => waiverReasonText(line).replace(/\|/gu, '｜'))
    .filter((line) => line !== '')
    .join('|')
  return `review.residual-accepted ${formatAuditDetail({
    reviewer: residualAgent(item.key), run: item.runId, candidate: item.candidate, findings: item.findings, by: approver, summary,
  })}`
}

/** 接受记录 → `evaluateStepAgents` 的 `accepted` 输入。 */
export function acceptedForEvaluation(accepted: readonly ResidualAcceptance[] | undefined): readonly AcceptedResidualRef[] {
  return (accepted ?? []).flatMap((item) => {
    const agent = residualAgent(item.key)
    return agent === undefined ? [] : [{ agent, runId: item.runId, candidate: item.candidate }]
  })
}
