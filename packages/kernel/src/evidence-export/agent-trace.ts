/**
 * EvidenceBundle → Agent Trace 记录（公开规范 agent-trace.dev，trace record schema v0.1）。
 *
 * 规范归因的是「文件里的行区间由谁贡献」。Tenon 知道哪些文件的哪些行在受治理的任务里新增 / 改动，
 * 不知道其中哪几行是人写的、哪几行是 agent 写的，所以 contributor 缺省 `unknown`，由导出者显式断言才写 ai / human / mixed。
 * Tenon 自己的证据（链头、记录数、判定、agent 运行）放在 `metadata['dev.tenon']`（规范允许的反向域名命名空间），
 * 每个 conversation 另带一条 `related` 指向证据。
 */
import { deterministicUuid } from './ids.js'
import type { EvidenceBundle } from './types.js'

export const AGENT_TRACE_VERSION = '0.1'
export const AGENT_TRACE_MAX_FILES = 2000
export const AGENT_TRACE_MAX_RANGES = 500
export const CONTRIBUTOR_TYPES = ['human', 'ai', 'mixed', 'unknown'] as const
export type ContributorType = (typeof CONTRIBUTOR_TYPES)[number]

export function isContributorType(value: string): value is ContributorType {
  return (CONTRIBUTOR_TYPES as readonly string[]).includes(value)
}

export interface AgentTraceContributor {
  readonly type: ContributorType
  readonly model_id?: string
}

export interface AgentTraceRecord {
  readonly version: string
  readonly id: string
  readonly timestamp: string
  readonly vcs: { readonly type: 'git'; readonly revision: string }
  readonly tool: { readonly name: 'tenon'; readonly version: string }
  readonly files: readonly {
    readonly path: string
    readonly conversations: readonly {
      readonly contributor: AgentTraceContributor
      readonly ranges: readonly { readonly start_line: number; readonly end_line: number }[]
      readonly related: readonly { readonly type: string; readonly url: string }[]
    }[]
  }[]
  readonly metadata: { readonly 'dev.tenon': Readonly<Record<string, unknown>> }
}

export interface AgentTraceOptions {
  readonly contributor: ContributorType
  /** `provider/model-name`（models.dev 口径，最长 250）；只在显式断言 contributor 时有意义。 */
  readonly model?: string
}

export function evidenceUrl(bundle: Pick<EvidenceBundle, 'change' | 'chain'>): string {
  return `tenon:evidence/${bundle.change}?head=${bundle.chain.head}`
}

export function buildAgentTrace(bundle: EvidenceBundle, options: AgentTraceOptions): AgentTraceRecord {
  const contributor: AgentTraceContributor = {
    type: options.contributor,
    ...(options.model === undefined || options.model === '' ? {} : { model_id: options.model.slice(0, 250) }),
  }
  const related = [{ type: 'tenon-evidence', url: evidenceUrl(bundle) }]
  const files = bundle.files
    .filter((file) => file.ranges.length > 0)
    .slice(0, AGENT_TRACE_MAX_FILES)
    .map((file) => ({
      path: file.path,
      conversations: [{ contributor, ranges: file.ranges.slice(0, AGENT_TRACE_MAX_RANGES), related }],
    }))
  const last = bundle.records.at(-1)
  return {
    version: AGENT_TRACE_VERSION,
    id: deterministicUuid(`agent-trace\0${bundle.change}\0${bundle.chain.head}\0${bundle.commit}`),
    timestamp: bundle.evidence_at,
    vcs: { type: 'git', revision: bundle.commit },
    tool: { name: 'tenon', version: bundle.tenon },
    files,
    metadata: {
      'dev.tenon': {
        change: bundle.change,
        workflow: bundle.workflow,
        track: bundle.track,
        evidence: {
          chain_head: bundle.chain.head,
          records: bundle.chain.records,
          user: bundle.chain.user,
          plan_digest: bundle.plan_digest,
          last_result: bundle.last_result,
          last_run: last?.run_id ?? null,
        },
        agents: bundle.agents.map((agent) => ({
          agent: agent.agent, role: agent.role, step: agent.step, result: agent.result, host: agent.host,
        })),
        truncated: bundle.files_truncated
          || bundle.files.length > AGENT_TRACE_MAX_FILES
          || bundle.files.some((file) => file.ranges.length > AGENT_TRACE_MAX_RANGES),
      },
    },
  }
}
