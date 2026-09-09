import { isPhase, type ChangeSnapshot } from '../types'
import { changeWorkflow, decisionKind } from '../model/changeModel'
import { gateEvidence, VERIFY_STATUS_FIELDS, type EvidenceChip } from '../model/evidence'
import { diagnoseFailureWithCause } from '../shared/failureDiagnosis'
import {
  missingGateArtifacts,
  type ProgressRow,
  type ProgressRules,
  type ProgressState,
} from '../model/progressModel'
import type { PillTone } from '../shell/ThreeColumns'

export type Tr = (key: string, vars?: Record<string, string | number>) => string

function rowKeyOf(root: string, name: string): string {
  return `${name}@${root}`
}

export function fieldStr(change: ChangeSnapshot, key: string): string {
  const value = change.fields[key]
  return typeof value === 'string' ? value : ''
}

export function rootBasename(root: string): string {
  const parts = root.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? root
}

export function stepLabel(
  step: string,
  rules: Pick<ProgressRules, 'executionModel' | 'labelByStep'> | undefined,
  t: Tr,
): string {
  const custom = rules?.executionModel === 'phase-manifest'
    ? undefined
    : rules?.labelByStep?.[step]
  if (custom) return custom
  return isPhase(step) ? t(`phases.${step}`) : step
}

export interface RowSemantics {
  tone: 'green' | 'red'
  badgeText: string
  lead: string
}

/** gate / failed 行的判定文案（与旧进度页同源：inbox.* 键仍是判定语义的唯一真源）。 */
function rowSemantics(
  change: ChangeSnapshot,
  state: ProgressState,
  evidence: EvidenceChip[],
  t: Tr,
): RowSemantics {
  if (state === 'failed') {
    const attempts = fieldStr(change, 'automation_attempts')
    const error = fieldStr(change, 'automation_last_error') || t('detail.fail_generic')
    return {
      tone: 'red',
      badgeText: attempts === '' ? t('inbox.badge_failed_plain') : t('inbox.badge_failed', { n: attempts }),
      lead: attempts === ''
        ? t('inbox.lead_failed_plain', { err: error })
        : t('inbox.lead_failed', { err: error, n: attempts }),
    }
  }
  if (!evidence.some((chip) => !chip.unset)) {
    return {
      tone: 'red',
      badgeText: t('inbox.badge_judge'),
      lead: t('inbox.lead_judge', { wf: changeWorkflow(change) }),
    }
  }
  const kind = decisionKind(change)
  const failedTracks = evidence.filter(
    (chip) => (VERIFY_STATUS_FIELDS as readonly string[]).includes(chip.key) && chip.tone !== 'pass',
  )
  if (kind === 'verify' && failedTracks.length > 0) {
    return {
      tone: 'red',
      badgeText: t('inbox.badge_judge'),
      lead: t('detail.why_gate', {
        names: failedTracks.map((chip) => chip.key.replace(/_result$/, '')).join('、'),
      }),
    }
  }
  return {
    tone: 'green',
    badgeText: t('inbox.badge_pass'),
    lead: kind === 'verify' ? t('inbox.lead_verify_pass') : t(`inbox.awaiting.${kind}`),
  }
}

export interface FlatRow {
  key: string
  row: ProgressRow
  rules: ProgressRules | undefined
  workflow: string
  need: boolean
  cancelled: boolean
  /** 已归档 change：只读留档，不进「需要你 / 进行中 / 等待中」计数。 */
  archived: boolean
}

export function toFlatRow(row: ProgressRow, rules: ProgressRules | undefined, workflow: string, archived = false): FlatRow {
  const need = !archived && (row.state === 'gate' || row.state === 'failed')
  const cancelled = row.state === 'failed'
    && diagnoseFailureWithCause(
      fieldStr(row.change, 'automation_cause'),
      fieldStr(row.change, 'automation_last_error'),
    ).cause === 'cancelled'
  return { key: rowKeyOf(row.root, row.change.name), row, rules, workflow, need, cancelled, archived }
}

export interface RowBadge {
  tone: PillTone
  text: string
  /** 一句人话说明（gate / failed 行才有判定导语）。 */
  lead: string
}

/** 任务卡与右列头部共用的一枚状态徽标；判定与旧进度页 rowSemantics 同源。 */
export function rowBadgeOf(fr: FlatRow, t: Tr): RowBadge {
  const change = fr.row.change
  if (fr.archived) return { tone: 'done', text: t('workspace.state_archived'), lead: t('workspace.state_archived_lead') }
  const phase = stepLabel(change.phase, fr.rules, t)
  switch (fr.row.state) {
    case 'gate': {
      const sem = rowSemantics(change, 'gate', gateEvidence(change, fr.rules), t)
      return { tone: sem.tone === 'green' ? 'pending' : 'blocked', text: sem.badgeText, lead: sem.lead }
    }
    case 'failed': {
      if (fr.cancelled) return { tone: 'pending', text: t('progress.badge_cancelled'), lead: t('failure.hint_cancelled') }
      const sem = rowSemantics(change, 'failed', [], t)
      return { tone: 'blocked', text: sem.badgeText, lead: sem.lead }
    }
    case 'running':
      return { tone: 'running', text: t('progress.badge_running', { phase }), lead: t('detail.verdict_running') }
    case 'queued':
      return { tone: 'neutral', text: t('progress.state_queued'), lead: t('detail.verdict_queued') }
    case 'agent': {
      const missing = missingGateArtifacts(change, fr.rules)
      return {
        tone: 'neutral',
        text: missing.length > 0 ? t('progress.state_agent_missing', { fields: missing.join(' ') }) : t('progress.state_agent'),
        lead: t('detail.verdict_agent'),
      }
    }
  }
}
