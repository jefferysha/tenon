import { useCallback } from 'react'
import { CONTEXT_BUNDLE_PHASES } from '../api/contextBundleTypes'
import { useT } from '../i18n'
import { BUTTON_SOLID, INPUT, SELECT, PANEL } from '../shared/uiRecipes'
import {
  BudgetSummary,
  ContextBundleLoading,
  PreviewInputs,
} from './ContextBundlePreviewParts'
import { useContextBundlePreview } from './useContextBundlePreview'

export interface ContextBundlePreviewProps {
  root: string
  change: string
  currentPhase: string
}

const ERROR_KEYS: Readonly<Record<string, string>> = {
  CONTEXT_BUNDLE_INVALID_REQUEST: 'progress.bundle_error_invalid',
  CONTEXT_BUNDLE_STATE_CORRUPT: 'progress.bundle_error_state_corrupt',
  CONTEXT_BUNDLE_LEDGER_MISSING: 'progress.bundle_error_ledger_missing',
  CONTEXT_BUNDLE_DOCUMENT_MISSING: 'progress.bundle_error_document_missing',
  CONTEXT_BUNDLE_DOCUMENT_STALE: 'progress.bundle_error_document_stale',
  CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED: 'progress.bundle_error_resource_limit',
  CONTEXT_BUNDLE_TRUSTED_READER_UNAVAILABLE: 'progress.bundle_error_trusted_reader_unavailable',
  CONTEXT_BUNDLE_NETWORK_ERROR: 'progress.bundle_error_network',
  CONTEXT_BUNDLE_INVALID_RESPONSE: 'progress.bundle_error_invalid_response',
  CONTEXT_BUNDLE_REQUEST_FAILED: 'progress.bundle_error_request_failed',
}

const REPAIR_KEYS: Readonly<Record<string, string>> = {
  CONTEXT_BUNDLE_INVALID_REQUEST: 'progress.bundle_repair_invalid',
  CONTEXT_BUNDLE_STATE_CORRUPT: 'progress.bundle_repair_state_corrupt',
  CONTEXT_BUNDLE_LEDGER_MISSING: 'progress.bundle_repair_ledger_missing',
  CONTEXT_BUNDLE_DOCUMENT_MISSING: 'progress.bundle_repair_document_missing',
  CONTEXT_BUNDLE_DOCUMENT_STALE: 'progress.bundle_repair_document_stale',
  CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED: 'progress.bundle_repair_resource_limit',
  CONTEXT_BUNDLE_TRUSTED_READER_UNAVAILABLE: 'progress.bundle_repair_trusted_reader_unavailable',
  CONTEXT_BUNDLE_NETWORK_ERROR: 'progress.bundle_repair_network',
  CONTEXT_BUNDLE_INVALID_RESPONSE: 'progress.bundle_repair_invalid_response',
  CONTEXT_BUNDLE_REQUEST_FAILED: 'progress.bundle_repair_request_failed',
}

export function ContextBundlePreview({
  root,
  change,
  currentPhase,
}: ContextBundlePreviewProps): JSX.Element {
  const { t, lang } = useT()
  const {
    target,
    budgetText,
    state,
    submit,
    onTargetChange,
    onBudgetChange,
  } = useContextBundlePreview({ root, change, currentPhase })
  const formatNumber = useCallback(
    (value: number) => new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US').format(value),
    [lang],
  )

  const buttonLabel = state.kind === 'budget-error' || state.kind === 'error'
    ? t('progress.bundle_retry')
    : state.kind === 'success'
      ? t('progress.bundle_resubmit')
      : t('progress.bundle_submit')

  return (
    <section
      className={`mt-4 p-4 ${PANEL}`}
      aria-labelledby="context-bundle-preview-title"
    >
      <div>
        <h2 id="context-bundle-preview-title" className="text-base font-semibold text-text">
          {t('progress.bundle_title')}
        </h2>
        <p className="mt-1 text-caption leading-5 text-text-3">
          {t('progress.bundle_description')}
        </p>
      </div>

      <form className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit}>
        <label className="grid gap-1 text-caption font-medium text-text-2">
          {t('progress.bundle_target_label')}
          <select
            className={`${SELECT} h-9 px-2 text-base`}
            value={target}
            onChange={(event) => onTargetChange(event.currentTarget.value)}
          >
            {CONTEXT_BUNDLE_PHASES.map((phase) => (
              <option key={phase} value={phase}>{t(`phases.${phase}`)}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-caption font-medium text-text-2">
          {t('progress.bundle_budget_label')}
          <input
            className={`${INPUT} h-9 px-2 font-mono text-base`}
            type="number"
            name="budgetBytes"
            autoComplete="off"
            min="1"
            step="1"
            inputMode="numeric"
            value={budgetText}
            onChange={(event) => onBudgetChange(event.currentTarget.value)}
          />
        </label>
        <button
          className={`${BUTTON_SOLID} h-9 px-3 text-caption`}
          type="submit"
          disabled={state.kind === 'loading'}
        >
          {buttonLabel}
        </button>
      </form>

      <div
        className="mt-4"
        aria-live="polite"
        aria-busy={state.kind === 'loading'}
        data-testid="context-bundle-result"
      >
        {state.kind === 'idle' && (
          <p className="text-caption text-text-3">{t('progress.bundle_idle')}</p>
        )}
        {state.kind === 'loading' && (
          <ContextBundleLoading />
        )}

        {state.kind === 'success' && state.preview.inputs.length === 0 && (
          <div
            className="rounded-md border border-dashed border-border-2 px-3 py-4 text-caption text-text-3"
            role="status"
          >
            {t('progress.bundle_empty')}
          </div>
        )}

        {state.kind === 'success' && state.preview.inputs.length > 0 && (
          <div className="space-y-3">
            <BudgetSummary
              usedBytes={state.preview.budget.usedBytes}
              maxBytes={state.preview.budget.maxBytes}
              documentCount={state.preview.documentCount}
              formatNumber={formatNumber}
              tone="success"
            />
            <PreviewInputs inputs={state.preview.inputs} formatNumber={formatNumber} />
          </div>
        )}

        {state.kind === 'budget-error' && (
          <div className="space-y-3">
            <BudgetSummary
              usedBytes={state.preview.budget.usedBytes}
              maxBytes={state.preview.budget.maxBytes}
              documentCount={state.preview.documentCount}
              formatNumber={formatNumber}
              tone="error"
            />
            <div className="rounded-md border border-amber-b bg-amber-t px-3 py-2.5 text-caption text-amber-d" role="alert">
              <p className="font-semibold">
                {t('progress.bundle_budget_error', {
                  required: formatNumber(state.preview.budget.usedBytes),
                  available: formatNumber(state.preview.budget.maxBytes),
                })}
              </p>
              <code className="mt-1 block break-all text-micro">{state.code}</code>
              <p className="mt-1">{t('progress.bundle_budget_repair')}</p>
            </div>
            <PreviewInputs inputs={state.preview.inputs} formatNumber={formatNumber} />
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-md border border-red-b bg-red-t px-3 py-2.5 text-caption text-red-d" role="alert">
            <p className="font-semibold">{t('progress.bundle_error_title')}</p>
            <code className="mt-1 block break-all text-micro">{state.code}</code>
            <p className="mt-1">
              {t(ERROR_KEYS[state.code] ?? 'progress.bundle_error_unknown', {
                path: state.path ?? '—',
                metric: state.metric ?? '—',
                limit: state.limit === undefined ? '—' : formatNumber(state.limit),
                actual: state.actual === undefined ? '—' : formatNumber(state.actual),
              })}
            </p>
            <p className="mt-1">
              {t(REPAIR_KEYS[state.code] ?? 'progress.bundle_error_repair')}
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
