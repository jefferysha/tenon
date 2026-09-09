import type { WbTrackDefinition } from '../api/client'
import { useT } from '../i18n'
import { cloneTrackPolicy, type TrackEditorDraft } from './trackEditorDraft'

interface TrackEditorFieldsProps {
  draft: TrackEditorDraft
  editMode: boolean
  builtin: boolean
  tracks: readonly WbTrackDefinition[]
  fieldClass: string
  onUpdate: (patch: Partial<TrackEditorDraft>) => void
}

export function TrackEditorFields(props: TrackEditorFieldsProps): JSX.Element {
  const { t } = useT()
  const updatePolicy = (policyProfile: TrackEditorDraft['policyProfile']): void => props.onUpdate({ policyProfile })
  const routing = props.draft.policyProfile.routing
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-micro font-bold text-text-2">
          {t('workbench.track_id')}
          <input name="track-id" autoComplete="off" className={props.fieldClass} value={props.draft.id} disabled={props.editMode} onChange={(event) => props.onUpdate({ id: event.target.value })} />
        </label>
        <label className="grid gap-1 text-micro font-bold text-text-2">
          {t('workbench.track_label')}
          <input name="track-label" autoComplete="off" aria-label={t('workbench.track_label')} className={props.fieldClass} value={props.draft.label} onChange={(event) => props.onUpdate({ label: event.target.value })} />
        </label>
        <label className="grid gap-1 text-micro font-bold text-text-2">
          {t('workbench.track_workflow_default')}
          <input name="track-workflow-default" autoComplete="off" aria-label={t('workbench.track_workflow_default')} className={props.fieldClass} value={props.draft.workflowDefault} onChange={(event) => props.onUpdate({ workflowDefault: event.target.value })} />
        </label>
        <label className="flex items-center gap-2 self-end rounded-sm border border-border px-2 py-1.5 text-micro font-bold text-text-2">
          <input name="track-workflow-any" type="checkbox" checked={props.draft.workflowAny} onChange={(event) => props.onUpdate({ workflowAny: event.target.checked })} />
          {t('workbench.track_workflow_any')}
        </label>
        {!props.draft.workflowAny && (
          <label className="grid gap-1 text-micro font-bold text-text-2 sm:col-span-2">
            {t('workbench.track_workflow_allowed')}
            <input name="track-workflow-allowed" autoComplete="off" className={props.fieldClass} value={props.draft.workflowAllowed} onChange={(event) => props.onUpdate({ workflowAllowed: event.target.value })} />
          </label>
        )}
        {!props.builtin && (
          <label className="grid gap-1 text-micro font-bold text-text-2 sm:col-span-2">
            {t('workbench.track_policy_template')}
            <select aria-label={t('workbench.track_policy_template')} name="track-policy-template" className={props.fieldClass} defaultValue="" onChange={(event) => {
              const template = props.tracks.find((track) => track.id === event.target.value && track.builtin)
              if (template) updatePolicy(cloneTrackPolicy(template.policyProfile))
            }}>
              <option value="">{t('workbench.track_policy_keep')}</option>
              {props.tracks.filter((track) => track.builtin).map((track) => <option key={track.id} value={track.id}>{track.id}</option>)}
            </select>
          </label>
        )}
      </div>
      {!props.builtin && (
        <details className="mt-3 rounded-sm border border-border bg-card/60 p-2">
          <summary className="cursor-pointer text-caption font-bold text-text-2">{t('workbench.track_policy_details')}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-micro text-text-2">{t('workbench.track_review_seed')}
              <select name="track-review-seed" className={props.fieldClass} value={props.draft.policyProfile.reviewSeed} onChange={(event) => {
                const reviewSeed = event.target.value
                if (reviewSeed === 'pending' || reviewSeed === 'skipped') updatePolicy({ ...props.draft.policyProfile, reviewSeed })
              }}>
                <option value="pending">{t('workbench.track_review_pending')}</option><option value="skipped">{t('workbench.track_review_skipped')}</option>
              </select>
            </label>
            <label className="grid gap-1 text-micro text-text-2">{t('workbench.track_coverage')}
              <select name="track-coverage-profile" className={props.fieldClass} value={props.draft.policyProfile.coverageProfile} onChange={(event) => {
                const coverageProfile = event.target.value
                if (coverageProfile === 'none' || coverageProfile === 'pm' || coverageProfile === 'frontend' || coverageProfile === 'backend') {
                  updatePolicy({ ...props.draft.policyProfile, coverageProfile })
                }
              }}>
                <option value="none">{t('workbench.track_coverage_none')}</option><option value="pm">{t('workbench.track_coverage_pm')}</option><option value="frontend">{t('workbench.track_coverage_frontend')}</option><option value="backend">{t('workbench.track_coverage_backend')}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-micro text-text-2"><input name="track-automation-eligible" type="checkbox" checked={props.draft.policyProfile.automationEligible} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, automationEligible: event.target.checked })} />{t('workbench.track_afk_manual')}</label>
            <label className="flex items-center gap-2 text-micro text-text-2"><input name="track-auto-enqueue" type="checkbox" checked={props.draft.policyProfile.autoEnqueueOnSpecComplete ?? false} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, autoEnqueueOnSpecComplete: event.target.checked })} />{t('workbench.track_afk_auto')}</label>
            <label className="flex items-center gap-2 text-micro text-text-2"><input name="track-skills-matrix" type="checkbox" checked={props.draft.policyProfile.skills.matrix} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, skills: { ...props.draft.policyProfile.skills, matrix: event.target.checked } })} />{t('workbench.track_skills_matrix')}</label>
            <label className="grid gap-1 text-micro text-text-2">{t('workbench.track_skills_profile')}<input name="track-skills-profile" autoComplete="off" className={props.fieldClass} value={props.draft.policyProfile.skills.profile} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, skills: { ...props.draft.policyProfile.skills, profile: event.target.value } })} /></label>
            <label className="flex items-center gap-2 text-micro text-text-2"><input name="track-routing-enabled" type="checkbox" checked={routing.enabled} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, routing: event.target.checked ? { enabled: true, pattern: '', priority: 0 } : { enabled: false } })} />{t('workbench.track_routing_enabled')}</label>
            {routing.enabled && <>
              <label className="grid gap-1 text-micro text-text-2">{t('workbench.track_routing_pattern')}<input name="track-routing-pattern" autoComplete="off" className={props.fieldClass} value={routing.pattern} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, routing: { ...routing, pattern: event.target.value } })} /></label>
              <label className="grid gap-1 text-micro text-text-2">{t('workbench.track_routing_exclude')}<input name="track-routing-exclude" autoComplete="off" className={props.fieldClass} value={routing.excludePattern ?? ''} onChange={(event) => {
                const excludePattern = event.target.value
                updatePolicy({ ...props.draft.policyProfile, routing: excludePattern === '' ? { enabled: true, pattern: routing.pattern, priority: routing.priority } : { ...routing, excludePattern } })
              }} /></label>
              <label className="grid gap-1 text-micro text-text-2">{t('workbench.track_routing_priority')}<input name="track-routing-priority" autoComplete="off" type="number" min="0" className={props.fieldClass} value={routing.priority} onChange={(event) => updatePolicy({ ...props.draft.policyProfile, routing: { ...routing, priority: Number(event.target.value) } })} /></label>
            </>}
          </div>
        </details>
      )}
    </>
  )
}
