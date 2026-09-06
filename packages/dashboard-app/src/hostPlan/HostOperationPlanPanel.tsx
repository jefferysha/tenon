import type {
  HostId,
  HostOperation,
  HostTarget,
  HostTargetPlan,
} from '../api/hostTargetPlanTypes'
import { useT } from '../i18n'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { HostPlanPreview } from './HostPlanPreview'

export type HostPlanRequestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; plan: HostTargetPlan }

interface HostOperationPlanPanelProps {
  target: HostTarget
  targetLabel: string
  selectedOperation: HostOperation | null
  planState: HostPlanRequestState
  copyText: (text: string) => Promise<void>
  onRequestPlan: (host: HostId, operation: HostOperation) => void
  errorMessage: (error: unknown) => string
}

export function HostOperationPlanPanel({
  target,
  targetLabel,
  selectedOperation,
  planState,
  copyText,
  onRequestPlan,
  errorMessage,
}: HostOperationPlanPanelProps): JSX.Element {
  const { t } = useT()

  return (
    <section
      className="min-w-0 rounded-2xl border border-blue-b bg-blue-t/30 p-5 shadow-sm"
      aria-labelledby="host-plan-operation-title"
    >
      <h2 id="host-plan-operation-title" className="text-base font-bold text-text">
        {t('hostPlan.operation_title', { host: targetLabel })}
      </h2>
      <div
        className="mt-3 rounded-xl border border-border bg-card/80 p-3"
        data-testid="host-selected-context"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <code className="text-xs font-semibold text-text">{target.cli_flag}</code>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border bg-fill px-2 py-1 text-[11px] font-semibold text-text-2">
              {t(`hostPlan.kind.${target.kind}`)}
            </span>
            <span className="rounded-full border border-border bg-bg px-2 py-1 text-[11px] font-semibold text-text-3">
              {t(`hostPlan.scope.${target.target_scope}`)}
            </span>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {target.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded-full border border-blue-b bg-blue-t px-2 py-1 text-[11px] font-semibold text-blue-d"
            >
              {t(`hostPlan.capability.${capability}`)}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t('hostPlan.operation_group')}>
        {target.supported_operations.map((operation) => (
          <button
            key={operation}
            type="button"
            aria-pressed={selectedOperation === operation}
            className="rounded-xl border border-border-2 bg-card px-4 py-2 text-sm font-bold text-text outline-none transition-[background-color,border-color,box-shadow] hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--ring-blue) aria-[pressed=true]:border-(--accent) aria-[pressed=true]:bg-blue-t aria-[pressed=true]:text-blue-d"
            onClick={() => onRequestPlan(target.id, operation)}
          >
            {t(`hostPlan.operation.${operation}`)}
          </button>
        ))}
      </div>

      {planState.status === 'idle' ? (
        <p className="mt-4 text-sm text-text-2" role="status">{t('hostPlan.awaiting_operation')}</p>
      ) : planState.status === 'loading' && selectedOperation ? (
        <p className="mt-4 text-sm text-text-2" role="status">
          {t('hostPlan.plan_loading', {
            host: targetLabel,
            operation: t(`hostPlan.operation.${selectedOperation}`),
          })}
        </p>
      ) : planState.status === 'error' && selectedOperation ? (
        <div className="mt-4 rounded-xl border border-red-b bg-red-t p-4 text-red-d" role="alert">
          <p className="break-words text-sm">{errorMessage(planState.error)}</p>
          <button
            type="button"
            className={`${BUTTON_GHOST} mt-3 border-red-b bg-card text-red-d hover:border-red-b hover:bg-red-t`}
            onClick={() => onRequestPlan(target.id, selectedOperation)}
          >
            {t('hostPlan.plan_retry', { operation: t(`hostPlan.operation.${selectedOperation}`) })}
          </button>
        </div>
      ) : planState.status === 'ready' ? (
        <>
          <p
            className="sr-only"
            role="status"
            aria-live="polite"
            data-testid="host-plan-ready-announcement"
          >
            {t('hostPlan.plan_ready', {
              host: targetLabel,
              operation: t(`hostPlan.operation.${planState.plan.operation}`),
            })}
          </p>
          <HostPlanPreview plan={planState.plan} copyText={copyText} />
        </>
      ) : null}
    </section>
  )
}
