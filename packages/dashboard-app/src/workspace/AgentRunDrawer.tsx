import { useEffect, useState } from 'react'
import { fetchDocument } from '../api/documentsClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { Markdown } from '../shared/Markdown'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
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

/** 右侧抽屉：一个 agent 这次运行的结论、操作人与时间，加它写的报告正文。 */
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
  const facts = [
    t(`workspace.agent_${agent.role}`),
    verdict,
    t('workspace.agent_findings', { n: agent.findings }),
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
          <span className="block truncate font-mono text-caption text-text-3" data-testid="agent-run-facts">{facts}</span>
        </>
      )}
      actions={<StatusPill tone={TONE[agent.state]} testId="agent-run-state">{verdict}</StatusPill>}
    >
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
