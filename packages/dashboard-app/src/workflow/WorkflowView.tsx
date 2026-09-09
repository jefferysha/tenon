import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { useGlobalSearch } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import { SkillOrchestrationDialog } from '../workbench/SkillOrchestrationDialog'
import { useWorkflowEditor } from '../workbench/useWorkflowEditor'
import { WorkbenchDialogs } from '../workbench/WorkbenchDialogs'
import type { WorkbenchViewProps } from '../workbench/workbenchViewTypes'
import { StageEditorPane } from './StageEditorPane'
import { StageListPane, type StageFilter } from './StageListPane'
import { TrackPane } from './TrackPane'
import { WorkflowRail } from './WorkflowRail'
import { WorkflowSettingsPane } from './WorkflowSettingsPane'

type Panel = 'stage' | 'track' | 'workflow'
const RAIL_KEY = 'tenon-dashboard-rail:workflow'

/**
 * 工作流 = 整个工作流的定义编辑页：左列工作流 + 轨道 / 中列有序阶段 / 右列按对象切换（阶段编辑 · 轨道 · 工作流设置）。
 * 不显示任何任务状态；所有写操作走 useWorkflowEditor 的草稿与保存。
 */
export function WorkflowView({ root, onToggleError, snapshot = null, onDirtyChange }: WorkbenchViewProps): JSX.Element {
  const { t } = useT()
  const { query } = useGlobalSearch()
  const editor = useWorkflowEditor({ root, snapshot, onToggleError, onDirtyChange })
  const [panel, setPanel] = useState<Panel>('stage')
  const [filter, setFilter] = useState<StageFilter>('all')
  const [skillEditorOpen, setSkillEditorOpen] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  useEffect(() => { setPanel('stage'); setFilter('all'); setSkillEditorOpen(false) }, [root, editor.wfName])

  const uninstalled = useMemo(
    () => new Set((editor.mandatory.registry ?? []).filter((entry) => !entry.installed).map((entry) => entry.name)),
    [editor.mandatory.registry],
  )

  const detail = panel === 'track'
    ? <TrackPane mandatory={editor.mandatory} lanes={editor.boardLanes} workflowName={editor.wfName} onDirtyChange={editor.reportTrackDirty} />
    : panel === 'workflow'
      ? <WorkflowSettingsPane editor={editor} root={root} snapshot={snapshot} />
      : editor.selectedLane && editor.selectedStep
        ? (
          <StageEditorPane
            key={`${editor.wfName} ${editor.selectedLane.id}`}
            editor={editor}
            lane={editor.selectedLane}
            step={editor.selectedStep}
            mandatory={editor.mandatory}
            onOpenSkillEditor={() => setSkillEditorOpen(true)}
          />
        )
        : <DetailEmpty title={t('workflow.no_stage')} desc={t('workflow.no_stage_desc')} testId="stage-editor-empty" />

  return (
    <>
      <ThreeColumns
        testId="workbench-view"
        railCollapsed={railCollapsed}
        rail={(
          <WorkflowRail
            names={editor.menuNames}
            current={editor.wfName}
            stagesCountOf={editor.stagesCountOf}
            mandatory={editor.mandatory}
            panel={panel}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((value) => !value)}
            onSwitch={(name) => { editor.requestSwitch(name); setPanel('stage') }}
            onTrack={(id) => { if (id !== '' && editor.mandatory.matrixTracks.some((track) => track.id === id)) editor.mandatory.setTrack(id); setPanel('track') }}
            onCreate={editor.openWorkflowCreate}
            onDelete={editor.openWorkflowDelete}
            onWorkflowSettings={() => setPanel('workflow')}
            readonly={editor.readonlyWf}
            busy={editor.saving}
          />
        )}
        list={(
          <StageListPane
            workflowName={editor.wfName ?? ''}
            readonly={editor.readonlyWf}
            lanes={editor.boardLanes}
            steps={editor.def?.steps ?? []}
            selectedId={panel === 'stage' ? editor.stageId : null}
            query={query}
            filter={filter}
            onFilter={setFilter}
            onSelect={(id) => { editor.setStageId(id); setPanel('stage') }}
            onAddStage={editor.readonlyWf ? undefined : () => editor.stageDraft.setAddStageOpen(true)}
            uninstalled={uninstalled}
            loading={editor.def === null && editor.defErrorText === null}
            error={editor.namesErrorText ?? editor.defErrorText}
          />
        )}
        detail={detail}
      />
      {skillEditorOpen && editor.selectedLane && (
        <SkillOrchestrationDialog
          lane={editor.selectedLane}
          registry={editor.mandatory.registry}
          onClose={() => setSkillEditorOpen(false)}
          onAdd={editor.addSkill}
          onRemove={editor.removeSkill}
          onMove={editor.moveSkill}
          onDependencyChange={editor.setSkillDependency}
        />
      )}
      <WorkbenchDialogs
        workflowName={editor.wfName}
        pendingSwitch={editor.pendingSwitch}
        onPendingSwitch={editor.setPendingSwitch}
        onConfirmSwitch={editor.confirmSwitch}
        createMode={editor.workflowCreateMode}
        workflowNameRef={editor.workflowNameRef}
        workflowDraftName={editor.workflowDraftName}
        onWorkflowDraftName={editor.setWorkflowDraftName}
        workflowNameInvalid={editor.workflowNameInvalid}
        workflowNameDuplicate={editor.workflowNameDuplicate}
        workflowErrors={editor.workflowOpErrors}
        workflowBusy={editor.workflowOpBusy}
        canSubmitWorkflow={editor.canSubmitWorkflow}
        onCloseWorkflowCreate={editor.closeWorkflowCreate}
        onConfirmWorkflowCreate={() => void editor.confirmWorkflowCreate()}
        deleteOpen={editor.workflowDeleteTarget !== null}
        deleteBusy={editor.workflowDeleteBusy}
        deleteError={editor.workflowDeleteError}
        dirty={editor.dirty}
        onCloseDelete={editor.closeWorkflowDelete}
        onConfirmDelete={() => void editor.confirmWorkflowDelete()}
        addStageOpen={editor.stageDraft.addStageOpen}
        addStageNameRef={editor.stageDraft.addStageNameRef}
        stageDraftName={editor.stageDraft.stageDraftName}
        stageDraftId={editor.stageDraft.stageDraftId}
        stageIdTouched={editor.stageDraft.stageIdTouched}
        stageIdError={editor.stageDraft.stageIdError}
        canSubmitStage={editor.stageDraft.canSubmitStage}
        onStageDraftName={editor.stageDraft.setStageDraftName}
        onStageDraftId={editor.stageDraft.setStageDraftId}
        onStageIdTouched={() => editor.stageDraft.setStageIdTouched(true)}
        onCloseAddStage={editor.stageDraft.closeAddStage}
        onConfirmAddStage={editor.stageDraft.confirmAddStage}
      />
    </>
  )
}
