import { useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, LayoutGrid } from 'lucide-react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { useT } from '../i18n'
import { useCurrentStagePosition } from './useCurrentStagePosition'
import { StageNode, type StageState } from './WorkflowCanvasStage'

gsap.registerPlugin(useGSAP)

export type CanvasDotTone = 'red' | 'blue' | 'amb' | 'gray'

export const DOT_TONE_CLS: Record<CanvasDotTone, string> = {
  red: 'bg-red shadow-[0_0_5px_var(--red)]',
  blue: 'bg-(--accent) shadow-[0_0_6px_var(--accent)]',
  amb: 'bg-amber-d',
  gray: 'bg-border-2',
}

export interface CanvasChange {
  key: string
  name: string
  phase: string
  state: string
  tone: CanvasDotTone
  running: boolean
  executionSource: 'automation' | 'terminal' | 'none'
  sandbox: boolean
  dimmed: boolean
  selected: boolean
  statusLabel: string
}

export interface CanvasArchivedChange {
  key: string
  name: string
  tone: CanvasDotTone
  state: string
}

export interface CanvasStep {
  id: string
  label: string
  gate: string | null
  archived: number
  archivedChanges: readonly CanvasArchivedChange[]
  state: StageState
}

export interface CanvasGroup {
  key: string
  projName: string
  workflow: string
  steps: CanvasStep[]
  changes: CanvasChange[]
  linearProgress: boolean
}

export interface WorkflowCanvasProps {
  groups: CanvasGroup[]
  onOpen: (key: string, trigger: HTMLElement | null) => void
}

interface StateMeta {
  labelKey: string
  chip: string
}

const STATE_META: Record<string, StateMeta> = {
  running: { labelKey: 'state_running', chip: 'bg-green-t text-green-d' },
  failed: { labelKey: 'state_failed', chip: 'bg-red-t text-red-d' },
  queued: { labelKey: 'state_waiting', chip: 'bg-accent-t text-accent-d' },
  gatejudge: { labelKey: 'state_decision', chip: 'bg-amber-t text-amber-d' },
  gateok: { labelKey: 'state_approvable', chip: 'bg-green-t text-green-d' },
  cancelled: { labelKey: 'state_cancelled', chip: 'bg-red-t text-red-d' },
  agent: { labelKey: 'state_pending', chip: 'bg-fill text-text-3' },
}

const FALLBACK_META: StateMeta = { labelKey: 'state_pending', chip: 'bg-fill text-text-3' }

function gridStyleOf(n: number): CSSProperties {
  return { gridTemplateColumns: `repeat(${Math.max(n, 1)}, minmax(0, 1fr))` }
}

function stateMetaOf(change: CanvasChange): StateMeta {
  return STATE_META[change.state] ?? FALLBACK_META
}

export function WorkflowCanvas({ groups, onOpen }: WorkflowCanvasProps): JSX.Element | null {
  const { t } = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const [openArchive, setOpenArchive] = useState<string | null>(null)
  const shown = groups.filter((group) => group.changes.length > 0)
  // A single-project view already has the project in the breadcrumb. In an aggregate view the
  // project is the disambiguating context, so keep it in the compact group identity only there.
  const showProjectIdentity = new Set(shown.map((group) => group.projName)).size > 1
  const animKey = shown
    .map((group) => `${group.key}#${group.steps.map((step) => step.id).join(',')}#${group.changes.map((change) => change.key).join(',')}`)
    .join('|')
  const currentPositionKey = shown
    .map((group) => `${group.key}#${group.steps.find((step) => step.state === 'current')?.id ?? ''}`)
    .join('|')

  useGSAP(
    () => {
      const root = rootRef.current
      if (!root || typeof window.matchMedia !== 'function') return
      const mm = gsap.matchMedia()
      mm.add(
        { reduce: '(prefers-reduced-motion: reduce)', motion: '(prefers-reduced-motion: no-preference)' },
        (ctx) => {
          const cards = root.querySelectorAll<HTMLElement>('[data-anim="prg-card"]')
          const reduce = Boolean((ctx.conditions as { reduce?: boolean } | undefined)?.reduce)
          if (reduce) {
            gsap.set(cards, { autoAlpha: 1, y: 0 })
            return
          }
          if (cards.length > 0) {
            gsap.fromTo(
              cards,
              { autoAlpha: 0, y: 6 },
              {
                autoAlpha: 1,
                y: 0,
                duration: 0.22,
                ease: 'power2.out',
                stagger: 0.04,
                clearProps: 'transform,opacity,visibility',
              },
            )
          }
        },
      )
      return () => mm.revert()
    },
    { scope: rootRef, dependencies: [animKey], revertOnUpdate: true },
  )

  useCurrentStagePosition(rootRef, currentPositionKey)

  if (shown.length === 0) return null

  return (
    <div className="prg-canvas mb-5 flex flex-col gap-6" data-testid="prg-canvas" aria-label={t('progress.canvas_aria')} ref={rootRef}>
      {shown.map((group) => {
        const n = group.steps.length
        const byStep = new Map<string, CanvasChange[]>()
        for (const change of group.changes) byStep.set(change.phase, [...(byStep.get(change.phase) ?? []), change])
        const currentIndex = Math.max(
          group.steps.reduce((latest, step, index) => step.state === 'pending' ? latest : index, -1),
          0,
        )
        const edge = 100 / Math.max(n, 1) / 2
        const fillPct = n <= 1 ? 0 : (currentIndex / (n - 1)) * 100
        const openStep = group.steps.find((step) => openArchive === `${group.key}::${step.id}`)

        return (
          <div key={group.key} className="min-w-0">
            <section
              data-anim="prg-card"
              data-testid={`prg-cv-group-${group.projName}-${group.workflow}`}
              data-responsive="summary-track-cards"
              className="min-h-[360px] rounded-[22px] border border-border bg-card p-5 shadow-xs mobile:min-h-0 mobile:rounded-2xl mobile:p-4"
            >
                <header className="mb-4 flex min-w-0 items-center justify-between gap-3 mobile:items-start">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      data-testid={`prg-cv-project-${group.projName}-${group.workflow}`}
                      data-project={group.projName}
                      aria-label={`${group.projName} ${group.workflow}`}
                      className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-border bg-fill px-2.5 py-1.5 font-mono text-[13px] font-semibold text-text"
                      title={`${group.projName} · ${group.workflow}`}
                    >
                      <LayoutGrid className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />
                      {showProjectIdentity ? `${group.projName} · ${group.workflow}` : group.workflow}
                    </span>
                  </div>
                </header>

                <div
                  data-testid={`prg-cv-scroll-${group.projName}-${group.workflow}`}
                  data-canvas-scroll
                  data-scroll-key={group.key}
                  data-current-position-key={`${group.key}#${group.steps.find((step) => step.state === 'current')?.id ?? ''}`}
                  tabIndex={0}
                  aria-label={t('progress.canvas_scroll_hint')}
                  className="overflow-x-auto pb-2 [scrollbar-width:thin] mobile:overflow-visible mobile:pb-0"
                >
                  <div
                    data-testid={`prg-cv-track-${group.projName}-${group.workflow}`}
                    className="relative min-w-0"
                  >
                  <div className="relative h-8">
                    {n >= 2 && (
                      <>
                        <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-fill" style={{ left: `${edge}%`, right: `${edge}%` }} aria-hidden="true" />
                        {group.linearProgress && (
                          <span
                            className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-(--accent)"
                            style={{ left: `${edge}%`, width: `calc((100% - ${edge * 2}%) * ${fillPct / 100})` }}
                            aria-hidden="true"
                          />
                        )}
                      </>
                    )}
                    <div className="prg-stage-grid relative grid" style={gridStyleOf(n)}>
                      {group.steps.map((step) => {
                        const state = step.state
                        const gateLabel = step.gate
                          ? t('progress.canvas_gate', { gate: step.gate })
                          : t(`progress.stage_${state}`)
                        return (
                          <span
                            key={step.id}
                            data-testid={`prg-cv-stage-${group.projName}-${group.workflow}-${step.id}`}
                            data-stage-state={state}
                            title={gateLabel}
                            aria-label={gateLabel}
                            className="flex h-8 items-center justify-center"
                          >
                            <StageNode state={state} />
                          </span>
                        )
                      })}
                    </div>
                  </div>

                  <div className="prg-change-grid mt-3 grid items-start" style={gridStyleOf(n)}>
                    {group.steps.map((step, i) => {
                      const here = byStep.get(step.id) ?? []
                      const run = here.some((change) => change.running)
                      const archKey = `${group.key}::${step.id}`
                      const archExpanded = openArchive === archKey
                      return (
                        <div
                          key={step.id}
                          data-anim="prg-node"
                          data-kind={here.length > 0 ? 'card' : 'stop'}
                          data-run={run || undefined}
                          data-testid={`prg-cv-node-${group.projName}-${group.workflow}-${step.id}`}
                          className="flex min-w-0 flex-col items-center gap-3 px-3"
                        >
                          <div className="flex min-h-[34px] flex-col items-center gap-1 text-center">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-mono text-[10px] font-semibold ${step.state !== 'pending' ? 'text-(--accent)' : 'text-text-3'}`}>
                                {String(i + 1).padStart(2, '0')}
                              </span>
                              <span className={`text-[13px] font-semibold ${step.state !== 'pending' ? 'text-text' : 'text-text-3'}`}>{step.label}</span>
                            </div>
                          </div>

                          {here.length > 0 && (
                            <div className="flex w-full flex-col gap-3">
                              {here.map((change) => {
                                const meta = stateMetaOf(change)
                                return (
                                  <button
                                    key={change.key}
                                    type="button"
                                    data-testid={`prg-cv-chg-${change.name}`}
                                    data-drawer-trigger-key={change.key}
                                    data-state={change.state}
                                    data-sbx={change.sandbox || undefined}
                                    data-dim={change.dimmed || undefined}
                                    data-on={change.selected || undefined}
                                    disabled={change.dimmed}
                                    aria-hidden={change.dimmed || undefined}
                                    onClick={(event) => onOpen(change.key, event.currentTarget)}
                                    className="group relative flex min-h-[102px] w-full flex-col overflow-hidden rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-border-2 hover:shadow-md active:translate-y-0 disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:border-border disabled:hover:shadow-xs data-[dim=true]:opacity-30 data-[on=true]:border-(--accent) data-[on=true]:ring-1 data-[on=true]:ring-ring motion-reduce:transform-none mobile:min-h-[96px]"
                                  >
                                    <span className="flex items-center gap-2">
                                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[9px] font-bold tracking-[.08em] ${meta.chip}`}>
                                        <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE_CLS[change.tone]}`} data-pulse={change.running || undefined} aria-hidden="true" />
                                        {t(`progress.${meta.labelKey}`)}
                                      </span>
                                    </span>

                                    <span className="mt-2 w-full font-mono text-[13px] leading-snug font-semibold break-words text-text [overflow-wrap:anywhere]">{change.name}</span>

                                    <span className="mt-auto flex items-center justify-end gap-3 pt-2">
                                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-text-3 group-hover:text-(--accent)">
                                        {t('progress.open')} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                                      </span>
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          )}

                          {step.archived > 0 && (
                            <button
                              type="button"
                              data-testid={`prg-cv-arch-toggle-${group.projName}-${group.workflow}-${step.id}`}
                              aria-expanded={archExpanded}
                              onClick={() => setOpenArchive(archExpanded ? null : archKey)}
                              className="text-[11px] text-text-3 underline-offset-2 hover:text-text hover:underline data-[on=true]:text-(--accent)"
                              data-on={archExpanded || undefined}
                            >
                              {t('progress.canvas_archived', { n: step.archived })}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  </div>
                </div>

                {openStep && openStep.archivedChanges.length > 0 && (
                  <div className="mt-4 rounded-xl border border-dashed border-border-2 px-3 py-2" data-testid={`prg-cv-arch-panel-${group.projName}-${group.workflow}-${openStep.id}`}>
                    <p className="mb-1.5 text-xs text-text-3">
                      <span className="font-mono text-text-2">{openStep.label}</span> · {t('progress.canvas_archived', { n: openStep.archived })}
                    </p>
                    <div className="flex flex-col gap-1">
                      {openStep.archivedChanges.map((change) => (
                        <div key={change.key} data-testid={`prg-cv-arch-chg-${change.name}`} data-state={change.state} className="flex items-start gap-1.5 opacity-70">
                          <span className={`mt-1 h-2.5 w-2.5 flex-none rounded-full ${DOT_TONE_CLS[change.tone]}`} aria-hidden="true" />
                          <span className="min-w-0 flex-1 font-mono text-[13px] leading-snug break-all text-text-2">{change.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </section>
          </div>
        )
      })}
    </div>
  )
}
