import { Download, FileUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { WbWorkflowSource } from '../api/governanceTypes'
import { useT } from '../i18n'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'
import type { MandatoryState } from '../workbench/mandatoryState'
import { trackDisplayName } from '../workbench/trackPresentation'

export interface WorkflowRailProps {
  names: readonly string[]
  current: string | null
  defaultSource: WbWorkflowSource
  stagesCountOf: (name: string) => number | null
  mandatory: MandatoryState
  collapsed: boolean
  canWrite: boolean
  busy: boolean
  onToggle: () => void
  onSwitch: (name: string) => void
  onCreate: () => void
  onImport: () => void
  onExport: () => void
  onDelete: () => void
}

/** 工作流页左列：工作流卡（default 恒在，标来源）+ 新建 / 导入 / 导出 / 删除（default 为恢复内建）。 */
export function WorkflowRail({
  names, current, defaultSource, stagesCountOf, mandatory, collapsed, canWrite, busy, onToggle, onSwitch, onCreate, onImport, onExport, onDelete,
}: WorkflowRailProps): JSX.Element {
  const { t, lang } = useT()
  function usedBy(name: string): string | undefined {
    const tracks = mandatory.tracks.filter((track) => track.workflow.default === name).map((track) => trackDisplayName(track, lang))
    return tracks.length > 0 ? tracks.join(' / ') : undefined
  }
  const isDefault = current === 'default'
  const deleteLabel = isDefault ? t('workflow.restore_default') : t('workflow.delete_workflow')
  const deleteEnabled = canWrite && !busy && current !== null && (!isDefault || defaultSource === 'project')
  const noToken = canWrite ? undefined : t('workflow.no_token')
  return (
    <RailColumn
      title={t('workflow.rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="workflow-rail"
      footer={(
        <>
          <RailFootLink icon={<Plus />} label={t('workflow.new_workflow')} collapsed={collapsed} testId="wb-workflow-new" disabled={!canWrite || busy} title={noToken} onClick={onCreate} />
          <RailFootLink icon={<FileUp />} label={t('workflow.import_yaml')} collapsed={collapsed} testId="wb-workflow-import" disabled={!canWrite || busy} title={noToken} onClick={onImport} />
          <RailFootLink icon={<Download />} label={t('workflow.export_yaml')} collapsed={collapsed} testId="wb-workflow-export" disabled={current === null} onClick={onExport} />
          <RailFootLink icon={isDefault ? <RotateCcw /> : <Trash2 />} label={deleteLabel} collapsed={collapsed} testId={isDefault ? 'wb-workflow-restore-default' : 'wb-workflow-delete'} disabled={!deleteEnabled} title={noToken} onClick={onDelete} />
        </>
      )}
    >
      <ul className="grid gap-1" data-testid="workflow-rail-list">
        {names.map((name) => {
          const count = stagesCountOf(name)
          const source = name === 'default' ? defaultSource : 'project'
          return (
            <li key={name}>
              <RailCard
                mark={name.slice(0, 1).toUpperCase()}
                name={name}
                meta={usedBy(name)}
                count={count ?? undefined}
                selected={name === current}
                collapsed={collapsed}
                tag={<span className="rounded-full bg-fill px-1.5 text-micro font-medium text-text-2" data-testid={`wb-wf-source-${name}`}>{t(`workflow.source_${source}`)}</span>}
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
