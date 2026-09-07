import { AlertTriangle, Box, BrainCircuit, Container, KeyRound, RefreshCw, ServerCog, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAfkReadiness,
  fetchDockerImages,
  fetchLoopsSnapshot,
  fetchSecrets,
  fetchSkillsRegistry,
  type WbAfkReadiness,
  type WbDockerImages,
  type WbLoopRow,
  type WbSecretsKeys,
  type WbSkillEntry,
} from '../api/client'
import { useT } from '../i18n'
import { PageHeader } from '../shared/PageHeader'
import { PANEL } from '../shared/uiRecipes'
import type { Snapshot } from '../types'
import { AdvancedPanel } from '../advanced/AdvancedPanel'
import { formatApiError, formatServerProse } from '../api/transport'

type ReadinessState = 'ready' | 'blocked' | 'optional-unavailable' | 'unknown'

interface MachineViewProps {
  snapshot: Snapshot | null
  currentRoot: string
  onOpenProject: (root: string) => void
}

interface ReadinessCardProps {
  icon: LucideIcon
  label: string
  state: ReadinessState
  detail: string
  testId: string
}

function ReadinessCard({ icon: Icon, label, state, detail, testId }: ReadinessCardProps): JSX.Element {
  const { t } = useT()
  const tone = state === 'ready'
    ? 'border-green-b bg-green-t/25 text-green-d'
    : state === 'blocked'
      ? 'border-red-b bg-red-t/25 text-red-d'
      : 'border-amber-b bg-amber-t/25 text-amber-d'
  return (
    <article className={`flex min-w-0 items-start gap-3 rounded-2xl border px-3 py-2.5 shadow-sm ${tone}`} data-state={state} data-testid={testId}>
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-card text-text shadow-sm"><Icon size={16} aria-hidden={true} /></span>
      <div className="min-w-0 flex-1">
        <h3 className="break-words font-bold leading-tight text-text [overflow-wrap:anywhere]">{label}</h3>
        <p className="truncate text-[11px] text-text-3" title={detail}>{detail}</p>
      </div>
      <span className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{t(`machine.${state}`)}</span>
    </article>
  )
}

interface ProjectRisk {
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
function blocksMachine(skill: WbSkillEntry): boolean {
  return skill.available !== false && (skill.tier === undefined || skill.tier === 'mandatory' || skill.tier === 'recommended')
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

function credentialSourceLabel(source: string, t: Translate): string {
  const labels: Record<string, string> = {
    'host-env': t('machine.credential_source_host_env'),
    'secrets-file': t('machine.credential_source_secrets_file'),
    'default-home': t('machine.credential_source_default_home'),
    secrets: t('machine.credential_source_secrets_file'),
    'not detected': t('machine.credential_source_missing'),
  }
  return labels[source] ?? source
}

function machineRisks(snapshot: Snapshot | null, loops: readonly WbLoopRow[], t: Translate, exposeServerDetail: boolean): ProjectRisk[] {
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

/**
 * 机器控制面：把原先散落在 Workbench 折叠区与 AFK 卡片里的机器事实集中到一个入口。
 * 所有状态都来自真实端点；请求失败保持 unknown，并进入 blocker 清单，绝不把“没读到”画成 ready。
 */
export function MachineView({ snapshot, currentRoot, onOpenProject }: MachineViewProps): JSX.Element {
  const { t, lang } = useT()
  const [reloadKey, setReloadKey] = useState(0)
  const [showAllRisks, setShowAllRisks] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [readiness, setReadiness] = useState<WbAfkReadiness | null>(null)
  const [images, setImages] = useState<WbDockerImages | null>(null)
  const [secrets, setSecrets] = useState<WbSecretsKeys | null>(null)
  const [skills, setSkills] = useState<WbSkillEntry[] | null>(null)
  const [loops, setLoops] = useState<WbLoopRow[] | null>(null)
  const [errors, setErrors] = useState<Array<{ source: string; cause: unknown }>>([])
  const probeRoot = currentRoot

  const load = useCallback(() => setReloadKey((value) => value + 1), [])

  useEffect(() => {
    let live = true
    setReadiness(null)
    setImages(null)
    setSecrets(null)
    setSkills(null)
    setLoops(null)
    setErrors([])

    const report = (source: string, error: unknown): void => {
      if (!live) return
      setErrors((current) => [...current, { source, cause: error }])
    }

    if (probeRoot !== '') void fetchAfkReadiness(probeRoot).then((value) => { if (live) setReadiness(value) }, (error) => report('readiness', error))

    void fetchDockerImages().then((value) => { if (live) setImages(value) }, (error) => report('docker images', error))
    void fetchSecrets().then((value) => { if (live) setSecrets(value) }, (error) => report('secrets', error))
    void fetchSkillsRegistry().then((body) => {
      if (live) setSkills(body)
    }, (error) => report('skills', error))
    void fetchLoopsSnapshot().then((value) => { if (live) setLoops(value.rows) }, (error) => report('loops', error))

    return () => { live = false }
  }, [probeRoot, reloadKey])

  const dockerImagesError = errors.find(({ source }) => source === 'docker images')?.cause
  const dockerState: ReadinessState = dockerImagesError !== undefined
    ? 'optional-unavailable'
    : images === null ? 'unknown' : images.available ? 'ready' : 'optional-unavailable'
  const imageState: ReadinessState = dockerImagesError !== undefined
    ? 'optional-unavailable'
    : readiness === null || images === null ? 'unknown' : readiness.image.present || images.images.includes(readiness.image.configured) ? 'ready' : 'optional-unavailable'
  const codexState: ReadinessState = secrets === null
    ? 'unknown'
    : readiness?.credentials.codex.OPENAI_API_KEY.set
      || readiness?.credentials.codex.CODEX_HOME.set
      || secrets.OPENAI_API_KEY.set ? 'ready' : 'unknown'
  const skillState: ReadinessState = skills === null
    ? 'unknown'
    : skills.length > 0 && skills.filter(blocksMachine).every((skill) => skill.installed) ? 'ready' : 'blocked'
  const operationsState: ReadinessState = snapshot === null ? 'unknown' : snapshot.capabilities.operations === true ? 'ready' : 'blocked'
  const readinessStates = [codexState, skillState, operationsState]
  const readinessCounts = {
    ready: readinessStates.filter((state) => state === 'ready').length,
    blocked: readinessStates.filter((state) => state === 'blocked').length,
    unknown: readinessStates.filter((state) => state === 'unknown').length,
  }

  const blockers = useMemo(() => {
    const sourceLabels: Record<string, string> = {
      readiness: t('machine.source_readiness'),
      'docker images': t('machine.source_images'),
      secrets: t('machine.source_secrets'),
      skills: t('machine.source_skills'),
      loops: t('machine.source_loops'),
    }
    const values = errors
      .filter(({ source }) => source !== 'docker images')
      .map(({ source, cause }) => `${sourceLabels[source] ?? source}: ${formatApiError(cause, t, { exposeServerDetail: lang === 'zh' })}`)
    for (const skill of skills ?? []) if (blocksMachine(skill) && !skill.installed) values.push(t('machine.blocker_skill', { skill: skill.name, command: skill.installCmd ?? t('machine.no_install_command') }))
    if (snapshot && snapshot.capabilities.operations !== true) values.push(t('machine.blocker_operations'))
    return values
  }, [errors, lang, skills, snapshot, t])
  const blockersPending = blockers.length === 0 && (
    secrets === null
    || skills === null
    || snapshot === null
    || (probeRoot !== '' && readiness === null)
  )
  const coreFactsUnknown = readinessStates.some((state) => state === 'unknown')

  const risks = useMemo(() => machineRisks(snapshot, loops ?? [], t, lang === 'zh'), [lang, loops, snapshot, t])
  const hasCurrentProject = snapshot?.projects.some((project) => project.root === currentRoot) ?? false
  const currentRisks = useMemo(
    () => currentRoot === '' || !hasCurrentProject || showAllRisks ? risks : risks.filter((risk) => risk.root === currentRoot),
    [currentRoot, hasCurrentProject, risks, showAllRisks],
  )
  const crossProjectRiskCount = !hasCurrentProject || currentRoot === '' ? 0 : risks.filter((risk) => risk.root !== currentRoot).length
  const dockerProbeError = dockerImagesError === undefined
    ? null
    : `${t('machine.source_images')}: ${formatApiError(dockerImagesError, t, { exposeServerDetail: lang === 'zh' })}`
  const configuredImage = dockerProbeError
    ?? readiness?.image.configured
    ?? t('machine.loading_signal')
  const installedSkills = skills?.filter((skill) => skill.installed).length ?? 0
  const secretSource = readiness?.credentials.codex.OPENAI_API_KEY.source
    ?? readiness?.credentials.codex.CODEX_HOME.source
    ?? (secrets?.OPENAI_API_KEY.set ? 'secrets' : 'not detected')
  const dockerDetail = dockerProbeError ?? (images === null
    ? t('machine.loading_signal')
    : images.available === false
      ? t('machine.docker_unavailable_detail')
      : t('machine.docker_detail', { count: images.images.length }))

  return (
    <section className="mx-auto w-full max-w-[1088px] pt-7 pb-5" data-testid="machine-view" data-page-frame="standard">
      <PageHeader
        eyebrow={t('machine.eyebrow')}
        title={t('machine.title')}
        description={t('machine.subtitle')}
        actions={(
          <button type="button" className="inline-flex min-h-11 items-center rounded-xl border border-border bg-card px-3.5 text-xs font-bold text-text outline-none transition-colors hover:bg-fill focus-visible:border-(--accent) focus-visible:ring-3 focus-visible:ring-accent-t" onClick={load}>
            <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />{t('machine.refresh')}
          </button>
        )}
      />

      <section data-testid="machine-readiness">
        <h2 className="mb-3 text-sm font-black text-text">{t('machine.core_readiness')}</h2>
        <p className="sr-only" role="status" aria-live="polite" data-testid="machine-readiness-summary">
          {t('machine.readiness_summary', readinessCounts)}
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="machine-readiness-grid">
          <ReadinessCard icon={KeyRound} label={t('machine.codex')} state={codexState} detail={t('machine.codex_detail', { source: credentialSourceLabel(secretSource, t) })} testId="machine-codex" />
          <ReadinessCard icon={BrainCircuit} label={t('machine.skills')} state={skillState} detail={skills ? t('machine.skills_detail', { installed: installedSkills, total: skills.length }) : t('machine.loading_signal')} testId="machine-skills" />
          <ReadinessCard icon={ServerCog} label={t('machine.operations')} state={operationsState} detail={t('machine.operations_detail')} testId="machine-operations" />
        </div>
      </section>

      <section className={`${PANEL} mt-4 p-4`} data-testid="machine-afk-readiness">
        <h2 className="text-sm font-black text-text">{t('machine.afk_readiness')}</h2>
        <p className="mt-1 mb-3 text-xs text-text-3">{t('machine.afk_optional_note')}</p>
        {probeRoot === '' && <p className="mb-3 text-xs text-text-3" role="status" data-testid="machine-project-facts-unavailable">{t('machine.project_facts_unavailable')}</p>}
        <div className="grid gap-3 md:grid-cols-2">
          <ReadinessCard icon={Container} label={t('machine.docker')} state={dockerState} detail={dockerDetail} testId="machine-docker" />
          <ReadinessCard icon={Box} label={t('machine.image')} state={imageState} detail={configuredImage} testId="machine-image" />
        </div>
      </section>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(280px,0.75fr)_minmax(520px,1.6fr)]" data-testid="machine-risk-layout">
        <section className={`${PANEL} p-4`} data-testid="machine-blockers">
          <div className="flex items-center gap-2 text-text"><AlertTriangle size={16} aria-hidden="true" /><h2 className="font-bold">{t('machine.blockers')}</h2></div>
          {blockersPending ? <p className="mt-3 text-xs text-text-3" role="status" aria-live="polite" data-testid="machine-blockers-loading">{t('machine.loading_signal')}</p> : blockers.length === 0 ? <p className={`mt-3 text-xs ${coreFactsUnknown ? 'text-text-3' : 'text-green-d'}`} role="status" aria-live="polite">{t(coreFactsUnknown ? 'machine.blockers_unknown' : 'machine.blockers_empty')}</p> : (
            <ul className="mt-3 space-y-2 p-0">
              {blockers.map((blocker, index) => <li key={`${blocker}:${index}`} className="rounded-xl border border-amber-b bg-amber-t/35 px-3 py-2 text-xs leading-relaxed text-amber-d">{blocker}</li>)}
            </ul>
          )}
        </section>
        <section className={`${PANEL} p-4`} data-testid="machine-risk-queue">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="font-bold text-text">{t('machine.risks')}</h2><p className="mt-0.5 text-xs text-text-3">{t('machine.risks_note')}</p></div>
            <div className="flex items-center gap-2">
              {crossProjectRiskCount > 0 && (
                <button
                  type="button"
                  className="rounded-full bg-fill px-2.5 py-1 font-mono text-[11px] font-bold text-text-2 hover:bg-fill-2"
                  data-testid="machine-cross-project-count"
                  aria-pressed={showAllRisks}
                  onClick={() => setShowAllRisks((value) => !value)}
                >
                  {t('machine.risks')} {crossProjectRiskCount}
                </button>
              )}
              <span className="rounded-full bg-fill px-2.5 py-1 font-mono text-xs font-bold text-text">{currentRisks.length}</span>
            </div>
          </div>
          {loops === null ? <p className="mt-4 text-xs text-text-3" role="status" aria-live="polite">{t('machine.loading_signal')}</p> : currentRisks.length === 0 ? <p className="mt-4 text-xs text-green-d" role="status" aria-live="polite">{t('machine.risks_empty')}</p> : (
            <ul className="mt-3 divide-y divide-border p-0">
              {currentRisks.map((risk) => (
                <li key={risk.key} data-testid={`machine-risk-row-${risk.key.startsWith('loop:') ? risk.key.split(':').at(-1) : risk.title}`} className="flex items-center gap-3 py-3 first:pt-1 last:pb-0 max-[480px]:flex-col max-[480px]:items-stretch">
                  <span className="h-8 w-1 flex-none rounded-full bg-red-d" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-bold text-text [overflow-wrap:anywhere]">{risk.title}</div>
                    <div className="break-words font-mono text-[10.5px] text-text-3 [overflow-wrap:anywhere]" data-testid="machine-risk-root-hint">{risk.rootHint}</div>
                    <div className="mt-0.5 break-words text-xs text-text-3 [overflow-wrap:anywhere]">{risk.details.join(' · ')}</div>
                  </div>
                  <button
                    type="button"
                    data-testid={risk.testId}
                    className="flex-none rounded-xl border border-border px-2.5 py-1.5 text-xs font-bold text-text hover:bg-fill max-[480px]:w-full"
                    aria-label={t('machine.open_project_target', { title: risk.title, root: risk.rootHint })}
                    onClick={() => onOpenProject(risk.root)}
                  >
                    {t('machine.open_project')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <details
        className="mt-4 rounded-xl border border-border bg-card"
        data-testid="machine-diagnostics"
        onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) [&::-webkit-details-marker]:hidden">
          {t('machine.risks')}
        </summary>
        {diagnosticsOpen && <div className="border-t border-border p-4"><AdvancedPanel snapshot={snapshot} /></div>}
      </details>
    </section>
  )
}
