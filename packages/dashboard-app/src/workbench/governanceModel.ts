import type { WbLoopRow } from '../api/client'

export const READY_THRESHOLD = 70
export const READY_STRONG = 90
export const MIN_L2_RUNS_FOR_L3 = 5
export const BUDGET_WARN_RATIO = 0.8
export const LEVELS = ['L1', 'L2', 'L3'] as const
export type GovernanceLevel = (typeof LEVELS)[number]
export const LEVEL_MIN_SCORE: Record<GovernanceLevel, number> = {
  L1: 0,
  L2: READY_THRESHOLD,
  L3: READY_STRONG,
}
export const LEVEL_SHORT_KEY: Record<GovernanceLevel, string> = {
  L1: 'workbench.gov_lv1_s',
  L2: 'workbench.gov_lv2_s',
  L3: 'workbench.gov_lv3_s',
}
export const TOKENS_K_MIN = 10
export const TOKENS_K_MAX = 500
export const TOKENS_K_STEP = 10
export const RECO_TOKENS_K = 100
export const BUDGET_COMMIT_MS = 350

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export function fmtK(value: unknown): string {
  const number = finiteOrNull(value)
  return number === null ? '—' : `${Math.round(number / 1000)}k`
}

export function tokensKOf(row: WbLoopRow): number {
  const max = row.budget_decl?.max_tokens_per_day
  return max === null || max === undefined
    ? RECO_TOKENS_K
    : clamp(Math.round(max / 10000) * 10, TOKENS_K_MIN, TOKENS_K_MAX)
}

/** Stable identity for the facts presented by the promotion confirmation. */
export function promotionDecisionKey(root: string, row: WbLoopRow | null): string {
  if (row === null) return `${root}\u0000none`
  return JSON.stringify({
    root,
    rowRoot: row.root,
    id: row.id,
    autonomy: row.autonomy_level,
    readiness: row.readiness,
    budget: row.budget,
    graduation: row.graduation ?? null,
  })
}

export const RAIL_TW = 'flex w-full flex-col gap-3.5'
export const GCARD_TW = 'rounded-md border border-border bg-card px-4 py-4 shadow-sm'
export const GH_TW = 'mb-3 flex items-center justify-between gap-2'
export const GH_B_TW = 'text-base font-[750] text-text'
export const MINIBADGE_TW = 'inline-block rounded-full border px-2 py-0.5 text-micro font-extrabold whitespace-nowrap'
export const TAG_RW_TW = 'border-green-b bg-green-t text-green-d'
export const TAG_DERIVED_TW = 'border-accent-b bg-accent-t text-accent-d'
export const GNOTE_TW = 'mt-2.5 text-caption leading-[1.55] text-text-3'
export const GNOTE_ERR_TW = 'mt-2.5 rounded-sm border border-red-b bg-red-t px-2.5 py-2 text-caption leading-[1.55] font-semibold text-red-d'
export const GNOTE_HINT_TW = 'mt-2.5 rounded-sm border border-amber-b bg-amber-t px-2.5 py-2 text-caption leading-[1.55] font-semibold text-amber-d'
export const BAND_TW: Record<string, string> = {
  ready: 'bg-green-t text-green-d',
  'mostly-ready': 'bg-amber-t text-amber-d',
  'not-ready': 'bg-red-t text-red-d',
}
export const BAND_KEY: Record<string, string> = {
  ready: 'workbench.gov_band_ready',
  'mostly-ready': 'workbench.gov_band_mostly',
  'not-ready': 'workbench.gov_band_not',
}
export const BAR_TW: Record<string, string> = {
  ready: 'bg-green',
  'mostly-ready': 'bg-amber-d',
  'not-ready': 'bg-red',
}
export const LAMP_TW: Record<string, string> = {
  ok: 'bg-green',
  warn: 'bg-amber-d',
  tripped: 'bg-red',
}
