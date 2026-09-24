import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import gsap from 'gsap'
import { Flip } from 'gsap/Flip'
import { Circle, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import type { WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import { handleRadioKey } from '../shared/radioKeyboard'
import { Hint } from './Hint'
import { cn } from '@/lib/utils'

gsap.registerPlugin(Flip)

const GATES: ReadonlyArray<{ gate: WbStepDef['gate']; key: 'none' | 'review' | 'auto'; icon: LucideIcon }> = [
  { gate: null, key: 'none', icon: Circle },
  { gate: 'review', key: 'review', icon: ShieldCheck },
  { gate: 'auto', key: 'auto', icon: Zap },
]
/** 滑块换位的补间时长（s）。 */
export const THUMB_FLIP_S = 0.18
const THUMB = '[data-segment-thumb]'
/** 与设置弹层的分段控件同一配方：fill 轨道 + 选中项白色滑块。 */
const SEGMENT = 'relative inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:text-text disabled:cursor-not-allowed disabled:hover:text-text-2 motion-reduce:transition-none'

function motionAllowed(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 选中滑块换位：改值前记下旧滑块的位置，新滑块渲染到选中项里之后用 GSAP Flip 从旧位置补间过去。
 * 减少动态效果时不记录，滑块直接出现在新位置。
 */
function useThumbFlip(track: RefObject<HTMLElement | null>, value: unknown): () => void {
  const pending = useRef<Flip.FlipState | null>(null)
  const capture = useCallback((): void => {
    const thumb = track.current?.querySelector(THUMB)
    if (thumb === null || thumb === undefined || !motionAllowed()) return
    pending.current = Flip.getState(thumb)
  }, [track])
  useLayoutEffect(() => {
    const state = pending.current
    pending.current = null
    const thumb = track.current?.querySelector(THUMB)
    if (state === null || thumb === null || thumb === undefined) return
    const tween = Flip.from(state, { targets: thumb, duration: THUMB_FLIP_S, ease: 'power3.out' })
    return () => { tween.kill() }
  }, [track, value])
  return capture
}

/** 门禁分段控件：不拦 / 评审 / 自动。说明只在 Tooltip（悬停与键盘聚焦），读屏经 aria-describedby。 */
export function GateSegment({ stepId, value, disabled, onChange }: {
  stepId: string
  value: WbStepDef['gate']
  disabled: boolean
  onChange: (gate: WbStepDef['gate']) => void
}): JSX.Element {
  const { t } = useT()
  const track = useRef<HTMLDivElement>(null)
  const capture = useThumbFlip(track, value)
  const select = (gate: WbStepDef['gate']): void => {
    if (gate === value) return
    capture()
    onChange(gate)
  }
  return (
    <div ref={track} className="flex max-w-[24rem] gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={t('workflow.gate_title')} data-testid={`wb-lane-gate-${stepId}`}>
      {GATES.map(({ gate, key, icon: Icon }, index) => {
        const checked = value === gate
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
              {checked && <span className="absolute inset-0 rounded-sm bg-card shadow-sm" aria-hidden="true" data-segment-thumb="" data-flip-id={`gate-thumb-${stepId}`} />}
              <Icon className={cn('relative size-3.5', checked ? 'text-(--accent)' : 'text-text-3')} aria-hidden="true" />
              <span className="relative">{t(`workflow.gate_${key}`)}</span>
              <span id={`gate-help-${stepId}-${key}`} className="sr-only">{t(`workflow.gate_help_${key}`)}</span>
            </button>
          </Hint>
        )
      })}
    </div>
  )
}
