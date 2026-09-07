import { useEffect, useMemo, useState } from 'react'
import { fetchRunDetail, type WbLedgerRecord, type WbRunDetail } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { shortTime } from '../model/time'

export interface RunAuditPanelProps {
  root: string
  change: string
  /** phase/automation 等 canonical 快照变化时由宿主传新键，触发重读。 */
  refreshKey?: string
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function short(value: unknown, width = 12): string {
  const text = str(value)
  if (text.length <= width) return text || '—'
  return `${text.slice(0, width)}…`
}

function recordOf(records: readonly WbLedgerRecord[], kind: string): WbLedgerRecord | undefined {
  return [...records].reverse().find((record) => record.kind === kind)
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

const STEP_KEYS = new Set(['open', 'explore', 'draft', 'spec', 'review', 'build', 'verify', 'release', 'archive', 'done'])

function stepLabel(step: string, t: Translate): string {
  return STEP_KEYS.has(step) ? t(`runAudit.step_${step}`) : (step || t('runAudit.unavailable'))
}

const RESULT_KEYS = new Set(['merged', 'success', 'passed', 'paused', 'failed', 'conflict', 'skipped', 'queued', 'running'])

function resultLabel(result: string, t: Translate): string {
  return RESULT_KEYS.has(result) ? t(`runAudit.result_${result}`) : (result || t('runAudit.result_pending'))
}

const REASON_KEYS: Readonly<Record<string, string>> = {
  'verify-fail': 'reason_verify_fail',
  'verification-inconclusive': 'reason_inconclusive',
  'verification-subject-mismatch': 'reason_subject_mismatch',
  'verification-binding-unresolved': 'reason_binding_unresolved',
  'skill-bundle-snapshot-corrupt': 'reason_skill_snapshot_corrupt',
  'budget-exceeded': 'reason_budget_exceeded',
}

function reasonLabel(reason: string, t: Translate): string {
  return REASON_KEYS[reason] ? t(`runAudit.${REASON_KEYS[reason]}`) : (reason ? t('runAudit.reason_fallback') : '')
}

function verificationLabel(verdict: string, t: Translate): string {
  if (verdict === 'passed' || verdict === 'failed' || verdict === 'inconclusive') return t(`runAudit.verdict_${verdict}`)
  return verdict || t('runAudit.verdict_pending')
}

function evidenceSummary(value: unknown, t: Translate): string {
  const evidence = object(value)
  if (!evidence) return t('runAudit.evidence_invalid')
  if (evidence.kind === 'command-result') {
    const exitCode = num(evidence.exit_code)
    return exitCode === 0
      ? t('runAudit.evidence_command_passed')
      : t('runAudit.evidence_command_failed', { exitCode: exitCode === null ? '' : t('runAudit.evidence_exit_code', { code: exitCode }) })
  }
  if (evidence.kind === 'repo-file') return t('runAudit.evidence_file', { path: str(evidence.path) || t('runAudit.evidence_file_unnamed') })
  return t('runAudit.evidence_recorded')
}

const factCard = 'rounded-xl border border-border bg-card px-3 py-3'
const factLabel = 'text-[11px] font-semibold text-text-3'
const factValue = 'mt-1 text-[13px] font-bold leading-5 text-text [overflow-wrap:anywhere]'

export function RunAuditPanel({ root, change, refreshKey = '' }: RunAuditPanelProps): JSX.Element {
  const { lang, t } = useT()
  const [detail, setDetail] = useState<WbRunDetail | null>(null)
  const [error, setError] = useState<unknown | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    fetchRunDetail(change, root)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason)
      })
    return () => { cancelled = true }
  }, [change, refreshKey, root])

  const records = detail?.ledger?.records ?? []
  const terminal = useMemo(() => recordOf(records, 'run'), [records])
  const usage = useMemo(() => recordOf(records, 'usage'), [records])
  const skillSnapshot = useMemo(() => recordOf(records, 'skill-bundle-snapshot'), [records])

  if (error !== null) {
    return (
      <section className="border-b border-border py-3" data-testid="run-audit-error">
        <p className="rounded-xl border border-red-b bg-red-t px-3 py-2.5 text-xs font-semibold text-red-d" role="alert">
          {t('runAudit.fetch_failed', { message: formatApiError(error, t, { exposeServerDetail: lang === 'zh' }) })}
        </p>
      </section>
    )
  }

  if (detail === null) {
    return <section className="border-b border-border py-3 text-xs text-text-3" data-testid="run-audit-loading" role="status" aria-live="polite">{t('runAudit.loading')}</section>
  }

  const run = detail.workflow_run
  const current = detail.current_revision
  const terminalArtifacts = object(terminal?.artifacts)
  const terminalCommits = strings(terminalArtifacts?.commit_shas)
  const terminalResult = str(terminal?.result)
  const terminalReason = str(terminal?.reason)
  const verification = object(terminal?.verification)
  const evidence = Array.isArray(verification?.evidence) ? verification.evidence : []
  const tokens = object(usage?.tokens)
  const slots = Array.isArray(skillSnapshot?.slots)
    ? skillSnapshot.slots.map(object).filter((slot): slot is Record<string, unknown> => slot !== null)
    : []
  const updatedAt = str(terminal?.finished_at) || run?.updated_at || current?.mutation.observedAt || ''

  return (
    <section className="border-b border-border py-3" data-source={detail.source} data-testid="run-audit">
      <div className="flex items-center justify-between gap-3">
        <div>
          <b className="text-[13px] text-text">{t('runAudit.title')}</b>
          <p className="mt-0.5 text-[11px] leading-5 text-text-3">{t('runAudit.subtitle')}</p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${detail.source === 'canonical' ? 'border-green-b bg-green-t text-green-d' : 'border-amber-b bg-amber-t text-amber-d'}`}>
          {t(detail.source === 'canonical' ? 'runAudit.source_canonical' : 'runAudit.source_legacy')}
        </span>
      </div>

      {detail.source === 'legacy' && (
        <p className="mt-3 rounded-xl border border-amber-b bg-amber-t px-3 py-2 text-xs font-semibold text-amber-d" data-testid="run-audit-source-alert">
          {t('runAudit.legacy_warning')}
        </p>
      )}
      {detail.projection.status === 'drift' && (
        <p className="mt-3 rounded-xl border border-red-b bg-red-t px-3 py-2 text-xs font-semibold text-red-d" data-testid="run-audit-projection-alert">
          {t('runAudit.projection_drift')}
        </p>
      )}
      {detail.ledger.health === 'degraded' && (
        <p className="mt-3 rounded-xl border border-red-b bg-red-t px-3 py-2 text-xs font-semibold text-red-d" data-testid="run-audit-ledger-alert">
          {t('runAudit.ledger_degraded', { count: detail.ledger.rejected.length })}
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2" data-testid="run-audit-summary">
        <div className={factCard}><div className={factLabel}>{t('runAudit.workflow')}</div><div className={factValue}>{run?.workflow_id ?? t('runAudit.unavailable')}</div></div>
        <div className={factCard}><div className={factLabel}>{t('runAudit.current_phase')}</div><div className={factValue}>{stepLabel(run?.current_step ?? '', t)}</div></div>
        <div className={factCard}><div className={factLabel}>{t('runAudit.revision')}</div><div className={factValue}>{current ? t('runAudit.revision_value', { revision: current.revision }) : t('runAudit.unavailable')}</div></div>
        <div className={factCard}><div className={factLabel}>{t('runAudit.updated')}</div><div className={factValue}>{updatedAt ? shortTime(updatedAt, lang) : t('runAudit.unavailable')}</div></div>
      </div>

      {detail.transitions.length > 0 && (
        <div className="mt-3" data-testid="run-audit-transitions">
          <h3 className="text-xs font-semibold text-text">{t('runAudit.transitions')}</h3>
          <ol className="mt-2 space-y-1.5">
            {detail.transitions.map((transition) => (
              <li key={transition.id} className="flex items-center justify-between gap-3 rounded-lg bg-fill px-3 py-2 text-xs text-text-2">
                <span><b className="text-text">{stepLabel(transition.from, t)} → {stepLabel(transition.to, t)}</b></span>
                <time className="text-[11px] text-text-3">{shortTime(transition.observedAt, lang)}</time>
              </li>
            ))}
          </ol>
        </div>
      )}

      {terminal ? (
        <div className="mt-3" data-testid="run-audit-execution">
          <h3 className="text-xs font-semibold text-text">{t('runAudit.execution')}</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className={factCard}><div className={factLabel}>{t('runAudit.result')}</div><div className={factValue}>{resultLabel(terminalResult, t)}{terminalReason ? ` · ${reasonLabel(terminalReason, t)}` : ''}</div></div>
            <div className={factCard}><div className={factLabel}>{t('runAudit.branch')}</div><div className={factValue}>{str(terminalArtifacts?.branch) || t('runAudit.branch_missing')}</div></div>
            <div className={factCard}><div className={factLabel}>{t('runAudit.build_sha')}</div><div className={factValue}>{short(terminalArtifacts?.build_sha)}</div></div>
            <div className={factCard}><div className={factLabel}>{t('runAudit.commits')}</div><div className={factValue}>{t('runAudit.commits_value', { count: terminalCommits.length })}</div></div>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-xl bg-fill px-3 py-3 text-xs text-text-3">{t('runAudit.execution_empty')}</p>
      )}

      {verification && (
        <div className="mt-3" data-testid="run-audit-verification">
          <h3 className="text-xs font-semibold text-text">{t('runAudit.verification')}</h3>
          <div className={`mt-2 rounded-xl border px-3 py-3 ${str(verification.verdict) === 'passed' ? 'border-green-b bg-green-t' : 'border-red-b bg-red-t'}`}>
            <b className="text-sm text-text">{verificationLabel(str(verification.verdict), t)}</b>
            {evidence.length > 0 && <ul className="mt-2 space-y-1 text-xs text-text-2">{evidence.map((item, index) => <li key={index}>{evidenceSummary(item, t)}</li>)}</ul>}
          </div>
        </div>
      )}

      {skillSnapshot && (
        <div className="mt-3" data-testid="run-audit-skills">
          <h3 className="text-xs font-semibold text-text">{t('runAudit.skills')}</h3>
          <div className="mt-2 rounded-xl border border-border bg-card px-3 py-3 text-xs text-text-2">
            <b className="text-text">{str(skillSnapshot.skill_bundle_id) || t('runAudit.skill_bundle_missing')}</b>
            {slots.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{slots.map((slot, index) => <span key={`${str(slot.concrete_skill_id)}-${index}`} className="rounded-lg bg-fill px-2 py-1 font-semibold">{str(slot.concrete_skill_id) || str(slot.token)}</span>)}</div>}
          </div>
        </div>
      )}

      {usage && (
        <div className="mt-3" data-testid="run-audit-usage">
          <h3 className="text-xs font-semibold text-text">{t('runAudit.usage')}</h3>
          <div className="mt-2 rounded-xl border border-border bg-card px-3 py-3 text-xs text-text-2">
            {t('runAudit.usage_value', { tokens: num(tokens?.total)?.toLocaleString('en-US') ?? t('runAudit.unavailable') })}
          </div>
        </div>
      )}

      <p className="mt-3 rounded-xl bg-fill px-3 py-3 text-xs leading-5 text-text-3" data-testid="run-audit-artifact-note">
        {t('runAudit.artifact_note')}
      </p>
    </section>
  )
}
