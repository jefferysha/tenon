import { FileText } from 'lucide-react'
import {
  type ContextBundlePreviewInput,
  type ContextBundleReasonCode,
} from '../api/client'
import { useT } from '../i18n'

const REASON_I18N_KEYS: Readonly<Record<ContextBundleReasonCode, string>> = {
  'context-bundle.reason.proposal': 'progress.bundle_reason_proposal',
  'context-bundle.reason.openspec-design': 'progress.bundle_reason_openspec_design',
  'context-bundle.reason.tasks': 'progress.bundle_reason_tasks',
  'context-bundle.reason.superpower-design': 'progress.bundle_reason_superpower_design',
  'context-bundle.reason.adr': 'progress.bundle_reason_adr',
  'context-bundle.reason.delta-spec': 'progress.bundle_reason_delta_spec',
  'context-bundle.reason.superpower-plan': 'progress.bundle_reason_superpower_plan',
  'context-bundle.reason.plan': 'progress.bundle_reason_plan',
  'context-bundle.reason.verification-report': 'progress.bundle_reason_verification_report',
  'context-bundle.reason.applied-spec': 'progress.bundle_reason_applied_spec',
}

interface BudgetSummaryProps {
  usedBytes: number
  maxBytes: number
  documentCount: number
  formatNumber: (value: number) => string
  tone: 'success' | 'error'
}

export function BudgetSummary({
  usedBytes,
  maxBytes,
  documentCount,
  formatNumber,
  tone,
}: BudgetSummaryProps): JSX.Element {
  const { t } = useT()
  const rawPercent = maxBytes > 0 ? (usedBytes / maxBytes) * 100 : 0
  const percent = usedBytes > maxBytes ? Math.ceil(rawPercent) : Math.round(rawPercent)
  const visualPercent = Math.min(100, Math.max(0, (usedBytes / maxBytes) * 100))
  const clampedBytes = Math.min(maxBytes, Math.max(0, usedBytes))
  const percentText = t('progress.bundle_percent_used', { percent })
  const exactBytes = `${formatNumber(usedBytes)} / ${formatNumber(maxBytes)} bytes`
  const detail = tone === 'error'
    ? t('progress.bundle_overage', { bytes: formatNumber(Math.max(0, usedBytes - maxBytes)) })
    : t('progress.bundle_remaining', { bytes: formatNumber(Math.max(0, maxBytes - usedBytes)) })

  return (
    <div className={`rounded-md border border-border p-3 ${tone === 'error' ? 'border-amber-b bg-amber-t' : 'border-green-b bg-green-t'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <strong className={`block text-base font-semibold ${tone === 'error' ? 'text-amber-d' : 'text-green-d'}`}>
            {percentText}
          </strong>
          <span className="mt-0.5 block font-mono text-caption tabular-nums text-text">
            {exactBytes}
          </span>
        </div>
        <span className="shrink-0 rounded-sm border border-border bg-card px-2 py-1 text-caption font-medium text-text-2">
          {t('progress.bundle_document_count', { count: documentCount })}
        </span>
      </div>
      <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-fill-2"
        role="progressbar"
        aria-label={t('progress.bundle_progress_label', { percent: percentText })}
        aria-valuemin={0}
        aria-valuemax={maxBytes}
        aria-valuenow={clampedBytes}
        aria-valuetext={t('progress.bundle_progress_value', {
          exact: exactBytes,
          percent: percentText,
        })}
      >
        <div
            className={`h-full w-full origin-left rounded-full transition-transform duration-200 motion-reduce:transition-none ${tone === 'error' ? 'bg-amber-d' : 'bg-green'}`}
          data-testid="context-bundle-budget-fill"
          style={{ transform: `scaleX(${visualPercent / 100})` }}
        />
      </div>
      <p className={`mt-2 text-caption font-medium ${tone === 'error' ? 'text-amber-d' : 'text-text-2'}`}>
        {detail}
      </p>
    </div>
  )
}

export function PreviewInputs({
  inputs,
  formatNumber,
}: {
  inputs: ContextBundlePreviewInput[]
  formatNumber: (value: number) => string
}): JSX.Element {
  const { t } = useT()
  return (
    <div>
      <h3 className="mb-2 text-caption font-semibold text-text-2">
        {t('progress.bundle_documents_heading')}
      </h3>
      <ul className="space-y-2" aria-label={t('progress.bundle_inputs_label')}>
        {inputs.map((input) => (
          <li
          className="rounded-md border border-border bg-fill px-3 py-2.5"
            key={`${input.kind}:${input.path}`}
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <FileText className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 break-all text-caption font-semibold text-text">{input.path}</code>
                  <span className="rounded-sm bg-fill-2 px-1.5 py-0.5 font-mono text-micro text-text-2">
                    {input.kind}
                  </span>
                  <span className="rounded-sm bg-accent-t px-1.5 py-0.5 font-mono text-micro text-accent-d">
                    {input.mode}
                  </span>
                </div>
                <p className="mt-1 text-caption leading-5 text-text-3">
                  {t(REASON_I18N_KEYS[input.reasonCode])}
                </p>
                <p className="mt-1 font-mono text-micro tabular-nums text-text-2">
                  {t('progress.bundle_input_bytes', {
                    source: formatNumber(input.sourceBytes),
                    materialized: formatNumber(input.materializedBytes),
                  })}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ContextBundleLoading(): JSX.Element {
  const { t } = useT()
  return (
    <div role="status" className="space-y-3">
      <span className="text-caption text-text-3">{t('progress.bundle_loading')}</span>
      <div
        className="space-y-2 rounded-md border border-border bg-fill p-3"
        data-testid="context-bundle-loading-skeleton"
        aria-hidden="true"
      >
        <div className="h-3 w-28 rounded-full bg-fill-2" />
        <div className="h-2 w-full rounded-full bg-fill-2" />
        <div className="h-3 w-40 rounded-full bg-fill-2" />
      </div>
    </div>
  )
}
