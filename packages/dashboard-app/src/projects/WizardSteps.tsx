import { Check } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'
import { WIZARD_STEPS, type WizardStep } from './newProjectModel'

const LABEL: Record<WizardStep, string> = {
  location: 'projects.step_location',
  templates: 'projects.templates',
  clients: 'projects.step_clients',
  confirm: 'projects.confirm',
}

export interface WizardStepsProps {
  current: WizardStep
  /** 点已完成的步骤返回；当前与后面的步骤不可点。 */
  onBack: (step: WizardStep) => void
}

/** 步骤条：位置 → 模板 → 客户端 → 确认。当前步高亮，已完成步带勾、可点击返回。 */
export function WizardSteps({ current, onBack }: WizardStepsProps): JSX.Element {
  const { t } = useT()
  const at = WIZARD_STEPS.indexOf(current)
  return (
    <ol className="flex items-center gap-2" aria-label={t('projects.steps_label')} data-testid="np-steps">
      {WIZARD_STEPS.map((step, index) => {
        const done = index < at
        const active = index === at
        return (
          <li key={step} className="flex min-w-0 items-center gap-2">
            {index > 0 && <span className={cn('h-px w-6 flex-none', index <= at ? 'bg-(--accent)' : 'bg-border')} aria-hidden="true" />}
            <button
              type="button"
              disabled={!done}
              aria-current={active ? 'step' : undefined}
              data-testid={`np-step-${step}`}
              data-state={done ? 'done' : active ? 'active' : 'todo'}
              className="group flex min-h-10 items-center gap-2 rounded-sm px-1.5 whitespace-nowrap outline-none transition-colors duration-(--dur-fast) enabled:cursor-pointer enabled:hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)"
              onClick={() => onBack(step)}
            >
              <span
                className={cn(
                  'grid size-6 flex-none place-items-center rounded-full border text-micro font-semibold transition-colors duration-(--dur-base)',
                  done && 'border-(--accent) bg-(--accent) text-btn-fg',
                  active && 'border-(--accent) bg-accent-t text-(--accent)',
                  !done && !active && 'border-border-2 text-text-3',
                )}
                aria-hidden="true"
              >
                {done ? <Check className="size-3.5" strokeWidth={2.5} /> : index + 1}
              </span>
              <span className={cn('text-caption font-semibold', active ? 'text-text' : done ? 'text-text-2' : 'text-text-3')}>{t(LABEL[step])}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
