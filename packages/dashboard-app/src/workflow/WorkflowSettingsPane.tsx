import { useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useT } from '../i18n'
import type { Snapshot } from '../types'
import { SheetTabs, useSheetState, type SheetDef } from '../shared/DetailSheets'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { WorkbenchGovernanceDialog } from '../workbench/WorkbenchGovernanceDialog'
import { WorkflowPolicyEditor } from '../workbench/WorkflowPolicyEditor'
import { WorkflowPolicyRuntimeSummary } from '../workbench/WorkflowPolicyRuntimeSummary'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'

const SHEETS = ['policy', 'runtime', 'hooks', 'governance'] as const
type SheetId = (typeof SHEETS)[number]

export interface WorkflowSettingsPaneProps {
  editor: WorkflowEditor
  root: string
  snapshot: Snapshot | null
}

/** 工作流页右列 · 工作流设置：策略（拆解 / 交互 / 评审预算）/ 运行时（冻结策略与漂移）/ 钩子覆盖 / 治理入口。 */
export function WorkflowSettingsPane({ editor, root, snapshot }: WorkflowSettingsPaneProps): JSX.Element {
  const { t } = useT()
  const [governanceOpen, setGovernanceOpen] = useState(false)
  const sheets: readonly SheetDef<SheetId>[] = useMemo(() => [
    { id: 'policy', label: t('workflow.wf_sheet_policy') },
    { id: 'runtime', label: t('workflow.wf_sheet_runtime') },
    { id: 'hooks', label: t('workflow.wf_sheet_hooks'), count: editor.hooksConfig.hooks?.length },
    { id: 'governance', label: t('workflow.wf_sheet_governance') },
  ], [editor.hooksConfig.hooks?.length, t])
  const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:workflow-settings', sheets, 'policy')
  const summary = editor.summary

  return (
    <DetailColumn
      testId="workflow-settings-pane"
      panelId="workflow-settings-panel"
      labelledBy={`workflow-settings-tab-${sheet}`}
      header={(
        <>
          <p className="mb-2.5 text-caption font-semibold text-(--accent)">{t('workflow.rail_title')} / {t('workflow.settings_eyebrow')}</p>
          <h1 className="mb-1.5 text-page font-bold tracking-[-.01em] text-text">{editor.wfName ?? ''}</h1>
          <p className="mb-4 font-mono text-base text-text-2">{t(editor.readonlyWf ? 'workflow.builtin_meta' : 'workflow.project_meta')}</p>
          <p className="mb-6 flex flex-wrap items-center gap-3.5">
            <StatusPill tone={editor.readonlyWf ? 'neutral' : 'done'}>{t(editor.readonlyWf ? 'workflow.builtin_readonly' : 'workflow.editable')}</StatusPill>
            {summary && (
              <span className="text-base text-text-2">{t('workflow.settings_summary', { stages: summary.stages, gates: summary.gates, skills: summary.skills })}</span>
            )}
            {editor.def?.openspecContract === 'required' && <StatusPill tone="pending" testId="wb-openspec-contract">{t('workbench.openspec_contract')}</StatusPill>}
          </p>
        </>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('shell.sheet_label')} idPrefix="workflow-settings" />}
      footer={<p className="text-body text-text-2">{t('workflow.settings_footer')}</p>}
    >
      {sheet === 'policy' && (
        <WorkflowPolicyEditor
          definition={editor.def}
          readonly={editor.readonlyWf}
          loading={editor.def === null && editor.defErrorText === null}
          error={editor.defErrorText}
          dirty={editor.policyDirty}
          saving={editor.saving}
          saveStatus={editor.saveStatus.kind === 'ok' ? 'success' : 'idle'}
          onChange={(definition) => editor.setDef(() => definition)}
          onSave={() => void editor.save()}
          onCancel={editor.cancelPolicyDraft}
          onRetry={editor.reloadDefinition}
        />
      )}
      {sheet === 'runtime' && <WorkflowPolicyRuntimeSummary root={root} workflowName={editor.wfName} snapshot={snapshot} />}
      {sheet === 'hooks' && (
        <div className="grid gap-3" data-testid="workflow-hooks-sheet">
          <h2 className="text-section font-bold text-text">{t('workflow.wf_sheet_hooks')}</h2>
          {editor.hooksConfig.hooks === null ? (
            <p className="text-body text-text-3" role="status">{editor.hooksConfig.loadError ?? t('workflow.hooks_none')}</p>
          ) : (
            <ul className="grid gap-1.5">
              {editor.hooksConfig.hooks.map((hook) => (
                <li key={hook.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-3.5 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-body font-semibold text-text">{hook.id}</span>
                    <span className="block truncate text-caption text-text-2">{hook.event}</span>
                  </span>
                  <span className="text-caption text-text-3">
                    {t('workflow.hooks_enabled_in', { n: editor.boardLanes.filter((lane) => !(`${hook.id}.${lane.id}` in editor.hooksConfig.matrix)).length, total: editor.boardLanes.length })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {sheet === 'governance' && (
        <div className="grid gap-4" data-testid="workflow-governance-sheet">
          <h2 className="text-section font-bold text-text">{t('workflow.wf_sheet_governance')}</h2>
          <p className="text-base text-text-2">{t('workflow.governance_desc')}</p>
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-2 self-start rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3"
            data-testid="wb-governance-open"
            disabled={!editor.def}
            onClick={() => setGovernanceOpen(true)}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t('workflow.governance_open')}
          </button>
          {governanceOpen && (
            <WorkbenchGovernanceDialog
              root={root}
              loops={editor.loops}
              summary={editor.summary}
              recent={editor.recent}
              recentSilent={editor.recentSilent}
              onClose={() => setGovernanceOpen(false)}
              onDirtyChange={editor.setSourceDirty}
            />
          )}
        </div>
      )}
    </DetailColumn>
  )
}
