import { isPhase, type ChangeSnapshot } from '../types'
import { changeWorkflow, decisionKind } from '../model/changeModel'
import { VERIFY_STATUS_FIELDS, type EvidenceChip } from '../model/evidence'
import { diagnoseFailureWithCause } from '../shared/failureDiagnosis'
import { BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import {
  executionProvenance,
  type ProgressRow,
  type ProgressRules,
  type ProgressState,
} from '../model/progressModel'

export type Tr = (key: string, vars?: Record<string, string | number>) => string

export function rowKeyOf(root: string, name: string): string {
  return `${name}@${root}`
}

export interface RowPatch {
  phase?: string
  fields?: Record<string, string>
  base: { phase: string; fields: Record<string, string> }
}

export function fieldStr(change: ChangeSnapshot, key: string): string {
  const value = change.fields[key]
  return typeof value === 'string' ? value : ''
}

export function patchLanded(patch: RowPatch, change: ChangeSnapshot): boolean {
  if (patch.phase !== undefined && change.phase !== patch.phase) return false
  return !patch.fields
    || Object.entries(patch.fields).every(([key, value]) => fieldStr(change, key) === value)
}

export function patchMovedFromBase(patch: RowPatch, change: ChangeSnapshot): boolean {
  if (patch.phase !== undefined && change.phase !== patch.base.phase) return true
  return patch.fields
    ? Object.keys(patch.fields).some((key) => fieldStr(change, key) !== (patch.base.fields[key] ?? ''))
    : false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    return isRecord(body) && typeof body.error === 'string' ? body.error : ''
  } catch {
    return ''
  }
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

export function rowSemantics(
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

export interface RowBadge {
  tone: 'green' | 'red' | 'blue' | 'amb' | 'neutral'
  text: string
}

export interface FlatRow {
  key: string
  row: ProgressRow
  rules: ProgressRules | undefined
  workflow: string
  need: boolean
  cancelled: boolean
}

export function toFlatRow(
  row: ProgressRow,
  rules: ProgressRules | undefined,
  workflow: string,
): FlatRow {
  const need = row.state === 'gate' || row.state === 'failed'
  const cancelled = row.state === 'failed'
    && diagnoseFailureWithCause(
      fieldStr(row.change, 'automation_cause'),
      fieldStr(row.change, 'automation_last_error'),
    ).cause === 'cancelled'
  return { key: rowKeyOf(row.root, row.change.name), row, rules, workflow, need, cancelled }
}

export function compareArchived(left: ChangeSnapshot, right: ChangeSnapshot): number {
  if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export const DECK_TABS = ['all', 'need', 'run', 'queue'] as const
export type DeckTab = (typeof DECK_TABS)[number]

export function deckMatch(row: FlatRow, tab: DeckTab): boolean {
  if (tab === 'all') return true
  if (tab === 'need') return row.need
  if (tab === 'run') return row.row.state === 'running'
  return row.row.state === 'queued' || row.row.state === 'agent'
}

export function inSandbox(row: FlatRow): boolean {
  return executionProvenance(row.row.change) === 'automation'
}

export const DRAWER_FOCUSABLE_SEL =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

export const BTN_GO_CLS =
  `${BUTTON_SOLID} min-h-9 px-3 py-1.5 text-xs`
export const BTN_NEG_CLS =
  `${BUTTON_GHOST} min-h-9 border-border bg-card px-3 py-1.5 text-xs text-red-d hover:border-red-b hover:bg-red-t hover:text-red-d`
export const BADGE_TONE_CLS: Record<RowBadge['tone'], string> = {
  green: 'bg-green-t text-green-d',
  red: 'bg-red-t text-red-d',
  blue: 'bg-accent-t text-accent-d',
  amb: 'bg-amb-t text-amb-d',
  neutral: 'bg-fill-2 text-text-2',
}
