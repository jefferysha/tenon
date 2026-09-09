import type { WbLoopRow, WbSkillEntry } from '../api/client'
import { formatServerProse } from '../api/transport'
import type { PillTone } from '../shell/ThreeColumns'
import type { Snapshot } from '../types'

export type ReadinessState = 'ready' | 'blocked' | 'optional-unavailable' | 'unknown'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 就绪灯 → 模板状态 pill：可选能力不可用走琥珀，未知走中性灰，绝不画成绿色。 */
export const READINESS_TONE: Record<ReadinessState, PillTone> = {
  ready: 'done',
  blocked: 'blocked',
  'optional-unavailable': 'pending',
  unknown: 'neutral',
}

export interface ProjectRisk {
  key: string
  root: string
  title: string
  rootHint: string
  details: string[]
  testId: string
}

function rootName(root: string): string {
  const name = boundedRootTail(root).split(/[\\/]+/).filter(Boolean).pop() ?? 'unknown'
  return shortenRootSegment(name, 48)
}

function shortenRootSegment(segment: string, limit = 20): string {
  const points = Array.from(segment)
  if (points.length <= limit) return segment
  const headLength = Math.floor((limit - 1) / 2)
  return `${points.slice(0, headLength).join('')}…${points.slice(-(limit - headLength - 1)).join('')}`
}

function boundedRootTail(root: string): string {
  const tail = root.slice(-256)
  const first = tail.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail
}

function boundedRootHint(root: string): string {
  const segments = boundedRootTail(root).split(/[\\/]+/).filter(Boolean)
  const suffix = segments.slice(-2).map((segment) => shortenRootSegment(segment)).join('/')
  return `…/${suffix || 'unknown'}`
}

function stableRootId(root: string): string {
  const sample = `${root.length}:${root.slice(0, 96)}:${root.slice(-96)}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`.slice(0, 12)
}

function disambiguateRootHints(rows: readonly ProjectRisk[]): ProjectRisk[] {
  const rootsByHint = new Map<string, Set<string>>()
  for (const row of rows) {
    const roots = rootsByHint.get(row.rootHint) ?? new Set<string>()
    roots.add(row.root)
    rootsByHint.set(row.rootHint, roots)
  }
  const idsByRoot = new Map<string, string>()
  for (const roots of rootsByHint.values()) {
    if (roots.size < 2) continue
    const usedIds = new Map<string, number>()
    for (const root of roots) {
      const baseId = stableRootId(root)
      const occurrence = (usedIds.get(baseId) ?? 0) + 1
      usedIds.set(baseId, occurrence)
      idsByRoot.set(root, occurrence === 1 ? baseId : `${baseId}-${occurrence}`)
    }
  }
  return rows.map((row) => {
    const stableId = idsByRoot.get(row.root)
    return stableId !== undefined
      ? { ...row, rootHint: `${row.rootHint} · #${stableId}` }
      : row
  })
}

/** Unknown legacy tier stays conservative; explicit conditional/optional entries are informational. */
export function blocksMachine(skill: WbSkillEntry): boolean {
  return skill.available !== false && (skill.tier === undefined || skill.tier === 'mandatory' || skill.tier === 'recommended')
}

export function credentialSourceLabel(source: string, t: Translate): string {
  const labels: Record<string, string> = {
    'host-env': t('machine.credential_source_host_env'),
    'secrets-file': t('machine.credential_source_secrets_file'),
    'default-home': t('machine.credential_source_default_home'),
    secrets: t('machine.credential_source_secrets_file'),
    'not detected': t('machine.credential_source_missing'),
  }
  return labels[source] ?? source
}

export function machineRisks(snapshot: Snapshot | null, loops: readonly WbLoopRow[], t: Translate, exposeServerDetail: boolean): ProjectRisk[] {
  const rows: ProjectRisk[] = []
  for (const project of snapshot?.projects ?? []) {
    if (project.error !== undefined) {
      rows.push({
        key: `project:${project.root}`,
        root: project.root,
        title: rootName(project.root),
        rootHint: boundedRootHint(project.root),
        details: [t('machine.risk_project_unreadable', {
          error: formatServerProse(project.error, t, {
            exposeServerDetail,
            fallback: t('machine.risk_unknown_error'),
          }),
        })],
        testId: `machine-risk-open-project-${rootName(project.root)}`,
      })
      continue
    }
    for (const change of project.changes) {
      const automation = typeof change.fields.automation === 'string' ? change.fields.automation : ''
      if (change.archived !== 'true' && (automation === 'failed' || automation === 'conflict')) {
        rows.push({ key: `change:${project.root}:${change.name}`, root: project.root, title: change.name, rootHint: boundedRootHint(project.root), details: [t(`machine.risk_automation_${automation}`), t('machine.risk_project_name', { name: rootName(project.root) })], testId: `machine-risk-open-change-${change.name}` })
      }
    }
  }
  for (const loop of loops) {
    const details: string[] = []
    if (loop.ledger?.health === 'degraded') details.push(t('machine.risk_ledger_degraded', { count: loop.ledger.rejected_records }))
    if (loop.ledger?.health === 'missing') details.push(t('machine.risk_ledger_missing'))
    if (loop.budget.breaker === 'tripped') details.push(t('machine.risk_budget_tripped'))
    if (loop.budget.breaker === 'warn') details.push(t('machine.risk_budget_warn'))
    if (loop.readiness.band === 'not-ready') details.push(t('machine.risk_readiness_not_ready'))
    if (loop.readiness.band === 'mostly-ready') details.push(t('machine.risk_readiness_mostly_ready'))
    if (loop.status === 'active' && loop.skill_bundle_id === null) details.push(t('machine.risk_skill_bundle_missing'))
    if (details.length > 0) rows.push({ key: `loop:${loop.root}:${loop.id}`, root: loop.root, title: loop.name || loop.id, rootHint: boundedRootHint(loop.root), details, testId: `machine-risk-open-${loop.id}` })
  }
  return disambiguateRootHints(rows)
}

/** 风险行的 testid 尾段：loop 用 id，其余用标题（与旧机器页保持一致，测试沿用）。 */
export function riskRowId(risk: ProjectRisk): string {
  return risk.key.startsWith('loop:') ? (risk.key.split(':').at(-1) ?? risk.title) : risk.title
}

/** 浏览器给出的平台事实；jsdom 与隐私模式下为空串，此时返回 null 由界面省略。 */
export function detectPlatform(): string | null {
  if (typeof navigator === 'undefined') return null
  const platform = navigator.platform
  return typeof platform === 'string' && platform.trim() !== '' ? platform : null
}
