import { useMemo } from 'react'
import { useT } from '../i18n'
import { SheetTabs, useSheetState, type SheetDef } from '../shared/DetailSheets'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import type { BoardLane } from '../workbench/boardLane'
import { LaneMandatorySkills } from '../workbench/LaneMandatorySkills'
import type { MandatoryState } from '../workbench/mandatoryState'
import { skillExecutionWaves } from '../workbench/SkillExecutionTopology'
import { TrackSelector } from '../workbench/TrackSelector'
import { trackDisplayName } from '../workbench/trackPresentation'

const SHEETS = ['binding', 'matrix', 'pipeline'] as const
type SheetId = (typeof SHEETS)[number]

export interface TrackPaneProps {
  mandatory: MandatoryState
  lanes: readonly BoardLane[]
  workflowName: string | null
  onDirtyChange: (dirty: boolean) => void
}

/**
 * 工作流页右列 · 轨道：绑定（默认 / 允许工作流、策略档——TrackSelector 原件）/ 技能矩阵（每阶段强制技能）/
 * 管线预览（当前工作流 × 轨道的执行顺序：串行 / 并行由技能依赖推导，只读）。
 */
export function TrackPane({ mandatory, lanes, workflowName, onDirtyChange }: TrackPaneProps): JSX.Element {
  const { t, lang } = useT()
  const track = mandatory.tracks.find((candidate) => candidate.id === mandatory.track) ?? mandatory.matrixTracks[0] ?? mandatory.tracks[0] ?? null
  const sheets: readonly SheetDef<SheetId>[] = useMemo(() => [
    { id: 'binding', label: t('workflow.track_sheet_binding') },
    { id: 'matrix', label: t('workflow.track_sheet_matrix'), count: lanes.length },
    { id: 'pipeline', label: t('workflow.track_sheet_pipeline'), count: lanes.length },
  ], [lanes.length, t])
  const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:workflow-track', sheets, 'binding')
  const name = track ? trackDisplayName(track, lang) : (mandatory.track ?? '')

  return (
    <DetailColumn
      testId="track-pane"
      panelId="track-panel"
      labelledBy={`track-tab-${sheet}`}
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('workflow.rail_title')} / {t('workflow.track_eyebrow')}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text" data-testid="track-pane-title">{name}</h1>
          <p className="mb-4 font-mono text-base text-text-2">track · {track?.id ?? ''} · {t(track?.builtin ? 'workflow.builtin_meta' : 'workflow.project_meta')}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5">
            <StatusPill tone={track?.policyProfile.automationEligible ? 'done' : 'neutral'}>
              {t(track?.policyProfile.automationEligible ? 'workflow.track_automation_on' : 'workflow.track_automation_off')}
            </StatusPill>
            <span className="text-base text-text-2">
              {track
                ? t('workflow.track_summary', { workflow: track.workflow.default, allowed: track.workflow.allowed === '*' ? t('workflow.track_allowed_any') : track.workflow.allowed.join('、') })
                : t('workbench.track_loading')}
            </span>
          </p>
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('shell.sheet_label')} idPrefix="track" />}
      footer={<p className="text-body text-text-2">{t('workflow.track_footer')}</p>}
    >
      {sheet === 'binding' && (
        <div className="grid gap-4" data-testid="track-binding-sheet">
          <h2 className="text-section font-bold text-text">{t('workflow.track_sheet_binding')}</h2>
          <TrackSelector state={mandatory} onDirtyChange={onDirtyChange} />
        </div>
      )}
      {sheet === 'matrix' && (
        <div className="grid gap-4" data-testid="track-matrix-sheet">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-section font-bold text-text">{t('workflow.track_sheet_matrix')}</h2>
            <span className="text-body text-text-3">{t('workflow.track_matrix_hint')}</span>
          </div>
          {lanes.map((lane) => (
            <section key={lane.id} className="rounded-md border border-border bg-card px-4 py-3" data-testid={`track-matrix-${lane.id}`}>
              <h3 className="mb-2 flex items-baseline gap-2 text-base font-semibold text-text">{lane.name}<span className="font-mono text-caption font-normal text-text-2">{lane.id}</span></h3>
              <LaneMandatorySkills phase={lane.id} state={mandatory} />
            </section>
          ))}
        </div>
      )}
      {sheet === 'pipeline' && (
        <div className="grid gap-4" data-testid="track-pipeline-sheet">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-section font-bold text-text">{t('workflow.track_sheet_pipeline')}</h2>
            <span className="text-body text-text-3">{t('workflow.track_pipeline_hint', { workflow: workflowName ?? '', track: track?.id ?? '' })}</span>
          </div>
          <ol className="grid gap-1.5">
            {lanes.map((lane, index) => {
              const skills = lane.skills ?? []
              const waves = skillExecutionWaves(skills, lane.skillDeps ?? {})
              const parallel = waves.some((wave) => wave.length > 1)
              const order = waves.map((wave) => wave.length > 1 ? `[${wave.join(' ‖ ')}]` : wave[0]).join(' → ')
              return (
                <li key={lane.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-3.5 py-3" data-testid={`track-pipeline-${lane.id}`}>
                  <span className="grid size-6 place-items-center rounded-xs bg-fill font-mono text-caption text-text-2" aria-hidden="true">{index + 1}</span>
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-2 text-base font-semibold text-text">{lane.name}<span className="font-mono text-caption font-normal text-text-2">{lane.id}</span></span>
                    <span className="block truncate font-mono text-caption text-text-2">
                      {lane.skills === undefined
                        ? t('workflow.card_skills_matrix')
                        : `${t(parallel ? 'workflow.mode_parallel' : 'workflow.mode_serial')} · ${order === '' ? t('workbench.timeline_skills_empty') : order}`}
                    </span>
                  </span>
                  {lane.gate !== null && <span className="rounded-full bg-fill px-2 py-0.5 text-caption text-text-2">{t(lane.gate === 'review' ? 'workflow.gate_tag_review' : 'workflow.gate_tag_confirm')}</span>}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </DetailColumn>
  )
}
