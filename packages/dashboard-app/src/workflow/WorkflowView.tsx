import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { DEFAULT_RULES, rulesKey, useWorkflowRulesMulti } from '../model/workflowModel'
import { useGlobalSearch } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import { useWorkflowEditor } from '../workbench/useWorkflowEditor'
import { WorkbenchDialogs } from '../workbench/WorkbenchDialogs'
import { NewWorkflowDialog } from './NewWorkflowDialog'
import { PipelineList } from './PipelineList'
import { StageEditorPane } from './StageEditorPane'
import { WorkflowRail } from './WorkflowRail'

export interface WorkflowViewProps {
  root: string
  onDirtyChange?: (dirty: boolean) => void
  onToast?: (message: string) => void
}

const RAIL_KEY = 'tenon-dashboard-rail:workflow'

/** 工作流 = 定义编辑页：左列工作流 / 中列流水线 / 右列所选阶段的技能 DAG、轨道技能、输出、输入、门禁。 */
export function WorkflowView({ root, onDirtyChange, onToast }: WorkflowViewProps): JSX.Element {
  const { t } = useT()
  const { query } = useGlobalSearch()
  const editor = useWorkflowEditor({ root, onDirtyChange })
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])
  const { rules: rulesByKey } = useWorkflowRulesMulti(editor.names && editor.names.length > 0 ? [{ root, names: editor.names }] : [])
  const stagesCountOf = (name: string): number | null =>
    name === editor.wfName && editor.def ? editor.def.steps.length : name === 'default' ? DEFAULT_RULES.steps.length : rulesByKey.get(rulesKey(root, name))?.steps.length ?? null

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
      <ThreeColumns
        testId="workbench-view"
        railCollapsed={railCollapsed}
        rail={(
          <WorkflowRail
            names={editor.menuNames}
            current={editor.wfName}
            defaultSource={editor.defaultSource}
            stagesCountOf={stagesCountOf}
            mandatory={editor.mandatory}
            collapsed={railCollapsed}
            canWrite={editor.canWrite}
            busy={editor.saving || editor.create.busy}
            onToggle={() => setRailCollapsed((value) => !value)}
            onSwitch={editor.requestSwitch}
            onCreate={() => editor.create.openCreate('copy')}
            onImport={() => editor.create.openCreate('import')}
            onExport={() => void exportYaml()}
            onDelete={editor.openWorkflowDelete}
          />
        )}
        list={(
          <PipelineList
            def={editor.def}
            labelOf={editor.labelOf}
            selectedId={editor.stageId}
            lint={editor.lint}
            query={query}
            loading={editor.def === null && editor.defErrorText === null}
            error={editor.namesErrorText ?? editor.defErrorText}
            canWrite={editor.canWrite}
            onSelect={editor.setStageId}
            onAddStage={() => editor.stageDraft.setAddStageOpen(true)}
          />
        )}
        detail={editor.selectedStep
          ? <StageEditorPane key={`${editor.wfName} ${editor.selectedStep.id}`} editor={editor} step={editor.selectedStep} />
          : <DetailEmpty title={t('workflow.no_stage')} desc="" testId="stage-editor-empty" />}
      />
      <NewWorkflowDialog create={editor.create} currentName={editor.wfName} />
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
