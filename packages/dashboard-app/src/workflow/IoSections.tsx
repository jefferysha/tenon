import { useState } from 'react'
import { FileText, Hash, Lock, Plus, X } from 'lucide-react'
import type { WbIoSlot } from '../api/governanceTypes'
import { useT } from '../i18n'
import { slotLabel } from '../workspace/taskModel'
import type { SlotCandidate } from './slotCatalog'

const FIELD_CLS = 'min-h-9 rounded-sm border border-border bg-card px-2.5 text-body text-text outline-none focus:border-accent-b disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3'
const ROW_CLS = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5'

function SlotIcon({ slot }: { slot: Pick<WbIoSlot, 'kind'> & { type?: string } }): JSX.Element {
  const Icon = slot.kind === 'field' && slot.type !== 'file_path' ? Hash : FileText
  return <Icon className="size-4 flex-none text-text-3" aria-hidden="true" />
}

function candidateKey(candidate: SlotCandidate): string {
  return `${candidate.kind}:${candidate.id}`
}

/** 槽位溯源：产出者（阶段 / 技能）一句 + 它在 YAML 里的位置。 */
export interface SlotProvenance {
  text: string
  path: string
}

function Provenance({ info, testId }: { info: SlotProvenance | undefined; testId: string }): JSX.Element | null {
  if (info === undefined) return null
  return (
    <span className="block truncate font-mono text-caption text-text-3" data-testid={testId}>
      <span className="text-text-2">{info.text}</span>
      {info.text !== '' && info.path !== '' && ' · '}
      {info.path}
    </span>
  )
}

export interface OutputsSectionProps {
  slots: readonly WbIoSlot[]
  candidates: readonly SlotCandidate[]
  editable: boolean
  labelOf: (stepId: string) => string
  provenance?: (slot: WbIoSlot) => SlotProvenance
  onAdd: (candidate: SlotCandidate) => void
  onRemove: (candidate: SlotCandidate) => void
}

/** 输出：文档槽位（契约固定带锁）与值槽位；下拉添加、行内移除；每行可带溯源。 */
export function OutputsSection({ slots, candidates, editable, labelOf, provenance, onAdd, onRemove }: OutputsSectionProps): JSX.Element {
  const { t } = useT()
  const [pending, setPending] = useState('')
  const pendingCandidate = candidates.find((candidate) => candidateKey(candidate) === pending)
  return (
    <section data-testid="stage-outputs">
      {slots.length === 0 ? (
        <p className="rounded-md border border-dashed border-amber-b bg-amber-t px-4 py-4 text-center text-body text-amber-d" role="status" data-testid="stage-outputs-empty">{t('workflow.lint_no_output')}</p>
      ) : (
        <ul className="grid gap-2">
          {slots.map((slot) => {
            const locked = slot.kind === 'document' && slot.locked
            const consumers = slot.consumers.map(labelOf).join(' / ')
            return (
              <li key={`${slot.kind}:${slot.id}`} className={ROW_CLS} data-testid={`output-slot-${slot.kind}-${slot.id}`} data-locked={locked}>
                <SlotIcon slot={slot} />
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold text-text">{slotLabel(slot, t)}</span>
                  {consumers !== '' && <span className="block truncate text-caption text-text-2">{t('workflow.consumed_by', { stages: consumers })}</span>}
                  <Provenance info={provenance?.(slot)} testId={`output-provenance-${slot.kind}-${slot.id}`} />
                </span>
                {locked ? (
                  <Lock className="size-3.5 text-text-3" aria-label={t('workflow.locked')} data-testid={`output-lock-${slot.id}`} />
                ) : editable ? (
                  <button type="button" className="grid size-7 place-items-center rounded-xs text-text-3 hover:bg-fill hover:text-red-d" aria-label={t('workflow.remove_output', { id: slotLabel(slot, t) })} data-testid={`output-remove-${slot.kind}-${slot.id}`} onClick={() => onRemove(slot.kind === 'document' ? { kind: 'document', id: slot.id } : { kind: 'field', id: slot.id, type: slot.type })}>
                    <X className="size-4" aria-hidden="true" />
                  </button>
                ) : <span />}
              </li>
            )
          })}
        </ul>
      )}
      {editable && candidates.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <select className={`${FIELD_CLS} min-w-0 flex-1`} value={pending} data-testid="output-picker" onChange={(event) => setPending(event.target.value)}>
            <option value="">{t('workflow.add_output')}</option>
            {candidates.map((candidate) => <option key={candidateKey(candidate)} value={candidateKey(candidate)}>{slotLabel(candidate, t)}</option>)}
          </select>
          <button type="button" className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-border bg-card px-3 text-body text-text-2 hover:border-text-3 hover:text-text disabled:opacity-50" disabled={pendingCandidate === undefined} data-testid="output-add" onClick={() => { if (pendingCandidate) { onAdd(pendingCandidate); setPending('') } }}>
            <Plus className="size-4" aria-hidden="true" />
            {t('workflow.add')}
          </button>
        </div>
      )}
    </section>
  )
}

export interface InputsSectionProps {
  /** 上游全部输出（候选）。 */
  upstream: readonly SlotCandidate[]
  /** 本阶段当前读取的槽位。 */
  inputs: readonly WbIoSlot[]
  editable: boolean
  labelOf: (stepId: string) => string
  provenance?: (slot: WbIoSlot) => SlotProvenance
  onToggle: (candidate: SlotCandidate, on: boolean) => void
}

/** 输入：上游输出的勾选清单；契约固定的文档读取不可取消；已勾选的行带溯源。 */
export function InputsSection({ upstream, inputs, editable, labelOf, provenance, onToggle }: InputsSectionProps): JSX.Element {
  const { t } = useT()
  const active = new Map(inputs.map((slot) => [`${slot.kind}:${slot.id}`, slot]))
  return (
    <section data-testid="stage-inputs">
      {upstream.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-4 text-center text-body text-text-3" role="status">{t('workflow.no_upstream')}</p>
      ) : (
        <ul className="grid gap-2">
          {upstream.map((candidate) => {
            const key = candidateKey(candidate)
            const slot = active.get(key)
            const checked = slot !== undefined
            const locked = slot?.kind === 'document' && slot.locked
            const producer = slot?.kind === 'document' ? slot.producers.map(labelOf).join(' / ') : slot?.kind === 'field' && slot.producer ? labelOf(slot.producer) : ''
            return (
              <li key={key}>
                <label className={`${ROW_CLS} cursor-pointer has-[:disabled]:cursor-default`} data-testid={`input-row-${candidate.kind}-${candidate.id}`}>
                  <input type="checkbox" className="size-4 accent-(--accent)" checked={checked} disabled={!editable || locked} data-testid={`input-check-${candidate.kind}-${candidate.id}`} onChange={(event) => onToggle(candidate, event.target.checked)} />
                  <span className="min-w-0">
                    <span className="block truncate text-base font-semibold text-text">{slotLabel(candidate, t)}</span>
                    {producer !== '' && provenance === undefined && <span className="block truncate text-caption text-text-2">{t('workflow.produced_by', { stage: producer })}</span>}
                    {slot !== undefined && <Provenance info={provenance?.(slot)} testId={`input-provenance-${slot.kind}-${slot.id}`} />}
                  </span>
                  {locked ? <Lock className="size-3.5 text-text-3" aria-label={t('workflow.locked')} /> : <SlotIcon slot={candidate} />}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
