import { useT } from '../i18n'
import type {
  VerificationEvidenceKind,
  VerificationEvidenceStatus,
} from '../api/client'

export interface VerificationEvidenceEditorEntry {
  id: number
  kind: VerificationEvidenceKind
  title: string
  status: VerificationEvidenceStatus
  command: string
  result: string
  skipReason: string
}

export type VerificationEvidenceEditorField =
  | 'title'
  | 'kind'
  | 'status'
  | 'command'
  | 'result'
  | 'skipReason'

interface VerificationEvidenceEntryEditorProps {
  entry: VerificationEvidenceEditorEntry
  index: number
  disabled?: boolean
  errorId?: string
  invalidField?: VerificationEvidenceEditorField
  onChange: (patch: Partial<VerificationEvidenceEditorEntry>) => void
  onRemove: () => void
}

const CONTROL = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text outline-none transition focus:border-(--accent) focus:ring-2 focus:ring-accent-t'

export function VerificationEvidenceEntryEditor({
  entry,
  index,
  disabled = false,
  errorId,
  invalidField,
  onChange,
  onRemove,
}: VerificationEvidenceEntryEditorProps): JSX.Element {
  const { t } = useT()
  function errorProps(field: VerificationEvidenceEditorField) {
    const invalid = invalidField === field
    return {
      'aria-describedby': invalid ? errorId : undefined,
      'aria-invalid': invalid || undefined,
      'data-evidence-path': `entries[${index}].${field}`,
    }
  }
  return (
    <fieldset className="rounded-md border border-border bg-card p-4" data-testid={`evidence-entry-${entry.id}`}>
      <legend className="px-1 text-caption font-bold text-text">
        {t('detail.evidence_entry', { n: index + 1 })}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-caption font-semibold text-text-2 sm:col-span-2">
          {t('detail.evidence_title')}
          <input
            className={CONTROL}
            data-testid={`evidence-title-${entry.id}`}
            disabled={disabled}
            maxLength={240}
            onChange={(event) => onChange({ title: event.target.value })}
            placeholder={t('detail.evidence_title_placeholder')}
            value={entry.title}
            {...errorProps('title')}
          />
        </label>
        <label className="grid gap-1 text-caption font-semibold text-text-2">
          {t('detail.evidence_kind')}
          <select
            className={CONTROL}
            data-testid={`evidence-kind-${entry.id}`}
            disabled={disabled}
            onChange={(event) => onChange({ kind: event.target.value as VerificationEvidenceKind, command: '' })}
            value={entry.kind}
            {...errorProps('kind')}
          >
            {(['command', 'browser', 'review', 'other'] as const).map((kind) => (
              <option key={kind} value={kind}>{t(`detail.evidence_kind_${kind}`)}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-caption font-semibold text-text-2">
          {t('detail.evidence_status')}
          <select
            className={CONTROL}
            data-testid={`evidence-status-${entry.id}`}
            disabled={disabled}
            onChange={(event) => onChange({
              status: event.target.value as VerificationEvidenceStatus,
              result: '',
              skipReason: '',
            })}
            value={entry.status}
            {...errorProps('status')}
          >
            {(['passed', 'failed', 'skipped'] as const).map((status) => (
              <option key={status} value={status}>{t(`detail.evidence_status_${status}`)}</option>
            ))}
          </select>
        </label>
        {entry.kind === 'command' && (
          <label className="grid gap-1 text-caption font-semibold text-text-2 sm:col-span-2">
            {t('detail.evidence_command')}
            <textarea
              className={`${CONTROL} min-h-20 resize-y font-mono`}
              data-testid={`evidence-command-${entry.id}`}
              disabled={disabled}
              onChange={(event) => onChange({ command: event.target.value })}
              value={entry.command}
              {...errorProps('command')}
            />
          </label>
        )}
        <label className="grid gap-1 text-caption font-semibold text-text-2 sm:col-span-2">
          {entry.status === 'skipped' ? t('detail.evidence_skip_reason') : t('detail.evidence_result')}
          <textarea
            className={`${CONTROL} min-h-24 resize-y`}
            data-testid={entry.status === 'skipped' ? `evidence-skip-reason-${entry.id}` : `evidence-result-${entry.id}`}
            disabled={disabled}
            onChange={(event) => entry.status === 'skipped'
              ? onChange({ skipReason: event.target.value })
              : onChange({ result: event.target.value })}
            value={entry.status === 'skipped' ? entry.skipReason : entry.result}
            {...errorProps(entry.status === 'skipped' ? 'skipReason' : 'result')}
          />
        </label>
      </div>
      <button
        aria-label={t('detail.evidence_remove_entry', { n: index + 1 })}
        className="mt-3 rounded-md border border-red-b px-3 py-1.5 text-caption font-semibold text-red-d hover:bg-red-t"
        disabled={disabled}
        onClick={onRemove}
        type="button"
      >
        {t('detail.evidence_remove')}
      </button>
    </fieldset>
  )
}
