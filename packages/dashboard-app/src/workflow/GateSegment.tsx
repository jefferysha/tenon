import { ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import type { WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { gateKind } from '../workbench/workbenchDefinition'
import { handleRadioKey } from '../shared/radioKeyboard'
import { SEGMENT_SLIDE_S, SEGMENT_THUMB_CLS, useSlidingIndicator } from '../shared/useSlidingIndicator'
import { Hint } from './Hint'
import { cn } from '@/lib/utils'

const GATES: ReadonlyArray<{ gate: 'review' | 'auto'; icon: LucideIcon }> = [
  { gate: 'review', icon: ShieldCheck },
  { gate: 'auto', icon: Zap },
]
/** 与设置弹层的分段控件同一配方：fill 轨道 + 共享白色滑块（useSlidingIndicator）。 */
const SEGMENT = 'relative inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:text-text disabled:cursor-not-allowed disabled:hover:text-text-2 motion-reduce:transition-none'

/** 门禁分段控件：评审 / 自动（`gate: null` 与自动同义，按自动选中）。说明只在 Tooltip（悬停与键盘聚焦），读屏经 aria-describedby。 */
export function GateSegment({ stepId, value, disabled, onChange }: {
  stepId: string
  value: WbStepDef['gate']
  disabled: boolean
  onChange: (gate: 'review' | 'auto') => void
}): JSX.Element {
  const { t } = useT()
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>({ duration: SEGMENT_SLIDE_S })
  const current = gateKind(value)
  const select = (gate: 'review' | 'auto'): void => {
    if (gate !== current) onChange(gate)
  }
  return (
    <div ref={containerRef} className="relative isolate flex max-w-[24rem] gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={t('workflow.gate_title')} data-testid={`wb-lane-gate-${stepId}`}>
      {GATES.map(({ gate, icon: Icon }, index) => {
        const key = gate
        const checked = current === gate
        return (
          <Hint key={key} label={t(`workflow.gate_help_${key}`)}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-describedby={`gate-help-${stepId}-${key}`}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              className={SEGMENT}
              data-testid={`wb-lane-gate-${stepId}-${key}`}
              onClick={() => select(gate)}
              onKeyDown={(event) => handleRadioKey(event, index, GATES.length, (next) => select(GATES[next]?.gate ?? gate))}
            >
              <Icon className={cn('relative size-3.5', checked ? 'text-(--accent)' : 'text-text-3')} aria-hidden="true" />
              <span className="relative">{t(`workflow.gate_${key}`)}</span>
              <span id={`gate-help-${stepId}-${key}`} className="sr-only">{t(`workflow.gate_help_${key}`)}</span>
            </button>
          </Hint>
        )
      })}
      <span ref={indicatorRef} className={SEGMENT_THUMB_CLS} aria-hidden="true" data-testid={`wb-lane-gate-${stepId}-indicator`} />
    </div>
  )
}
