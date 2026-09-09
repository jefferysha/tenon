import { Copy, Plus, Route, Settings2, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'
import type { MandatoryState } from '../workbench/mandatoryState'
import { trackDisplayName } from '../workbench/trackPresentation'

export interface WorkflowRailProps {
  names: readonly string[]
  current: string | null
  stagesCountOf: (name: string) => number | null
  mandatory: MandatoryState
  /** 右列当前对象：阶段 / 轨道 / 工作流设置。 */
  panel: 'stage' | 'track' | 'workflow'
  collapsed: boolean
  onToggle: () => void
  onSwitch: (name: string) => void
  onTrack: (trackId: string) => void
  onCreate: (mode: 'new' | 'copy') => void
  onDelete: () => void
  onWorkflowSettings: () => void
  readonly: boolean
  busy: boolean
}

/** 工作流页左列：工作流列表（default 标内置只读）+ 轨道列表；底部新建 / 复制 / 删除 / 工作流设置。 */
export function WorkflowRail({
  names,
  current,
  stagesCountOf,
  mandatory,
  panel,
  collapsed,
  onToggle,
  onSwitch,
  onTrack,
  onCreate,
  onDelete,
  onWorkflowSettings,
  readonly,
  busy,
}: WorkflowRailProps): JSX.Element {
  const { t, lang } = useT()
  return (
    <RailColumn
      title={t('workflow.rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="workflow-rail"
      footer={(
        <>
          <RailFootLink icon={<Plus />} label={t('workflow.new_workflow')} collapsed={collapsed} testId="wb-workflow-new" onClick={() => onCreate('new')} />
          <RailFootLink icon={<Copy />} label={t(readonly ? 'workbench.workflow_copy_readonly' : 'workbench.workflow_copy_editable')} collapsed={collapsed} testId="wb-workflow-copy" onClick={() => onCreate('copy')} />
          {!readonly && <RailFootLink icon={<Trash2 />} label={t('workflow.delete_workflow')} collapsed={collapsed} testId="wb-workflow-delete" onClick={onDelete} />}
          <RailFootLink icon={<Route />} label={t('workflow.track_settings_open')} collapsed={collapsed} current={panel === 'track'} testId="workflow-track-open" onClick={() => onTrack(mandatory.track ?? '')} />
          <RailFootLink icon={<Settings2 />} label={t('workflow.settings_eyebrow')} collapsed={collapsed} current={panel === 'workflow'} testId="workflow-settings-open" onClick={onWorkflowSettings} />
        </>
      )}
    >
      <ul className="grid gap-1" data-testid="workflow-rail-list">
        {names.map((name) => {
          const count = stagesCountOf(name)
          const builtin = name === 'default'
          return (
            <li key={name}>
              <RailCard
                mark={name.slice(0, 1).toUpperCase()}
                name={name}
                meta={builtin ? t('workflow.builtin_meta') : t('workflow.project_meta')}
                count={count ?? undefined}
                selected={name === current && panel !== 'track'}
                collapsed={collapsed}
                tag={builtin ? <span className="rounded-full bg-fill px-1.5 text-micro font-medium text-text-2">{t('workflow.builtin_readonly')}</span> : undefined}
                testId={`wb-wf-item-${name}`}
                onClick={() => { if (!busy) onSwitch(name) }}
              />
            </li>
          )
        })}
      </ul>
      {!collapsed && (
        <div className="mt-4 border-t border-border pt-4 max-[1279px]:hidden">
          <div className="mb-3 flex items-baseline justify-between px-1.5">
            <span className="text-body text-text-2">{t('workflow.tracks_title')}</span>
            <span className="text-caption text-text-3">{t('workflow.tracks_hint')}</span>
          </div>
          {mandatory.table === null ? (
            <p className="px-1.5 text-caption text-text-3" role="status" data-testid="wb-track-loading">{t('workbench.track_loading')}</p>
          ) : mandatory.tracks.length === 0 ? (
            <p className="px-1.5 text-caption text-text-3" role="status" data-testid="wb-track-empty">{t('workbench.track_empty')}</p>
          ) : (
            <ul className="grid gap-0.5" data-testid="workflow-rail-tracks">
              {mandatory.tracks.map((track) => {
                const selected = panel === 'track' && track.id === mandatory.track
                return (
                  <li key={track.id}>
                    <button
                      type="button"
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm border border-transparent px-3 py-2 text-left outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t"
                      aria-current={selected ? 'true' : undefined}
                      data-testid={`workflow-track-${track.id}`}
                      onClick={() => onTrack(track.id)}
                    >
                      <span className="min-w-0">
                        <span className={`block truncate text-body font-semibold ${selected ? 'text-(--accent)' : 'text-text'}`}>{trackDisplayName(track, lang)}</span>
                        <span className="block truncate text-caption text-text-2">{track.workflow.default}{track.workflow.allowed === '*' ? '' : ` · ${track.workflow.allowed.join(', ')}`}</span>
                      </span>
                      <span className={`font-mono text-caption ${selected ? 'text-(--accent)' : 'text-text-3'}`}>→ {track.workflow.default}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </RailColumn>
  )
}
