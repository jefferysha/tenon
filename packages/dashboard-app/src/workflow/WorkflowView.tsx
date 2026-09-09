import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { useGlobalSearch } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import { useWorkflowEditor } from '../workbench/useWorkflowEditor'
import { WorkbenchDialogs } from '../workbench/WorkbenchDialogs'
import type { WorkbenchViewProps } from '../workbench/workbenchViewTypes'
import { StageEditorPane } from './StageEditorPane'
import { StageListPane } from './StageListPane'
import { WorkflowRail } from './WorkflowRail'

const RAIL_KEY = 'tenon-dashboard-rail:workflow'

/** 工作流 = 定义编辑页：左列工作流 / 中列有序阶段 / 右列所选阶段的技能顺序、门禁与推导出的输入输出。 */
export function WorkflowView({ root, snapshot = null, onDirtyChange }: WorkbenchViewProps): JSX.Element {
  const { t } = useT()
  const { query } = useGlobalSearch()
  const editor = useWorkflowEditor({ root, snapshot, onDirtyChange })
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])

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
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((value) => !value)}
            onSwitch={editor.requestSwitch}
            onCreate={editor.openWorkflowCreate}
            onDelete={editor.openWorkflowDelete}
            readonly={editor.readonlyWf}
            busy={editor.saving}
          />
        )}
        list={(
          <StageListPane
            workflowName={editor.wfName ?? ''}
            readonly={editor.readonlyWf}
            lanes={editor.boardLanes}
            selectedId={editor.stageId}
            query={query}
            onSelect={editor.setStageId}
            onAddStage={editor.readonlyWf ? undefined : () => editor.stageDraft.setAddStageOpen(true)}
            loading={editor.def === null && editor.defErrorText === null}
            error={editor.namesErrorText ?? editor.defErrorText}
          />
        )}
        detail={editor.selectedLane && editor.selectedStep
          ? <StageEditorPane key={`${editor.wfName} ${editor.selectedLane.id}`} editor={editor} lane={editor.selectedLane} step={editor.selectedStep} mandatory={editor.mandatory} />
          : <DetailEmpty title={t('workflow.no_stage')} desc={t('workflow.no_stage_desc')} testId="stage-editor-empty" />}
      />
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
