import type { OperationResponse } from '../api/client'
import { formatServerProse } from '../api/transport'
import { useT } from '../i18n'

type Obj = Record<string, unknown>

const obj = (value: unknown): Obj | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Obj : null
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown, fallback = '—'): string => typeof value === 'string' && value !== '' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback
const num = (value: unknown): string => typeof value === 'number' ? String(value) : '0'

type Translate = (key: string, vars?: Record<string, string | number>) => string

function resultValue(value: unknown, t: Translate): string {
  const labels: Record<string, string> = {
    allowed: t('operations.value_allowed'),
    denied: t('operations.value_denied'),
    paused: t('operations.value_paused'),
    merged: t('operations.value_merged'),
    completed: t('operations.value_completed'),
    ok: t('operations.value_healthy'),
    ready: t('operations.value_ready'),
    blocked: t('operations.value_blocked'),
    planned: t('operations.value_planned'),
    'dry-run': t('operations.result_dry_run'),
    true: t('operations.value_yes'),
    false: t('operations.value_no'),
    codex: 'Codex',
    'loop-inactive': t('operations.reason_loop_inactive'),
    'ledger-degraded': t('operations.reason_ledger_degraded'),
    'max-in-flight': t('operations.reason_max_in_flight'),
    'max-runs-per-day': t('operations.reason_max_runs_per_day'),
    'max-tokens-per-day': t('operations.reason_max_tokens_per_day'),
  }
  const raw = str(value)
  if (labels[raw]) return labels[raw]
  const separator = raw.indexOf(':')
  if (separator > 0) {
    const state = raw.slice(0, separator)
    const reason = raw.slice(separator + 1)
    return `${labels[state] ?? state} · ${labels[reason] ?? reason}`
  }
  return raw
}

function epoch(value: unknown): string {
  const row = obj(value)
  if (row?.kind === 'sha256') return str(row.value)
  return str(row?.kind)
}

function TriageResult({ result, onOpenChange }: { result: Obj; onOpenChange?: (name: string) => void }): JSX.Element {
  const { t } = useT()
  const runs = obj(result.workflowRuns)
  const checkpoint = obj(result.checkpoint)
  return (
    <section data-testid="ops-result-triage">
      <h3 className="text-base font-bold text-text">{t('operations.result_triage')}</h3>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [t('operations.result_pages'), num(result.pagesProcessed)],
          [t('operations.result_observations'), num(result.observationsProcessed)],
          [t('operations.result_created'), num(runs?.created)],
          [t('operations.result_existing'), num(runs?.existing)],
        ].map(([label, value]) => <div key={label} className="rounded-md bg-fill px-3 py-2"><span className="block text-micro text-text-3">{label}</span><b className="font-mono text-text">{value}</b></div>)}
      </div>
      <div className="mt-2 rounded-md border border-border bg-bg px-3 py-2 text-caption">
        <b className="text-text">{t('operations.result_checkpoint')} · {str(checkpoint?.commit)}</b>
        <span className="ml-2 text-text-3">{str(checkpoint?.sourceId)} · {t('operations.result_has_more')} {resultValue(checkpoint?.hasMore, t)}</span>
      </div>
      {list(runs?.runs).length > 0 && (
        <ul className="mt-2 grid list-none gap-2 p-0 sm:grid-cols-2">
          {list(runs?.runs).map((value, index) => {
            const run = obj(value) ?? {}
            const changeName = typeof run.changeName === 'string' && run.changeName !== '' ? run.changeName : null
            return <li key={`${str(run.runId)}:${index}`} className="rounded-md border border-border bg-bg px-3 py-2 text-caption">
              {changeName !== null && onOpenChange ? (
                <button type="button" className="font-mono font-bold text-accent-d underline decoration-accent-b underline-offset-2" data-testid={`ops-open-change-${changeName}`} onClick={() => onOpenChange(changeName)}>{changeName}</button>
              ) : <b className="font-mono text-text">{str(run.changeName)}</b>}
              <div className="mt-1 font-mono text-text-3">{str(run.runId)} · {str(run.workflowId)} / {str(run.currentStep)} · {str(run.status)}</div>
            </li>
          })}
        </ul>
      )}
    </section>
  )
}

function SyncResult({ result }: { result: Obj }): JSX.Element {
  const { t, lang } = useT()
  const summary = obj(result.summary)
  const plan = obj(result.plan)
  const preconditions = obj(plan?.preconditions)
  return (
    <section data-testid="ops-result-sync">
      <h3 className="text-base font-bold text-text">{t('operations.result_sync')} · {resultValue(result.status, t)}</h3>
      <p className="mt-1 font-mono text-caption text-text-3">{t('operations.result_plan')} {str(plan?.plan_id)} · {resultValue(result.mode, t)} · {t('operations.result_operations')} {num(summary?.operations)} · {t('operations.result_unsupported')} {num(summary?.unsupported)}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-bg px-3 py-2 text-caption"><b className="text-text">{t('operations.result_registry_cas')}</b><code className="mt-1 block break-all text-text-3">{epoch(preconditions?.registry_epoch)}</code></div>
        <div className="rounded-md border border-border bg-bg px-3 py-2 text-caption"><b className="text-text">{t('operations.result_loop_doc_cas')}</b><code className="mt-1 block break-all text-text-3">{epoch(preconditions?.loop_doc_epoch)}</code></div>
      </div>
      {list(plan?.operations).length > 0 && <ul className="mt-2 list-none space-y-1 p-0">{list(plan?.operations).map((value, index) => { const operation = obj(value) ?? {}; return <li key={index} className="rounded-xs bg-fill px-2 py-1 text-caption"><code>{str(operation.kind)}</code> · {str(operation.loop_id)} → {str(operation.target)}</li> })}</ul>}
      {list(plan?.blockers).length > 0 && <ul className="mt-2 list-none space-y-1 p-0">{list(plan?.blockers).map((value, index) => { const blocker = obj(value) ?? {}; return <li key={index} className="rounded-xs border border-red-b bg-red-t px-2 py-1.5 text-caption text-red-d"><b>{resultValue(blocker.reason, t)}</b> · {formatServerProse(blocker.next_step, t, { exposeServerDetail: lang === 'zh', fallback: t('common.server_detail_unavailable') })}</li> })}</ul>}
    </section>
  )
}

function RunResult({ result, onOpenChange }: { result: Obj; onOpenChange?: (name: string) => void }): JSX.Element {
  const { t, lang } = useT()
  const previews = list(result.previews)
  const groups = list(result.groups)
  return (
    <section data-testid="ops-result-run">
      <h3 className="text-base font-bold text-text">{t('operations.result_run')} · {result.dry_run === true ? t('operations.result_dry_run') : t('operations.result_real_run')}</h3>
      <p className="mt-1 text-caption text-text-3">
        {t('operations.result_rule')} <b className="font-mono text-text-2">{str(result.selector)}</b>
        {' · '}{t('operations.result_matched', { count: num(result.matched ?? result.selected) })}
        {result.ready !== undefined ? ` · ${t('operations.result_ready')} ${resultValue(result.ready, t)}` : ''}
      </p>
      {previews.length > 0 && <div className="mt-2 grid gap-2 md:grid-cols-2">{previews.map((value, index) => {
        const preview = obj(value) ?? {}
        const tokens = obj(preview.reserved_tokens)
        const bundle = obj(preview.skill_bundle)
        return <article key={index} className="rounded-md border border-border bg-bg px-3 py-2 text-caption">
          <div className="flex justify-between gap-2"><b className="font-mono text-text">{str(preview.loop_id)}</b><span className="font-semibold text-text-2">{resultValue(preview.admission, t)}</span></div>
          <div className="mt-1 text-text-3">{t('operations.result_runner')} {resultValue(preview.runner, t)} · {t('operations.result_permission')} {str(preview.level)} · {t('operations.result_expected')} {resultValue(preview.settlement, t)}</div>
          <div className="mt-1 text-text-3">{t('operations.result_budget')} {str(tokens?.tokens)} {t('operations.result_token_unit')} · {t('operations.result_ledger')} {resultValue(preview.ledger_health, t)}</div>
          <div className="mt-1 text-text-3">{t('operations.result_skill_bundle')} {resultValue(bundle?.status, t)} · {str(bundle?.bundle_id)}{bundle?.blocking_reason ? ` · ${resultValue(bundle.blocking_reason, t)}` : ''}</div>
        </article>
      })}</div>}
      {groups.length > 0 && <div className="mt-2 grid gap-2 md:grid-cols-2">{groups.map((value, index) => {
        const group = obj(value) ?? {}
        const run = obj(group.result)
        const targets = list(group.targets)
        return <article key={index} className="rounded-md border border-border bg-bg px-3 py-2 text-caption">
          <b className="text-text">{str(group.level)}</b>
          <div className="mt-1 text-text-3">{t('operations.result_targets', { count: targets.length })} · {group.error ? `${t('operations.result_error')} ${formatServerProse(group.error, t, { exposeServerDetail: lang === 'zh', fallback: t('common.server_detail_unavailable') })}` : `${t('operations.result_status')} ${resultValue(run?.status ?? run?.ok, t)}`}</div>
          {onOpenChange && targets.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{targets.map((targetValue, targetIndex) => {
            const target = obj(targetValue)
            const changeName = typeof target?.change === 'string' && target.change !== '' ? target.change : null
            return changeName === null ? null : <button type="button" key={`${changeName}:${targetIndex}`} className="rounded-sm border border-accent-b bg-accent-t px-2 py-1 font-mono font-bold text-accent-d" data-testid={`ops-open-change-${changeName}`} onClick={() => onOpenChange(changeName)}>{changeName}</button>
          })}</div>}
        </article>
      })}</div>}
    </section>
  )
}

function GenericResult({ result }: { result: Obj | null }): JSX.Element {
  const { t } = useT()
  const rows = result === null ? [] : Object.entries(result).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 12)
  return <section data-testid="ops-result-generic"><h3 className="text-base font-bold text-text">{t('operations.result_summary')}</h3>{rows.length === 0 ? <p className="mt-2 text-caption text-text-3">{t('operations.result_no_structured')}</p> : <dl className="mt-2 grid gap-2 sm:grid-cols-2">{rows.map(([key, value]) => <div key={key} className="rounded-xs bg-fill px-3 py-2 text-caption"><dt className="text-text-3">{key}</dt><dd className="mt-0.5 font-mono text-text">{str(value)}</dd></div>)}</dl>}</section>
}

export function OperationResultView({ response, onOpenChange }: { response: OperationResponse; onOpenChange?: (name: string) => void }): JSX.Element {
  const { t } = useT()
  const result = obj(response.result)
  const kind = result?.command === 'triage' ? 'triage' : result?.command === 'loop-sync' ? 'sync' : typeof result?.dry_run === 'boolean' ? 'run' : 'generic'
  return (
    <div className="mt-3 rounded-md border border-border bg-code-bg p-3" data-testid="ops-result" data-ok={response.ok}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <b className="text-caption text-text">{response.ok ? t('operations.result_success') : t('operations.result_failed')}</b>
        <span className="text-micro text-text-3">{t('operations.result_exit_code')} {response.exit_code}</span>
      </div>
      {kind === 'triage' && result ? <TriageResult result={result} onOpenChange={onOpenChange} /> : kind === 'sync' && result ? <SyncResult result={result} /> : kind === 'run' && result ? <RunResult result={result} onOpenChange={onOpenChange} /> : <GenericResult result={result} />}
      <details className="mt-3 border-t border-border pt-2" data-testid="ops-result-raw">
        <summary className="cursor-pointer text-caption font-semibold text-text-3">{t('operations.result_raw')}</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-micro leading-[1.5] text-text-2">$ {response.command.join(' ')}{`\n`}{response.result === null ? response.stdout : JSON.stringify(response.result, null, 2)}{response.stderr ? `\n${response.stderr}` : ''}</pre>
      </details>
    </div>
  )
}
