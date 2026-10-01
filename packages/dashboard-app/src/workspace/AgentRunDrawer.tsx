import { useEffect, useState } from 'react'
import { fetchDocument } from '../api/documentsClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { Markdown } from '../shared/Markdown'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { DefRow } from '../tests/TestSection'
import type { AgentRunView } from '../types'
import { CommandLine } from './CommandLine'
import { agentPromptCommand } from './taskCommands'

type Report = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error'; detail: string }

const TONE: Record<AgentRunView['state'], PillTone> = {
  idle: 'neutral',
  running: 'running',
  done: 'done',
  stale: 'pending',
}

const RESULT_KEY = {
  pass: 'workspace.agent_pass',
  fail: 'workspace.agent_fail',
  done: 'workspace.agent_done',
  failed: 'workspace.agent_failed',
} as const

/** 候选的短形式：保留前缀与首尾几位，完整值放 title。 */
export function shortCandidate(candidate: string): string {
  const split = candidate.lastIndexOf(':') + 1
  const hash = candidate.slice(split)
  return hash.length <= 14 ? candidate : `${candidate.slice(0, split)}${hash.slice(0, 8)}…${hash.slice(-4)}`
}

/**
 * 要求了宿主的评审者，还没有一次在该宿主上跑出有效结论：从没运行 / 过期（宿主不符，或代码变了要重跑）/
 * 正在别的宿主上跑。有效运行出现（状态完成，宿主不符一定是过期）或正在要求的宿主上跑时为 false。
 */
export function hostRunPending(agent: AgentRunView): boolean {
  if (agent.requiredHost == null) return false
  if (agent.state === 'done') return false
  if (agent.state === 'running') return agent.host !== agent.requiredHost
  return true
}

/** 「要求」小标记：宿主名旁的 13px 灰字，不是药丸；解释放 title。 */
function RequiredHost({ host }: { host: string }): JSX.Element {
  const { t } = useT()
  return (
    <span title={t('workspace.agent_host_required_hint', { host })} data-testid="agent-run-host-required">
      {host}
      <span className="ml-1.5 font-sans text-micro text-text-3" data-testid="agent-run-host-required-mark">{t('workspace.agent_host_required')}</span>
    </span>
  )
}

/**
 * 这次评审绑定的东西：在哪个宿主上跑的、绑定的候选（被评审代码的内容哈希）。永不折行；
 * 没有宿主要求也没有登记宿主、没有候选时整块不出现。
 * 宿主一行：登记的宿主（没有是「—」）与要求的宿主（宿主名 + 小「要求」标记）并排，两者一致时合成一个；宿主不符另有红点 + 词。
 * 要求的宿主上还没有有效运行（且这是当前步骤）时，行下给出可复制的 `tenon agent prompt` 命令——Dashboard 只展示，从不运行。
 */
function RunBinding({ agent, command }: { agent: AgentRunView; command: string | null }): JSX.Element | null {
  const { t } = useT()
  const hasHost = agent.host != null || agent.requiredHost != null
  const hasCandidate = agent.candidate != null
  if (!hasHost && !hasCandidate) return null
  const required = agent.requiredHost ?? null
  const met = required !== null && agent.host === required
  return (
    <div className="mb-3" role="table" aria-label={t('workspace.agent_candidate')} data-testid="agent-run-binding">
      {hasHost && (
        <DefRow label={t('workspace.agent_host')} testId="agent-run-host">
          {met ? <RequiredHost host={required} /> : <span data-testid="agent-run-host-recorded">{agent.host ?? '—'}</span>}
          {agent.hostSource === 'declared' && <span className="text-text-3" data-testid="agent-run-host-declared">{` · ${t('workspace.agent_declared')}`}</span>}
          {agent.wrongHost === true && (
            <StatusPill tone="blocked" testId="agent-run-host-mismatch" title={required ?? undefined} className="ml-3 font-sans">
              {t('workspace.agent_host_mismatch')}
            </StatusPill>
          )}
          {required !== null && !met && (
            <>
              <span className="text-text-3">{' · '}</span>
              <RequiredHost host={required} />
            </>
          )}
        </DefRow>
      )}
      {command !== null && (
        // 同 DefRow 的行外观，但值格不裁切：复制钮的焦点环要完整可见。
        <div className="grid min-h-10 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 border-b border-border py-1 last:border-0" role="row" data-testid="agent-run-command-row">
          <span className="whitespace-nowrap text-caption text-text-3" role="rowheader">{t('workspace.agent_command')}</span>
          <div className="min-w-0 px-0.5" role="cell"><CommandLine command={command} testId="agent-run-command" truncate="start" /></div>
        </div>
      )}
      {hasCandidate && (
        <DefRow label={t('workspace.agent_candidate')} testId="agent-run-candidate">
          <span title={agent.candidate ?? undefined}>{shortCandidate(agent.candidate ?? '')}</span>
        </DefRow>
      )}
    </div>
  )
}

/** 右侧抽屉：一个 agent 这次运行的结论、操作人与时间、绑定的宿主与候选，加它写的报告正文。 */
export function AgentRunDrawer({
  root, change, runnable, agent, onClose,
}: {
  root: string
  /** 任务名：拼 `tenon agent prompt <change> <agent>`。 */
  change: string
  /** 这个步骤现在能开始（是任务的当前步骤、未归档）；否则不给命令。 */
  runnable: boolean
  agent: AgentRunView | null
  onClose: () => void
}): JSX.Element | null {
  const { t } = useT()
  const [report, setReport] = useState<{ path: string; state: Report }>({ path: '', state: { status: 'loading' } })
  const path = agent?.reportPath ?? null

  useEffect(() => {
    if (path === null) return
    const controller = new AbortController()
    setReport({ path, state: { status: 'loading' } })
    fetchDocument(root, path, controller.signal)
      .then((doc) => setReport({ path, state: { status: 'ready', text: doc.text } }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setReport({ path, state: { status: 'error', detail: formatApiError(error, t, { exposeServerDetail: true }) } })
      })
    return () => controller.abort()
  }, [root, path, t])

  if (agent === null) return null
  const state: Report = path !== null && report.path === path ? report.state : { status: 'loading' }
  const verdict = agent.state === 'running'
    ? t('workspace.agent_running')
    : agent.state === 'stale'
      ? t('workspace.agent_stale')
      : agent.result === null ? t('workspace.agent_idle') : t(RESULT_KEY[agent.result])
  const reruns = agent.reruns ?? 0
  const facts = [
    t(`workspace.agent_${agent.role}`),
    verdict,
    t('workspace.agent_findings', { n: agent.findings }),
    ...(reruns > 0 ? [t('workspace.agent_reruns', { n: reruns })] : []),
    ...(agent.flipped === true ? [t('workspace.agent_flipped')] : []),
    agent.actor?.name ?? '—',
    agent.finishedAt ?? '—',
  ].join(' · ')

  return (
    <Drawer
      open
      onClose={onClose}
      ariaLabel={agent.agent}
      testId="agent-run-drawer"
      title={(
        <>
          <span className="block truncate font-mono text-base font-semibold text-text" data-testid="agent-run-title">{agent.agent}</span>
          <span className="block truncate font-mono text-caption text-text-3" title={agent.rerunReason ?? undefined} data-testid="agent-run-facts">{facts}</span>
        </>
      )}
      actions={<StatusPill tone={TONE[agent.state]} testId="agent-run-state">{verdict}</StatusPill>}
    >
      <RunBinding agent={agent} command={runnable && hostRunPending(agent) ? agentPromptCommand(root, change, agent.agent) : null} />
      {path === null ? (
        <p className="text-body text-text-3" role="status" data-testid="agent-run-empty">{t('workspace.agent_idle')}</p>
      ) : state.status === 'loading' ? (
        <p className="text-body text-text-3" role="status">{t('common.loading')}</p>
      ) : state.status === 'error' ? (
        <p className="whitespace-pre-wrap text-body text-red-d" role="alert" data-testid="agent-run-error">{state.detail}</p>
      ) : (
        <>
          <p className="mb-3 truncate font-mono text-caption text-text-3" data-testid="agent-run-path">{path}</p>
          <Markdown text={state.text} testId="agent-run-report" density="compact" />
        </>
      )}
    </Drawer>
  )
}
