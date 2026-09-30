import { CircleCheck, CircleX, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 节点的运行状态；「等待」是默认状态：只画一个安静的小圆，不写字。 */
export type GlyphState = 'waiting' | 'running' | 'done' | 'failed' | 'stale'

/** 尾部固定显示的字符数：长名中间截断时，区分度都在尾巴上（openspec-propose / openspec-explore）。 */
export const NAME_TAIL = 6

/** 名称拆成「可截断的头」+「固定的尾」；短名不拆。 */
export function splitName(name: string, tail: number = NAME_TAIL): { head: string; tail: string } {
  const chars = [...name]
  if (chars.length <= tail * 2) return { head: name, tail: '' }
  return { head: chars.slice(0, chars.length - tail).join(''), tail: chars.slice(-tail).join('') }
}

/** 中间截断保尾：头部在放不下时以省略号收尾，尾部 6 个字符始终可见；整名放得下就完整显示。 */
export function MiddleText({ text, className, testId }: { text: string; className?: string; testId?: string }): JSX.Element {
  const { head, tail } = splitName(text)
  return (
    <span className={cn('flex min-w-0 flex-1 whitespace-nowrap', className)} title={text} data-testid={testId}>
      <span className="min-w-0 truncate">{head}</span>
      {tail !== '' && <span className="flex-none">{tail}</span>}
    </span>
  )
}

/** 12px 弧形符号：运行中匀速旋转（transform，走合成器）；减少动态效果时静止。 */
function ArcGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className={cn('size-3 flex-none animate-[flow-spin_1s_linear_infinite] motion-reduce:animate-none', className)} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" data-testid="flow-arc">
      <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
    </svg>
  )
}

const GLYPH_TONE: Record<GlyphState, string> = {
  waiting: 'text-text-4',
  running: 'text-(--accent)',
  done: 'text-green',
  failed: 'text-red-d',
  stale: 'text-amber-d',
}

/** 左侧状态符号：形状 + 颜色，两者缺一不可（等待 = 小圆点，运行 = 转动的弧，完成 = 勾，失败 = 叉，过期 = 钟）。 */
export function StateGlyph({ state, label }: { state: GlyphState; label: string }): JSX.Element {
  return (
    <span className={cn('grid size-3.5 flex-none place-items-center', GLYPH_TONE[state])} title={label} data-testid="flow-glyph" data-glyph={state}>
      {state === 'running' ? <ArcGlyph />
        : state === 'done' ? <CircleCheck className="size-3.5" aria-hidden="true" />
          : state === 'failed' ? <CircleX className="size-3.5" aria-hidden="true" />
            : state === 'stale' ? <Clock className="size-3.5" aria-hidden="true" />
              : <i className="block size-1.5 rounded-full bg-current" aria-hidden="true" />}
    </span>
  )
}
