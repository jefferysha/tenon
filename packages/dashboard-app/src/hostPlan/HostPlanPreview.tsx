import { useState } from 'react'
import type { HostTargetPlan } from '../api/hostTargetPlanTypes'
import { useT } from '../i18n'
import { BUTTON_GHOST, PANEL } from '../shared/uiRecipes'

interface HostPlanPreviewProps {
  plan: HostTargetPlan
  copyText: (text: string) => Promise<void>
}

function translatedToken(
  token: string,
  prefix: 'host-plan.step.' | 'host-plan.notice.' | 'host-plan.condition.',
  translationPrefix: 'hostPlan.steps.' | 'hostPlan.notices.' | 'hostPlan.conditions.',
  t: (key: string) => string,
): string {
  if (!token.startsWith(prefix)) return token
  const key = `${translationPrefix}${token.slice(prefix.length)}`
  const translated = t(key)
  return translated === key ? token : translated
}

export function HostPlanPreview({ plan, copyText }: HostPlanPreviewProps): JSX.Element {
  const { t } = useT()
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')

  const copyCommand = (): void => {
    setCopyState('idle')
    void Promise.resolve().then(() => copyText(plan.command.display)).then(
      () => setCopyState('success'),
      () => setCopyState('error'),
    )
  }

  return (
    <section
      className={`mt-5 min-w-0 p-5 ${PANEL}`}
      data-testid="host-plan-preview"
      aria-labelledby="host-plan-preview-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="host-plan-preview-title" className="text-title font-bold text-text">
          {t('hostPlan.preview_title')}
        </h3>
        <span className="rounded-full border border-green-b bg-green-t px-2.5 py-1 text-micro font-bold text-green-d">
          {t('hostPlan.zero_side_effects')}
        </span>
      </div>

      <div className="mt-4 min-w-0 rounded-md border border-border bg-fill/35 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption font-bold text-text-2">{t('hostPlan.command')}</span>
          <button
            type="button"
            className={`${BUTTON_GHOST} px-2.5 py-1.5 text-caption`}
            onClick={copyCommand}
          >
            {t('hostPlan.copy_command')}
          </button>
        </div>
        <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre rounded-md bg-ink p-3 font-mono text-caption text-ink-fg">
          <code>{plan.command.display}</code>
        </pre>
        {copyState !== 'idle' && (
          <p
            className={`mt-2 text-caption font-semibold ${copyState === 'success' ? 'text-green-d' : 'text-red-d'}`}
            role="status"
          >
            {copyState === 'success' ? t('hostPlan.copy_success') : t('hostPlan.copy_error')}
          </p>
        )}
      </div>

      <h4 className="mt-5 text-base font-bold text-text">{t('hostPlan.steps_title')}</h4>
      <ol className="mt-3 space-y-3">
        {plan.steps.map((step, index) => (
          <li key={step.id} className="min-w-0 rounded-md border border-border bg-card p-3 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-fill font-mono text-micro font-bold text-text-2">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-semibold text-text">
                    {translatedToken(step.label, 'host-plan.step.', 'hostPlan.steps.', t)}
                  </p>
                  {step.condition !== undefined && (
                    <span
                      className="rounded-full border border-amber-b bg-amber-t/60 px-2 py-0.5 text-micro font-bold text-amber-d"
                      data-testid={`host-plan-step-conditional-${step.id}`}
                    >
                      {t('hostPlan.conditional_badge')}
                    </span>
                  )}
                </div>
                {step.condition !== undefined && (
                  <p className="mt-1 text-caption text-text-2">
                    {translatedToken(step.condition, 'host-plan.condition.', 'hostPlan.conditions.', t)}
                  </p>
                )}
                {step.command && (
                  <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre rounded-md border border-border bg-card p-2.5 font-mono text-caption text-text-2">
                    <code>{step.command.display}</code>
                  </pre>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {plan.notices.length > 0 && (
        <aside className="mt-5 rounded-md border border-amber-b bg-amber-t/45 p-4 text-base text-amber-d">
          <h4 className="font-bold">{t('hostPlan.notices_title')}</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {plan.notices.map((notice) => (
              <li key={notice}>
                {translatedToken(notice, 'host-plan.notice.', 'hostPlan.notices.', t)}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  )
}
