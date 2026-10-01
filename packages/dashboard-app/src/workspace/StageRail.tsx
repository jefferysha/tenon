import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useT } from '../i18n'
import { STREAK_LAYERS, STREAK_REACH, RUNNING, prefersReducedMotion } from '../workflow/flowSignal'
import type { StageState } from './taskModel'
import { cn } from '@/lib/utils'

/** 段 3px 高、段间 2px：已完成 = 暖灰（与强调色亮度差 ≥ 3:1），当前 = 强调色，未到 = 边框灰。无描边、无内填、不呼吸。 */
export const RAIL_BAR_CLS: Record<StageState['status'], string> = {
  done: 'bg-(--flow-step-done)',
  current: 'bg-(--accent)',
  todo: 'bg-border',
}
const LABEL_CLS: Record<StageState['status'], string> = {
  done: 'text-text-2',
  current: 'font-semibold text-(--accent)',
  todo: 'text-text-2',
}

/**
 * 任务在跑时，当前段上匀速滑过一颗与画布同款的 Signal 彗星（四层：光晕 72 / 拖尾 48、26 / 核 10，头部对齐右缘）：
 * 只动一个容器的 transform，按运行流的速度与间距循环；减少动态效果时不挂。
 */
function SegmentStreak(): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = ref.current
    const bar = element?.parentElement
    if (element === null || bar === null || bar === undefined || prefersReducedMotion()) return
    const travel = bar.clientWidth + STREAK_REACH
    const tween = gsap.fromTo(element, { x: -STREAK_REACH }, { x: bar.clientWidth, duration: travel / RUNNING.speed, ease: 'none', repeat: -1, repeatDelay: Math.max(0, RUNNING.spacing - travel) / RUNNING.speed })
    return () => { tween.kill(); gsap.set(element, { clearProps: 'transform' }) }
  }, [])
  return (
    <span ref={ref} className="pointer-events-none absolute inset-y-0 left-0" style={{ width: STREAK_REACH }} aria-hidden="true" data-testid="stage-rail-streak">
      {STREAK_LAYERS.map((layer) => (
        <span key={layer.id} className="absolute inset-y-0 right-0 bg-(--flow-streak)" style={{ width: layer.length, opacity: layer.opacity }} />
      ))}
    </span>
  )
}

/** 右列阶段轨：每段一个阶段，点段 = 查看该阶段的输入 / 输出；所选阶段的标签下一条 2px 墨色下划线。 */
export function StageRail({ stages, selected, onSelect, running = false }: { stages: readonly StageState[]; selected: string | null; onSelect: (step: string) => void; running?: boolean }): JSX.Element {
  const { t } = useT()
  const current = stages.find((stage) => stage.status === 'current')
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
            className={cn('relative block h-[3px] overflow-hidden', RAIL_BAR_CLS[stage.status])}
            aria-hidden="true"
            data-testid={`stage-rail-bar-${stage.id}`}
          >
            {running && stage.status === 'current' && <SegmentStreak />}
          </span>
          <span className="min-w-0 pr-2">
            <span className={cn('inline-block max-w-full truncate border-b-2 pb-1 align-top text-body group-hover:text-text', LABEL_CLS[stage.status], selected === stage.id ? 'border-(--ink)' : 'border-transparent')}>{stage.label}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
