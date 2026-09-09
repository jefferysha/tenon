import { AlertTriangle, Box, BrainCircuit, Container, KeyRound, ServerCog, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AdvancedPanel } from '../advanced/AdvancedPanel'
import { useT } from '../i18n'
import { StatusPill } from '../shell/ThreeColumns'
import type { Snapshot } from '../types'
import { credentialSourceLabel, READINESS_TONE, riskRowId, type ReadinessState } from './machineModel'
import type { MachineProbes } from './useMachineProbes'

interface ReadinessCardProps {
  icon: LucideIcon
  label: string
  state: ReadinessState
  detail: string
  testId: string
}

/** 就绪灯：图标 + 标题 + 事实说明 + 状态 pill。非 live 区域——聚合播报只由 machine-readiness-summary 承担。 */
function ReadinessCard({ icon: Icon, label, state, detail, testId }: ReadinessCardProps): JSX.Element {
  const { t } = useT()
  return (
    <article
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
      data-state={state}
      data-testid={testId}
    >
      <span className="grid size-8 flex-none place-items-center rounded-sm border border-border bg-fill text-text-2"><Icon className="size-4" aria-hidden="true" /></span>
      <span className="min-w-0">
        <h3 className="break-words text-base font-semibold leading-tight text-text [overflow-wrap:anywhere]">{label}</h3>
        <p className="truncate text-caption text-text-2" title={detail}>{detail}</p>
      </span>
      <StatusPill tone={READINESS_TONE[state]}>{t(`machine.${state}`)}</StatusPill>
    </article>
  )
}

function SheetHead({ title, meta }: { title: string; meta?: string }): JSX.Element {
  return (
    <div className="mb-3.5 flex items-baseline justify-between gap-4">
      <h2 className="text-section font-bold text-text">{title}</h2>
      {meta !== undefined && <span className="text-body text-text-3">{meta}</span>}
    </div>
  )
}

/** 机器就绪 sheet：核心三灯 + AFK 可选两灯。机器级事实，与选中的宿主无关。 */
export function ReadinessSheet({ probes, probeRoot }: { probes: MachineProbes; probeRoot: string }): JSX.Element {
  const { t } = useT()
  return (
    <section data-testid="machine-readiness">
      <SheetHead title={t('machine.core_readiness')} meta={t('machines.machine_level')} />
      <p className="sr-only" role="status" aria-live="polite" data-testid="machine-readiness-summary">
        {t('machine.readiness_summary', probes.readinessCounts)}
      </p>
      <div className="grid gap-2" data-testid="machine-readiness-grid">
        <ReadinessCard icon={KeyRound} label={t('machine.codex')} state={probes.codexState} detail={t('machine.codex_detail', { source: credentialSourceLabel(probes.secretSource, t) })} testId="machine-codex" />
        <ReadinessCard icon={BrainCircuit} label={t('machine.skills')} state={probes.skillState} detail={probes.skills ? t('machine.skills_detail', { installed: probes.installedSkills, total: probes.skills.length }) : t('machine.loading_signal')} testId="machine-skills" />
        <ReadinessCard icon={ServerCog} label={t('machine.operations')} state={probes.operationsState} detail={t('machine.operations_detail')} testId="machine-operations" />
      </div>

      <section className="mt-7" data-testid="machine-afk-readiness">
        <SheetHead title={t('machine.afk_readiness')} />
        <p className="mb-3 text-body text-text-2">{t('machine.afk_optional_note')}</p>
        {probeRoot === '' && <p className="mb-3 text-body text-text-3" role="status" data-testid="machine-project-facts-unavailable">{t('machine.project_facts_unavailable')}</p>}
        <div className="grid gap-2">
          <ReadinessCard icon={Container} label={t('machine.docker')} state={probes.dockerState} detail={probes.dockerDetail} testId="machine-docker" />
          <ReadinessCard icon={Box} label={t('machine.image')} state={probes.imageState} detail={probes.configuredImage} testId="machine-image" />
        </div>
      </section>
    </section>
  )
}

/** 阻塞 sheet：探测失败 / 未装必备技能 / 服务器未声明 operations。 */
export function BlockersSheet({ probes }: { probes: MachineProbes }): JSX.Element {
  const { t } = useT()
  return (
    <section data-testid="machine-blockers">
      <SheetHead title={t('machine.blockers')} meta={t('machines.machine_level')} />
      {probes.blockersPending ? (
        <p className="text-body text-text-3" role="status" aria-live="polite" data-testid="machine-blockers-loading">{t('machine.loading_signal')}</p>
      ) : probes.blockers.length === 0 ? (
        <p className={`text-body ${probes.coreFactsUnknown ? 'text-text-3' : 'text-green-d'}`} role="status" aria-live="polite">
          {t(probes.coreFactsUnknown ? 'machine.blockers_unknown' : 'machine.blockers_empty')}
        </p>
      ) : (
        <ul className="grid gap-2">
          {probes.blockers.map((blocker, index) => (
            <li key={`${blocker}:${index}`} className="flex items-start gap-3 rounded-md border border-amber-b bg-amber-t px-4 py-3 text-body leading-relaxed text-amber-d">
              <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden="true" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{blocker}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface RisksSheetProps {
  probes: MachineProbes
  snapshot: Snapshot | null
  currentRoot: string
  onOpenProject: (root: string) => void
}

/** 风险 sheet：项目不可读 / 自动运行失败·冲突 / loop 账本·熔断·就绪度；默认只看当前项目，可切到跨项目。 */
export function RisksSheet({ probes, snapshot, currentRoot, onOpenProject }: RisksSheetProps): JSX.Element {
  const { t } = useT()
  const [showAllRisks, setShowAllRisks] = useState(false)
  const hasCurrentProject = snapshot?.projects.some((project) => project.root === currentRoot) ?? false
  const currentRisks = useMemo(
    () => currentRoot === '' || !hasCurrentProject || showAllRisks ? probes.risks : probes.risks.filter((risk) => risk.root === currentRoot),
    [currentRoot, hasCurrentProject, probes.risks, showAllRisks],
  )
  const crossProjectRiskCount = !hasCurrentProject || currentRoot === '' ? 0 : probes.risks.filter((risk) => risk.root !== currentRoot).length
  return (
    <section data-testid="machine-risk-queue">
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-section font-bold text-text">{t('machine.risks')}</h2>
          <p className="mt-0.5 text-body text-text-2">{t('machine.risks_note')}</p>
        </div>
        <div className="flex items-center gap-2">
          {crossProjectRiskCount > 0 && (
            <button
              type="button"
              className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-micro font-semibold text-text-2 hover:bg-fill aria-[pressed=true]:border-accent-b aria-[pressed=true]:bg-accent-t aria-[pressed=true]:text-(--accent)"
              data-testid="machine-cross-project-count"
              aria-pressed={showAllRisks}
              onClick={() => setShowAllRisks((value) => !value)}
            >
              {t('machine.risks')} {crossProjectRiskCount}
            </button>
          )}
          <span className="rounded-full bg-fill px-2.5 py-1 font-mono text-caption font-semibold text-text">{currentRisks.length}</span>
        </div>
      </div>
      {probes.loops === null ? (
        <p className="text-body text-text-3" role="status" aria-live="polite">{t('machine.loading_signal')}</p>
      ) : currentRisks.length === 0 ? (
        <p className="text-body text-green-d" role="status" aria-live="polite">{t('machine.risks_empty')}</p>
      ) : (
        <ul className="grid gap-2">
          {currentRisks.map((risk) => (
            <li
              key={risk.key}
              data-testid={`machine-risk-row-${riskRowId(risk)}`}
              className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 max-[480px]:flex-col max-[480px]:items-stretch"
            >
              <span className="h-8 w-1 flex-none rounded-full bg-red" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="break-words text-base font-semibold text-text [overflow-wrap:anywhere]">{risk.title}</div>
                <div className="break-words font-mono text-micro text-text-3 [overflow-wrap:anywhere]" data-testid="machine-risk-root-hint">{risk.rootHint}</div>
                <div className="mt-0.5 break-words text-body text-text-2 [overflow-wrap:anywhere]">{risk.details.join(' · ')}</div>
              </div>
              <button
                type="button"
                data-testid={risk.testId}
                className="min-h-9 flex-none rounded-sm border border-border bg-card px-3 text-caption font-semibold text-text hover:border-text-3 max-[480px]:w-full"
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
  )
}

/** 诊断 sheet：AdvancedPanel 只在 details 展开时挂载，收起即卸载。 */
export function DiagnosticsSheet({ snapshot }: { snapshot: Snapshot | null }): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  return (
    <section>
      <SheetHead title={t('machines.sheet_diagnostics')} meta={t('machines.machine_level')} />
      <p className="mb-3 text-body text-text-2">{t('machines.diagnostics_note')}</p>
      <details
        className="rounded-md border border-border bg-card"
        data-testid="machine-diagnostics"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none px-4 py-3 text-base font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) [&::-webkit-details-marker]:hidden">
          {t('machines.diagnostics_open')}
        </summary>
        {open && <div className="border-t border-border p-4"><AdvancedPanel snapshot={snapshot} /></div>}
      </details>
    </section>
  )
}
