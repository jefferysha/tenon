import { useEffect, useState } from 'react'
import { fetchDocument } from '../api/documentsClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { Markdown } from '../shared/Markdown'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { DefRow } from '../tests/TestSection'
import type { AgentRunView } from '../types'

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
 * 这次评审绑定的东西：在哪个宿主上跑的、绑定的候选（被评审代码的内容哈希）。两行定义表，永不折行；
 * 没有宿主要求也没有登记宿主、没有候选时整块不出现。宿主不符 = 红点 + 词，要求的宿主放 title。
 */
function RunBinding({ agent }: { agent: AgentRunView }): JSX.Element | null {
  const { t } = useT()
  const hasHost = agent.host != null || agent.requiredHost != null
  const hasCandidate = agent.candidate != null
  if (!hasHost && !hasCandidate) return null
  return (
    <div className="mb-3" role="table" aria-label={t('workspace.agent_candidate')} data-testid="agent-run-binding">
      {hasHost && (
        <DefRow label={t('workspace.agent_host')} testId="agent-run-host">
          <span title={agent.requiredHost == null ? undefined : agent.requiredHost}>
            {agent.host ?? '—'}
            {agent.hostSource === 'declared' && <span className="text-text-3" data-testid="agent-run-host-declared">{` · ${t('workspace.agent_declared')}`}</span>}
          </span>
          {agent.wrongHost === true && (
            <StatusPill tone="blocked" testId="agent-run-host-mismatch" title={agent.requiredHost ?? undefined} className="ml-3 font-sans">
              {t('workspace.agent_host_mismatch')}
            </StatusPill>
          )}
        </DefRow>
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
  root, agent, onClose,
}: {
  root: string
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
      <RunBinding agent={agent} />
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
