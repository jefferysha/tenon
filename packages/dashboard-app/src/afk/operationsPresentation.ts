import type { AutomationStarterTemplate } from '../api/client'

export const operationCard = 'rounded-md border border-border bg-card p-4'
export const operationInput = 'h-9 w-full rounded-md border border-border bg-bg px-3 text-body text-text outline-none focus:border-(--accent)'
export const operationButton = 'h-9 rounded-md bg-btn-bg px-3.5 text-caption font-bold text-btn-fg transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-45'
export const operationGhost = 'h-9 rounded-md border border-border bg-card px-3.5 text-caption font-semibold text-text-2 hover:bg-fill disabled:opacity-45'

const STARTER_COPY_KEYS: Record<string, { title: string; description: string }> = {
  'pr-babysitter': { title: 'operations.starter_pr_babysitter_title', description: 'operations.starter_pr_babysitter_desc' },
  'daily-triage': { title: 'operations.starter_daily_triage_title', description: 'operations.starter_daily_triage_desc' },
  'ci-sweeper': { title: 'operations.starter_ci_sweeper_title', description: 'operations.starter_ci_sweeper_desc' },
  'post-merge-cleanup': { title: 'operations.starter_post_merge_cleanup_title', description: 'operations.starter_post_merge_cleanup_desc' },
  'dependency-sweeper': { title: 'operations.starter_dependency_sweeper_title', description: 'operations.starter_dependency_sweeper_desc' },
  'changelog-drafter': { title: 'operations.starter_changelog_drafter_title', description: 'operations.starter_changelog_drafter_desc' },
  'issue-triage': { title: 'operations.starter_issue_triage_title', description: 'operations.starter_issue_triage_desc' },
}

export function starterCopy(item: AutomationStarterTemplate, t: (key: string) => string): { title: string; description: string } {
  const keys = STARTER_COPY_KEYS[item.id]
  return keys ? { title: t(keys.title), description: t(keys.description) } : { title: item.id, description: item.goal }
}

export function riskLabel(value: string, t: (key: string) => string): string {
  if (value === 'low') return t('operations.risk_low')
  if (value === 'medium') return t('operations.risk_medium')
  if (value === 'high') return t('operations.risk_high')
  return value
}
