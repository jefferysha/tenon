import { Copy, Plus, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'
import type { MandatoryState } from '../workbench/mandatoryState'
import { trackDisplayName } from '../workbench/trackPresentation'

export interface WorkflowRailProps {
  names: readonly string[]
  current: string | null
  stagesCountOf: (name: string) => number | null
  mandatory: MandatoryState
  collapsed: boolean
  onToggle: () => void
  onSwitch: (name: string) => void
  onCreate: (mode: 'new' | 'copy') => void
  onDelete: () => void
  readonly: boolean
  busy: boolean
}

/** 工作流页左列：工作流列表；每项副行列出以它为默认的轨道。底部：新建 / 复制 / 删除。 */
export function WorkflowRail({
  names,
  current,
  stagesCountOf,
  mandatory,
  collapsed,
  onToggle,
  onSwitch,
  onCreate,
  onDelete,
  readonly,
  busy,
}: WorkflowRailProps): JSX.Element {
  const { t, lang } = useT()
  function usedBy(name: string): string {
    const tracks = mandatory.tracks.filter((track) => track.workflow.default === name).map((track) => trackDisplayName(track, lang))
    return tracks.length > 0 ? t('workflow.used_by', { tracks: tracks.join(' / ') }) : t('workflow.used_by_none')
  }
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
                meta={usedBy(name)}
                count={count ?? undefined}
                selected={name === current}
                collapsed={collapsed}
                tag={builtin ? <span className="rounded-full bg-fill px-1.5 text-micro font-medium text-text-2">{t('workflow.builtin_readonly')}</span> : undefined}
                testId={`wb-wf-item-${name}`}
                onClick={() => { if (!busy) onSwitch(name) }}
              />
            </li>
          )
        })}
      </ul>
    </RailColumn>
  )
}
