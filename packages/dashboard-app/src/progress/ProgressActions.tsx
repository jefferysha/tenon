import { useRef } from 'react'
import { ArrowRight, Copy, Square, Undo2 } from 'lucide-react'
import type { PlannedTransition } from '../model/events'
import { plannedTransition } from '../model/events'
import { outputPresentation } from '../shared/outputPresentation'
import {
  formatReadinessBlocker,
  missingGateArtifacts,
  readinessForTransition,
} from '../model/progressModel'
import type { SessionLink } from '../api/client'
import { shellQuote } from '../shared/shellQuote'
import {
  BTN_GO_CLS,
  BTN_NEG_CLS,
  fieldStr,
  stepLabel,
  type FlatRow,
  type Tr,
} from './progressViewModel'

export interface ProgressActionsProps {
  row: FlatRow
  busy: boolean
  sessionLink?: SessionLink
  t: Tr
  lang: 'zh' | 'en'
  onTransition: (root: string, name: string, transition: PlannedTransition) => void
  onKill: (root: string, name: string) => void
  onToast?: (message: string) => void
}

export function ProgressActions({
  row,
  busy,
  sessionLink,
  t,
  lang,
  onTransition,
  onKill,
  onToast,
}: ProgressActionsProps): JSX.Element | null {
  const tRef = useRef(t)
  tRef.current = t
  const name = row.row.change.name
  const testId = (action: string): string => `prg9-dw-${action}-${name}`
  const readableMissing = (fields: string[]): string => fields.map((field) => outputPresentation(field, lang).label).join(' · ')
  const readableBlockers = (blockers: string[]): string => blockers.map((blocker) => {
    // Readiness can return a field id or a diagnostic such as `capability:…`; only
    // plain field ids are translated so diagnostics remain truthful and actionable.
    return /^[a-z][a-z0-9_-]*$/.test(blocker) ? outputPresentation(blocker, lang).label : blocker
  }).join(' · ')
  if (row.row.state === 'gate' || row.row.state === 'agent') {
    const rules = row.rules
    if (!rules) return null
    const transitions = (rules.transitions[row.row.change.phase] ?? [])
      .map((edge): PlannedTransition | null => {
        const transition = plannedTransition(rules, row.row.change.phase, edge.to)
        return transition?.event === edge.event
          ? transition
          : transition === null
            ? null
            : { ...transition, event: edge.event }
      })
      .filter((transition): transition is PlannedTransition => transition !== null)
    const forward = transitions.filter((transition) => !transition.backward)
    const backward = transitions.filter((transition) => transition.backward)
    if (transitions.length === 0) return null
    const readiness = (transition: PlannedTransition) => readinessForTransition(row.row.change, transition.event)
    const forwardBlockers = forward.flatMap((transition) => {
      const result = readiness(transition)
      return result?.ready === true
        ? []
        : (result?.blockers ?? [{ kind: 'capability-unavailable' as const, guardType: 'readiness', capability: 'readiness' }])
    })
    const showActions = row.row.state === 'gate'
      || forwardBlockers.length > 0
      || backward.some((transition) => readiness(transition)?.ready === true)
    if (!showActions) {
      const missing = missingGateArtifacts(row.row.change, rules)
      return missing.length === 0 ? null : (
        <span className="text-xs text-text-3" data-testid={`prg9-note-${name}`}>
          {t('progress.note_agent_missing', { fields: readableMissing(missing) })}
        </span>
      )
    }
    return (
      <>
        {forward.map((transition, index) => (
          <button
            key={`forward-${transition.event}`}
            type="button"
            className={BTN_GO_CLS}
            data-testid={index === 0 ? testId('pass') : testId(`fw-${transition.event}`)}
            disabled={busy || readiness(transition)?.ready !== true}
            title={readiness(transition)?.ready === true ? undefined : forwardBlockers.map(formatReadinessBlocker).join(' · ')}
            onClick={() => {
              if (readiness(transition)?.ready === true) onTransition(row.row.root, name, transition)
            }}
          >
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            {index === 0
              ? t('progress.act_pass_to', { to: stepLabel(transition.to, rules, t) })
              : t('inbox.act_forward', { to: transition.event })}
          </button>
        ))}
        {backward.map((transition, index) => (
          <button
            key={`backward-${transition.event}`}
            type="button"
            className={BTN_NEG_CLS}
            data-testid={index === 0 ? testId('reject') : testId(`bw-${transition.event}`)}
            disabled={busy || readiness(transition)?.ready !== true}
            onClick={() => {
              if (readiness(transition)?.ready === true) onTransition(row.row.root, name, transition)
            }}
          >
            <Undo2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            {t('inbox.act_backward', { to: stepLabel(transition.to, rules, t) })}
          </button>
        ))}
        {forwardBlockers.length > 0 && (
        <span className="text-xs text-text-3" data-testid={`prg9-note-${name}`}>
            {t('progress.note_agent_missing', { fields: readableBlockers(forwardBlockers.map(formatReadinessBlocker)) })}
          </span>
        )}
      </>
    )
  }
  if (row.row.state === 'failed') {
    const rerun = `tenon afk enqueue ${shellQuote(name)}`
    const worktree = fieldStr(row.row.change, 'automation_worktree')
    const chip = sessionLink?.found && sessionLink.resumeCmd
      ? { label: t('progress.cmd_resume'), command: sessionLink.resumeCmd }
      : row.cancelled
        ? { label: t('progress.cmd_rerun_cxl'), command: rerun }
        : worktree !== ''
          ? { label: t('progress.cmd_takeover'), command: `cd ${shellQuote(worktree)}` }
          : { label: t('progress.cmd_rerun'), command: rerun }
    return (
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-2 rounded-[7px] border border-code-border bg-code-bg px-2.5 py-[5px] text-left text-xs text-text-2 hover:border-(--accent)"
        data-testid={testId('cmd')}
        title={chip.command}
        aria-label={`${chip.label}：${chip.command}`}
        onClick={() => {
          void navigator.clipboard?.writeText(chip.command).then(() => {
            onToast?.(tRef.current('detail.copied', { value: chip.command }))
          })
        }}
      >
        <Copy className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} aria-hidden="true" />
        {chip.label}
        <span className="truncate font-mono">{chip.command}</span>
      </button>
    )
  }
  if (row.row.state === 'running') {
    const automation = fieldStr(row.row.change, 'automation')
    if (row.row.change.terminalActivity !== undefined && automation !== 'running') return null
    return (
      <button
        type="button"
        className={BTN_NEG_CLS}
        data-testid={testId('kill')}
        disabled={busy || automation !== 'running'}
        onClick={() => onKill(row.row.root, name)}
      >
        <Square className="h-3 w-3" aria-hidden="true" /> {t('progress.act_kill')}
      </button>
    )
  }
  return null
}
