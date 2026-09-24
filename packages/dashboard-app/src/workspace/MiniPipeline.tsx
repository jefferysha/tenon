import { useLayoutEffect, useRef, type RefObject } from 'react'
import gsap from 'gsap'
import { useT } from '../i18n'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

const SEG_CLS: Record<StageState['status'], string> = {
  done: 'bg-seg-done',
  current: 'bg-seg-now-t',
  todo: 'bg-seg-next',
}

function prefersReducedMotion(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 阶段推进时当前段的内填从左端长出（scaleX 0→1，400ms power2.out）。首次挂载直接是终态，
 * 只有当前阶段变化时才播放；reduced-motion 不播放。
 */
function useAdvanceFill(currentId: string | undefined): RefObject<HTMLElement> {
  const fillRef = useRef<HTMLElement>(null)
  const previous = useRef(currentId)
  useLayoutEffect(() => {
    const changed = previous.current !== currentId
    previous.current = currentId
    const fill = fillRef.current
    if (!changed || fill === null || prefersReducedMotion()) return
    const tween = gsap.fromTo(fill, { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: 'power2.out', transformOrigin: 'left center' })
    return () => { tween.kill(); gsap.set(fill, { clearProps: 'transform' }) }
  }, [currentId])
  return fillRef
}

/**
 * 任务卡上的迷你流水线：每段一个阶段，已完成 / 当前 / 待进行三色。当前段是浅底 + 40% 内填，
 * 读作「正在做」而不是「做完」；只有一个阶段的工作流不画分段条（一段满条读起来像 100%）。
 * 段变为完成时底色过渡 240ms。
 */
export function MiniPipeline({ stages, testId }: { stages: readonly StageState[]; testId?: string }): JSX.Element | null {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current')
  const fillRef = useAdvanceFill(current?.id)
  if (stages.length <= 1) return null
  return (
    <span
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid={testId}
    >
      {stages.map((stage) => (
        <i
          key={stage.id}
          className={cn('block h-1.5 overflow-hidden rounded-full transition-colors duration-(--dur-panel) ease-(--ease-out) motion-reduce:duration-100', SEG_CLS[stage.status])}
          data-status={stage.status}
          title={stage.label}
        >
          {stage.status === 'current' && <i ref={fillRef} className="block h-full w-2/5 origin-left rounded-full bg-seg-now" data-testid={testId === undefined ? undefined : `${testId}-now`} />}
        </i>
      ))}
    </span>
  )
}
