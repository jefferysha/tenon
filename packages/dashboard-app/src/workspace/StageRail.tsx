import { useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'
import { useT } from '../i18n'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

/** 段 4px 高、段间 2px：已完成 = 成功绿，当前 = 强调色（GSAP 呼吸），未到 = 边框灰。无描边、无内填。 */
const BAR_CLS: Record<StageState['status'], string> = {
  done: 'bg-green',
  current: 'bg-(--accent)',
  todo: 'bg-border',
}
const LABEL_CLS: Record<StageState['status'], string> = {
  done: 'text-text-2',
  current: 'font-semibold text-(--accent)',
  todo: 'text-text-2',
}

function prefersReducedMotion(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 当前段持续呼吸（不透明度 1 ↔ .45 往复）；reduced-motion 不播放。 */
function useCurrentPulse(currentId: string | undefined): (element: HTMLElement | null) => void {
  const target = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const element = target.current
    if (currentId === undefined || element === null || prefersReducedMotion()) return
    const tween = gsap.to(element, { opacity: 0.45, duration: 0.9, ease: 'sine.inOut', repeat: -1, yoyo: true })
    return () => { tween.kill(); gsap.set(element, { clearProps: 'opacity' }) }
  }, [currentId])
  return (element) => { target.current = element }
}

/** 右列阶段轨：每段一个阶段，点段 = 查看该阶段的输入 / 输出；所选阶段的名称加粗。 */
export function StageRail({ stages, selected, onSelect }: { stages: readonly StageState[]; selected: string | null; onSelect: (step: string) => void }): JSX.Element {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current')
  const pulseRef = useCurrentPulse(current?.id)
  return (
    <div
      className="grid gap-x-0.5"
      style={{ gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(0, 1fr))` }}
      role="group"
      aria-label={current ? t('workspace.rail_label', { stage: current.label }) : t('workspace.rail_label_none')}
      data-testid="stage-rail"
    >
      {stages.map((stage) => (
        <button
          key={stage.id}
          type="button"
          className="group grid min-w-0 gap-2.5 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2"
          aria-pressed={selected === stage.id}
          aria-label={`${stage.label} · ${t(`workspace.stage_${stage.status}`)}`}
          data-status={stage.status}
          data-testid={`stage-rail-${stage.id}`}
          onClick={() => onSelect(stage.id)}
        >
          <span
            ref={stage.status === 'current' ? pulseRef : undefined}
            className={cn('block h-1', BAR_CLS[stage.status])}
            aria-hidden="true"
            data-testid={`stage-rail-bar-${stage.id}`}
          />
          <span className={cn('truncate pr-2 text-body group-hover:text-text', LABEL_CLS[stage.status], selected === stage.id && 'font-semibold text-text', stage.status === 'current' && 'text-(--accent)')}>{stage.label}</span>
        </button>
      ))}
    </div>
  )
}
