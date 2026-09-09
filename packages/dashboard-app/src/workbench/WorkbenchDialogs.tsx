import type { RefObject } from 'react'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { BTN_DANGER, BTN_GHOST, BTN_SOLID, FIELD_INPUT } from './workbenchStyles'
import { slugifyStageName } from './workbenchApiDecoders'

interface DeleteError {
  summary: string
  references: Array<{ kind?: string; source?: string }>
  blockers: Array<{ source?: string; detail?: string }>
}

export function WorkbenchDialogs(props: {
  workflowName: string | null
  pendingSwitch: string | null
  onPendingSwitch: (name: string | null) => void
  onConfirmSwitch: () => void
  createMode: 'new' | 'copy' | null
  workflowNameRef: RefObject<HTMLInputElement>
  workflowDraftName: string
  onWorkflowDraftName: (name: string) => void
  workflowNameInvalid: boolean
  workflowNameDuplicate: boolean
  workflowErrors: string[]
  workflowBusy: boolean
  canSubmitWorkflow: boolean
  onCloseWorkflowCreate: () => void
  onConfirmWorkflowCreate: () => void
  deleteOpen: boolean
  deleteBusy: boolean
  deleteError: DeleteError | null
  dirty: boolean
  onCloseDelete: () => void
  onConfirmDelete: () => void
  addStageOpen: boolean
  addStageNameRef: RefObject<HTMLInputElement>
  stageDraftName: string
  stageDraftId: string
  stageIdTouched: boolean
  stageIdError: string | null
  canSubmitStage: boolean
  onStageDraftName: (name: string) => void
  onStageDraftId: (id: string) => void
  onStageIdTouched: () => void
  onCloseAddStage: () => void
  onConfirmAddStage: () => void
}): JSX.Element {
  const { t } = useT()
  return <>
    {props.pendingSwitch !== null && <Dialog title={t('workbench.switch_confirm_title')} onClose={() => props.onPendingSwitch(null)} testid="wb-switch-confirm" actions={<><button className={BTN_GHOST} onClick={() => props.onPendingSwitch(null)}>{t('workbench.switch_cancel')}</button><button className={BTN_DANGER} onClick={props.onConfirmSwitch}>{t('workbench.switch_discard')}</button></>}><p className="mb-4 text-caption leading-[1.6] text-text-2">{t('workbench.switch_confirm_body', { name: props.workflowName ?? '' })}</p></Dialog>}
    {props.createMode !== null && (
      <Dialog title={props.createMode === 'copy' ? t('workbench.workflow_copy_title') : t('workbench.workflow_new_title')} onClose={props.onCloseWorkflowCreate} testid={props.createMode === 'copy' ? 'wb-workflow-copy-dialog' : 'wb-workflow-create-dialog'} initialFocusRef={props.workflowNameRef}>
        <form onSubmit={(event) => { event.preventDefault(); props.onConfirmWorkflowCreate() }}>
          <p className="mb-4 text-caption leading-[1.6] text-text-2">{props.createMode === 'copy' ? t('workbench.workflow_copy_body', { name: props.workflowName ?? '' }) : t('workbench.workflow_new_body')}</p>
          <div className="flex flex-col gap-1 text-caption font-semibold text-text-2">
            <label htmlFor="wb-workflow-name" data-wb-field-label="">{t('workbench.workflow_name_label')}</label>
            <input ref={props.workflowNameRef} id="wb-workflow-name" className={FIELD_INPUT} value={props.workflowDraftName} aria-invalid={props.workflowNameInvalid || props.workflowNameDuplicate} onChange={(event) => props.onWorkflowDraftName(event.target.value)} />
            {props.workflowNameInvalid && <span className="text-caption text-red" role="alert">{t('workbench.workflow_name_invalid')}</span>}
            {props.workflowNameDuplicate && <span className="text-caption text-red" role="alert">{t('workbench.workflow_name_duplicate')}</span>}
          </div>
          {props.workflowErrors.length > 0 && <ul className="mt-3 rounded-sm border border-red-b bg-red-t p-2.5" role="alert">{props.workflowErrors.map((error) => <li key={error} className="text-caption text-red-d">{error}</li>)}</ul>}
          <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3.5"><button type="button" className={BTN_GHOST} onClick={props.onCloseWorkflowCreate}>{t('workbench.workflow_cancel')}</button><button type="submit" className={BTN_SOLID} data-testid={props.createMode === 'copy' ? 'wb-workflow-copy-confirm' : 'wb-workflow-create-confirm'} disabled={!props.canSubmitWorkflow}>{props.workflowBusy ? t('workbench.workflow_working') : t('workbench.workflow_confirm')}</button></div>
        </form>
      </Dialog>
    )}
    {props.deleteOpen && props.workflowName && (
      <Dialog title={t('workbench.workflow_delete_title', { name: props.workflowName })} onClose={props.onCloseDelete} testid="wb-workflow-delete-dialog" actions={<><button className={BTN_GHOST} onClick={props.onCloseDelete}>{t('workbench.workflow_cancel')}</button><button className={BTN_DANGER} data-testid="wb-workflow-delete-confirm" onClick={props.onConfirmDelete} disabled={props.deleteBusy}>{props.deleteBusy ? t('workbench.workflow_working') : t('workbench.workflow_delete_confirm')}</button></>}>
        <p className="mb-3 text-caption leading-[1.6] text-text-2">{t('workbench.workflow_delete_body', { name: props.workflowName })}</p>
        {props.dirty && <p className="mb-3 rounded-sm bg-amber-t p-2.5 text-caption text-amber-d">{t('workbench.workflow_delete_dirty')}</p>}
        {props.deleteError && <div className="rounded-sm border border-red-b bg-red-t p-3" role="alert" data-testid="wb-workflow-delete-error"><p className="text-caption font-bold text-red-d">{props.deleteError.summary}</p>{(props.deleteError.references.length > 0 || props.deleteError.blockers.length > 0) && <ul className="mt-2 list-disc space-y-1 pl-4 font-mono text-micro text-red-d">{props.deleteError.references.map((reference, index) => <li key={`reference-${index}`}>{reference.kind ?? 'reference'} · {reference.source ?? '?'}</li>)}{props.deleteError.blockers.map((blocker, index) => <li key={`blocker-${index}`}>{blocker.source ?? 'scan'} · {blocker.detail ?? '?'}</li>)}</ul>}</div>}
      </Dialog>
    )}
    {props.addStageOpen && (
      <Dialog title={t('workbench.add_stage_dialog_title')} onClose={props.onCloseAddStage} testid="wb-add-stage" initialFocusRef={props.addStageNameRef}>
        <form onSubmit={(event) => { event.preventDefault(); props.onConfirmAddStage() }}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 text-caption font-semibold text-text-2"><label className="text-micro font-bold tracking-[.03em] uppercase" data-wb-field-label="" htmlFor="wb-add-stage-name-input">{t('workbench.add_stage_name_label')}</label><input ref={props.addStageNameRef} id="wb-add-stage-name-input" className={FIELD_INPUT} data-testid="wb-add-stage-name" value={props.stageDraftName} onChange={(event) => { props.onStageDraftName(event.target.value); if (!props.stageIdTouched) props.onStageDraftId(slugifyStageName(event.target.value)) }} /></div>
            <div className="flex flex-col gap-1 text-caption font-semibold text-text-2"><label className="text-micro font-bold tracking-[.03em] uppercase" data-wb-field-label="" htmlFor="wb-add-stage-id-input">{t('workbench.add_stage_id_label')}</label><input id="wb-add-stage-id-input" className={`${FIELD_INPUT} font-mono`} aria-invalid={props.stageIdError ? true : undefined} data-testid="wb-add-stage-id" value={props.stageDraftId} onChange={(event) => { props.onStageDraftId(event.target.value); props.onStageIdTouched() }} />{props.stageIdError && <span className="text-micro font-semibold text-red" data-testid="wb-add-stage-id-error" role="alert">{props.stageIdError}</span>}</div>
          </div>
          <div className="mt-4 flex justify-end gap-2"><button type="button" className={BTN_GHOST} onClick={props.onCloseAddStage}>{t('workbench.add_stage_cancel')}</button><button type="submit" className={BTN_SOLID} data-testid="wb-add-stage-confirm" disabled={!props.canSubmitStage}>{t('workbench.add_stage_confirm')}</button></div>
        </form>
      </Dialog>
    )}
  </>
}
