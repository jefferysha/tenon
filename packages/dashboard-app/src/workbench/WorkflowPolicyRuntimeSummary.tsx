import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { changeWorkflow } from '../model/changeModel'
import { isProjectNavigable } from '../state/projectSelectionModel'
import type {
  ChangeSnapshot,
  Snapshot,
  WorkflowDecompositionPolicySnapshot,
  WorkflowInteractionPolicySnapshot,
  WorkflowPolicyRulesSnapshot,
} from '../types'

export interface WorkflowPolicyRuntimeSummaryProps {
  root: string
  workflowName: string | null
  snapshot: Snapshot | null
}

type Policy = WorkflowPolicyRulesSnapshot
type ConfiguredStatus = Policy['configured']['status']
type DriftStatus = Policy['drift']['status']
type DecompositionMode = WorkflowDecompositionPolicySnapshot['mode']
type InteractionMode = WorkflowInteractionPolicySnapshot['mode']

const CARD = 'mb-4 min-w-0 rounded-lg border border-border bg-card p-4 shadow-sm'
const SUBSECTION = 'min-w-0 rounded-md border border-border bg-bg/50 p-4'
const LABEL = 'text-micro font-bold uppercase tracking-[.06em] text-text-3'
const VALUE = 'min-w-0 text-body text-text-2'
const CODE = 'font-mono text-caption text-text [overflow-wrap:anywhere]'
const DECOMPOSITION_MODE_KEYS: Record<DecompositionMode, string> = {
  off: 'workbench.policy_decomposition_mode_off',
  suggest: 'workbench.policy_decomposition_mode_suggest',
  'auto-safe': 'workbench.policy_decomposition_mode_auto_safe',
  'require-review': 'workbench.policy_decomposition_mode_require_review',
}
const INTERACTION_MODE_KEYS: Record<InteractionMode, string> = {
  interactive: 'workbench.policy_interaction_interactive',
  'recommended-defaults': 'workbench.policy_interaction_recommended',
  afk: 'workbench.policy_interaction_afk',
}

function selectRuntimeChange(
  snapshot: Snapshot,
  root: string,
  workflowName: string,
): ChangeSnapshot | null {
  const candidates = snapshot.projects
    .filter((project) => project.root === root && isProjectNavigable(project))
    .flatMap((project) => project.changes
      .filter((change) => change.archived !== 'true' && changeWorkflow(change) === workflowName))
  candidates.sort((left, right) => {
    if (left.updated_at !== right.updated_at) return left.updated_at > right.updated_at ? -1 : 1
    if (left.name === right.name) return 0
    return left.name < right.name ? -1 : 1
  })
  return candidates[0] ?? null
}

function FactRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-border bg-card px-3 py-2.5">
      <dt className={LABEL}>{label}</dt>
      <dd className={`mt-1.5 ${VALUE}`}>{children}</dd>
    </div>
  )
}

function StatusValue({ testId, children }: { testId?: string; children: ReactNode }): JSX.Element {
  return <span data-testid={testId} role="status" className="font-semibold text-text">{children}</span>
}

function StateNotice({ message }: { message: string }): JSX.Element {
  return <p data-testid="workflow-policy-runtime-state" role="status" aria-live="polite" className="rounded-md border border-border bg-bg/50 px-3 py-2.5 text-base leading-6 text-text-2">{message}</p>
}

function Fingerprint({ label, testId, value }: { label: string; testId: string; value: string }): JSX.Element {
  return <code aria-label={label} data-testid={testId} tabIndex={0} className={`${CODE} block select-text whitespace-normal break-all rounded-md border border-code-border bg-code-bg px-3 py-2.5 leading-6 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)`}>{value}</code>
}

function ChangeIdentity({ change, root, workflowName }: { change: ChangeSnapshot; root: string; workflowName: string }): JSX.Element {
  const { t } = useT()
  return (
    <section className={`${SUBSECTION} mb-4`} aria-labelledby="workflow-policy-runtime-source-title">
      <h3 id="workflow-policy-runtime-source-title" className="m-0 text-base font-extrabold text-text">{t('workbench.policy_runtime_source')}</h3>
      <dl className="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
        <FactRow label={t('workbench.policy_runtime_source_change')}><code data-testid="workflow-policy-runtime-source-change" className={CODE}>{change.name}</code></FactRow>
        <FactRow label={t('workbench.policy_runtime_source_workflow')}><code className={CODE}>{workflowName}</code></FactRow>
        <FactRow label={t('workbench.policy_runtime_source_root')}><code className={`${CODE} break-all`}>{root}</code></FactRow>
      </dl>
    </section>
  )
}

function ConfiguredPolicy({ policy }: { policy: Policy }): JSX.Element {
  const { t } = useT()
  const configured = policy.configured
  const statusKey: Record<ConfiguredStatus, string> = {
    available: 'workbench.policy_runtime_configured_available',
    missing: 'workbench.policy_runtime_configured_missing',
    invalid: 'workbench.policy_runtime_configured_invalid',
    unavailable: 'workbench.policy_runtime_configured_unavailable',
  }
  return (
    <section className={SUBSECTION} aria-labelledby="workflow-policy-runtime-configured-title">
      <h3 id="workflow-policy-runtime-configured-title" className="m-0 text-base font-extrabold text-text">{t('workbench.policy_runtime_configured')}</h3>
      <dl className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
        <FactRow label={t('workbench.policy_runtime_status')}>
          <StatusValue testId="workflow-policy-runtime-configured-status">{t(statusKey[configured.status])}</StatusValue>
        </FactRow>
        {configured.status === 'available' && (
          <>
            <FactRow label={t('workbench.policy_runtime_configured_fingerprint')}>
              <Fingerprint label={t('workbench.policy_runtime_configured_fingerprint')} testId="workflow-policy-runtime-configured-fingerprint" value={configured.workflowFingerprint} />
            </FactRow>
            <FactRow label={t('workbench.policy_runtime_configured_decomposition')}>
              <span data-testid="workflow-policy-runtime-configured-decomposition">
                {t(DECOMPOSITION_MODE_KEYS[configured.decomposition.mode])} <code className={CODE}>({configured.decomposition.mode})</code>
              </span>
            </FactRow>
            <FactRow label={t('workbench.policy_runtime_configured_interaction')}>
              <span data-testid="workflow-policy-runtime-configured-interaction">
                {t(INTERACTION_MODE_KEYS[configured.interaction.mode])} <code className={CODE}>({configured.interaction.mode})</code>
              </span>
            </FactRow>
          </>
        )}
      </dl>
    </section>
  )
}

function FrozenPolicy({ policy }: { policy: Policy }): JSX.Element {
  const { t } = useT()
  return (
    <section className={SUBSECTION} aria-labelledby="workflow-policy-runtime-frozen-title">
      <h3 id="workflow-policy-runtime-frozen-title" className="m-0 text-base font-extrabold text-text">{t('workbench.policy_runtime_frozen')}</h3>
      <dl className="mt-3 grid min-w-0 gap-2">
        <FactRow label={t('workbench.policy_runtime_frozen_fingerprint')}>
          <Fingerprint label={t('workbench.policy_runtime_frozen_fingerprint')} testId="workflow-policy-runtime-frozen-fingerprint" value={policy.frozen.workflowFingerprint} />
        </FactRow>
        <FactRow label={t('workbench.policy_runtime_frozen_decomposition')}>
          <span>{t(DECOMPOSITION_MODE_KEYS[policy.frozen.decomposition.mode])} <code className={CODE}>({policy.frozen.decomposition.mode})</code></span>
        </FactRow>
        <FactRow label={t('workbench.policy_runtime_frozen_interaction')}>
          <span>{t(INTERACTION_MODE_KEYS[policy.frozen.interaction.mode])} <code className={CODE}>({policy.frozen.interaction.mode})</code></span>
        </FactRow>
        <FactRow label={t('workbench.policy_runtime_frozen_ceiling')}>
          <div data-testid="workflow-policy-runtime-frozen-ceiling">
            {policy.frozen.workflowCeiling.grants.length === 0
              ? <p className="m-0 text-caption leading-5 text-text-3" data-testid="workflow-policy-runtime-frozen-ceiling-empty" role="status">{t('workbench.policy_runtime_frozen_ceiling_empty')}</p>
              : <ul className="m-0 grid min-w-0 gap-1.5 pl-5 text-caption text-text-2">{policy.frozen.workflowCeiling.grants.map((action) => <li key={action}><code className={CODE}>{action}</code></li>)}</ul>}
          </div>
        </FactRow>
      </dl>
    </section>
  )
}

function booleanLabel(value: boolean | null, t: (key: string) => string): string {
  if (value === null) return t('workbench.policy_runtime_value_unknown')
  return value ? t('workbench.policy_runtime_value_yes') : t('workbench.policy_runtime_value_no')
}

function DriftPolicy({ policy }: { policy: Policy }): JSX.Element {
  const { t } = useT()
  const statusKey: Record<DriftStatus, string> = {
    current: 'workbench.policy_runtime_drift_current',
    changed: 'workbench.policy_runtime_drift_changed',
    missing: 'workbench.policy_runtime_drift_missing',
    invalid: 'workbench.policy_runtime_drift_invalid',
    unavailable: 'workbench.policy_runtime_drift_unavailable',
  }
  return (
    <section className={SUBSECTION} aria-labelledby="workflow-policy-runtime-drift-title">
      <h3 id="workflow-policy-runtime-drift-title" className="m-0 text-base font-extrabold text-text">{t('workbench.policy_runtime_drift')}</h3>
      <dl className="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
        <FactRow label={t('workbench.policy_runtime_drift_status')}>
          <StatusValue testId="workflow-policy-runtime-drift-status">{t(statusKey[policy.drift.status])}</StatusValue>
        </FactRow>
        <FactRow label={t('workbench.policy_runtime_drift_fingerprint')}>
          <StatusValue testId="workflow-policy-runtime-drift-fingerprint">{booleanLabel(policy.drift.fingerprintChanged, t)} <code className={CODE}>(fingerprintChanged)</code></StatusValue>
        </FactRow>
        <FactRow label={t('workbench.policy_runtime_drift_policy')}>
          <StatusValue testId="workflow-policy-runtime-drift-policy">{booleanLabel(policy.drift.policyChanged, t)} <code className={CODE}>(policyChanged)</code></StatusValue>
        </FactRow>
      </dl>
    </section>
  )
}

function EffectivePolicy({ policy }: { policy: Policy }): JSX.Element {
  const { t } = useT()
  const effective = policy.effective
  const labelSeparator = t('workbench.policy_runtime_label_separator')
  if (effective.status === 'unavailable') {
    return (
      <section className={SUBSECTION} aria-labelledby="workflow-policy-runtime-effective-title">
        <h3 id="workflow-policy-runtime-effective-title" className="m-0 text-base font-extrabold text-text">{t('workbench.policy_runtime_effective')}</h3>
        <dl className="mt-3 grid min-w-0 gap-2">
          <FactRow label={t('workbench.policy_runtime_status')}><StatusValue testId="workflow-policy-runtime-effective-state">{t('workbench.policy_runtime_effective_unavailable')}</StatusValue></FactRow>
          <FactRow label={t('workbench.policy_runtime_effective_reason')}>
            <p className="m-0 leading-6 text-text-2" data-testid="workflow-policy-runtime-effective-reason">
              <code className={`${CODE} mr-2`}>{effective.reason}</code>{t('workbench.policy_runtime_reason_authority_input_unavailable')}
            </p>
          </FactRow>
        </dl>
      </section>
    )
  }

  return (
    <section className={SUBSECTION} aria-labelledby="workflow-policy-runtime-effective-title">
      <h3 id="workflow-policy-runtime-effective-title" className="m-0 text-base font-extrabold text-text">{t('workbench.policy_runtime_effective')}</h3>
      <div className="mt-3 grid min-w-0 gap-4 md:grid-cols-2">
        <div className="min-w-0" data-testid="workflow-policy-runtime-grants">
          <h4 className="m-0 text-caption font-bold text-text-2">{t('workbench.policy_runtime_grants')}</h4>
          {effective.grants.length === 0
            ? <p className="mt-2 mb-0 text-caption leading-5 text-text-3" role="status">{t('workbench.policy_runtime_grants_empty')}</p>
            : <ul className="mt-2 mb-0 grid min-w-0 gap-1.5 pl-5 text-caption text-text-2">{effective.grants.map((action) => <li key={action}><code className={CODE}>{action}</code></li>)}</ul>}
        </div>
        <div className="min-w-0" data-testid="workflow-policy-runtime-denials">
          <h4 className="m-0 text-caption font-bold text-text-2">{t('workbench.policy_runtime_denials')}</h4>
          {effective.denials.length === 0
            ? <p className="mt-2 mb-0 text-caption leading-5 text-text-3" role="status">{t('workbench.policy_runtime_denials_empty')}</p>
            : <ul className="mt-2 mb-0 grid min-w-0 gap-2 pl-5 text-caption text-text-2">{effective.denials.map((denial, index) => (
              <li key={`${denial.action}-${denial.code}-${index}`} className="min-w-0 leading-5">
                <div><span className="font-semibold text-text-2">{t('workbench.policy_runtime_denial_action')}{labelSeparator}</span><code className={CODE}>{denial.action}</code></div>
                {denial.layer !== undefined && <div><span className="font-semibold text-text-2">{t('workbench.policy_runtime_denial_layer')}{labelSeparator}</span><code className={CODE}>{denial.layer}</code></div>}
                <div><span className="font-semibold text-text-2">{t('workbench.policy_runtime_denial_code')}{labelSeparator}</span><code className={CODE}>{denial.code}</code></div>
                <div className="break-words"><span className="font-semibold text-text-2">{t('workbench.policy_runtime_denial_remediation')}{labelSeparator}</span>{denial.remediation}</div>
              </li>
            ))}</ul>}
        </div>
      </div>
    </section>
  )
}

function PolicyDetails({ policy }: { policy: Policy }): JSX.Element {
  return (
    <div className="grid min-w-0 gap-3">
      <ConfiguredPolicy policy={policy} />
      <FrozenPolicy policy={policy} />
      <DriftPolicy policy={policy} />
      <EffectivePolicy policy={policy} />
    </div>
  )
}

export function WorkflowPolicyRuntimeSummary({ root, workflowName, snapshot }: WorkflowPolicyRuntimeSummaryProps): JSX.Element {
  const { t } = useT()
  const change = snapshot !== null && workflowName !== null
    ? selectRuntimeChange(snapshot, root, workflowName)
    : null
  const policy = change?.workflowRules.policy

  return (
    <section className={CARD} aria-labelledby="workflow-policy-runtime-title" data-testid="workflow-policy-runtime-summary">
      <div className="mb-4 flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="workflow-policy-runtime-title" className="m-0 text-title font-extrabold tracking-[-0.01em] text-text">{t('workbench.policy_runtime_title')}</h2>
          <p className="mt-1 mb-0 max-w-3xl text-caption leading-5 text-text-3">{t('workbench.policy_runtime_desc')}</p>
        </div>
      </div>
      {workflowName === null
        ? <StateNotice message={t('workbench.policy_runtime_not_selected')} />
        : snapshot === null
          ? <StateNotice message={t('workbench.policy_runtime_snapshot_absent')} />
          : change === null
            ? <StateNotice message={t('workbench.policy_runtime_no_active_change')} />
            : <>
              <ChangeIdentity change={change} root={root} workflowName={workflowName} />
              {policy === undefined
                ? <StateNotice message={t('workbench.policy_runtime_policy_absent')} />
                : <PolicyDetails policy={policy} />}
            </>}
    </section>
  )
}
