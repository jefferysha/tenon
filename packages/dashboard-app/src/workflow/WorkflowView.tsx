import { useState } from 'react'
import { useT } from '../i18n'
import { DetailEmpty, TwoColumns } from '../shell/ThreeColumns'
import { useWorkflowEditor } from '../workbench/useWorkflowEditor'
import { WorkbenchDialogs } from '../workbench/WorkbenchDialogs'
import { NewWorkflowDialog } from './NewWorkflowDialog'
import { StageEditorPane } from './StageEditorPane'
import { TrackDialog } from './TrackDialog'
import { WorkflowNav } from './WorkflowNav'
import { Dialog } from '../shared/Dialog'

export interface WorkflowViewProps {
  root: string
  onDirtyChange?: (dirty: boolean) => void
  onToast?: (message: string) => void
}

/** 工作流 = 定义编辑页：左栏工作流 / 轨道 / 流程，右栏所选阶段的输入、技能、输出、门禁。 */
export function WorkflowView({ root, onDirtyChange, onToast }: WorkflowViewProps): JSX.Element {
  const { t } = useT()
  const editor = useWorkflowEditor({ root, onDirtyChange })
  const [trackDialogOpen, setTrackDialogOpen] = useState(false)
  const [trackDeleteTarget, setTrackDeleteTarget] = useState<string | null>(null)

  async function exportYaml(): Promise<void> {
    try {
      const text = await editor.exportYaml()
      const name = `${editor.wfName ?? 'workflow'}.yaml`
      const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      await navigator.clipboard?.writeText(text).catch(() => undefined)
      onToast?.(t('workflow.exported', { name }))
    } catch {
      onToast?.(t('workflow.export_failed'))
    }
  }

  return (
    <>
      <TwoColumns
        testId="workbench-view"
        nav={(
          <WorkflowNav
            names={editor.menuNames}
            current={editor.wfName}
            defaultSource={editor.defaultSource}
            branches={editor.branches}
            branch={editor.branch}
            def={editor.def}
            labelOf={editor.labelOf}
            selectedId={editor.stageId}
            lint={editor.lint}
            loading={editor.def === null && editor.defErrorText === null}
            error={editor.namesErrorText ?? editor.defErrorText}
            canWrite={editor.canWrite}
            busy={editor.saving || editor.create.busy}
            openspec={editor.def?.openspec === true}
            onToggleOpenspec={() => editor.setOpenspec(editor.def?.openspec !== true)}
            onSwitch={editor.requestSwitch}
            onSwitchBranch={editor.setBranch}
            onCreate={() => editor.create.openCreate('copy')}
            onExport={() => void exportYaml()}
            onDelete={editor.openWorkflowDelete}
            onNewTrack={() => setTrackDialogOpen(true)}
            onDeleteTrack={setTrackDeleteTarget}
            onSelect={editor.setStageId}
            onAddStage={() => editor.stageDraft.setAddStageOpen(true)}
            onReorder={editor.reorderStages}
          />
        )}
        detail={editor.selectedStep
          ? <StageEditorPane key={`${editor.wfName} ${editor.selectedStep.id}`} editor={editor} step={editor.selectedStep} />
          : <DetailEmpty title={t('workflow.no_stage')} desc="" testId="stage-editor-empty" />}
      />
      <NewWorkflowDialog create={editor.create} currentName={editor.wfName} />
      <TrackDialog
        open={trackDialogOpen}
        existing={editor.branches.map((branch) => branch.id)}
        onClose={() => setTrackDialogOpen(false)}
        onSubmit={(id, label) => { editor.addTrack(id, label); setTrackDialogOpen(false) }}
      />
      {trackDeleteTarget !== null && (
        <Dialog
          title={t('workflow.delete_track')}
          onClose={() => setTrackDeleteTarget(null)}
          testid="track-delete-dialog"
          actions={(
            <>
              <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" onClick={() => setTrackDeleteTarget(null)}>{t('workflow.cancel')}</button>
              <button type="button" className="min-h-10 rounded-md bg-red-d px-4 text-base font-semibold text-btn-fg hover:opacity-90" data-testid="track-delete-confirm" onClick={() => { editor.removeTrack(trackDeleteTarget); setTrackDeleteTarget(null) }}>{t('workflow.settings_delete')}</button>
            </>
          )}
        >
          <p className="text-body text-text-2">{t('workflow.delete_track_confirm', { name: editor.branches.find((branch) => branch.id === trackDeleteTarget)?.label ?? trackDeleteTarget })}</p>
        </Dialog>
      )}
      <WorkbenchDialogs
        workflowName={editor.wfName}
        pendingSwitch={editor.pendingSwitch}
        onPendingSwitch={editor.setPendingSwitch}
        onConfirmSwitch={editor.confirmSwitch}
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
