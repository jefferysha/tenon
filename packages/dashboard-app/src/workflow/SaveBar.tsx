import { useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useT } from '../i18n'
import { BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { cn } from '@/lib/utils'

/** 进场 / 退场时长（s）与位移（px）。 */
export const SAVE_BAR_MOTION = { enter: 0.2, exit: 0.12, y: 12 } as const

function motionAllowed(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export type SaveBarEditor = Pick<WorkflowEditor, 'dirty' | 'changeCount' | 'saving' | 'saveStatus' | 'lintBlocked' | 'canWrite' | 'save' | 'discardDraft' | 'reloadDefinition'>

/**
 * 编辑器自己的保存条：只在有未保存改动时出现（贴在滚动区底部），从底部 12px 滑入 + 淡入；改动清空（保存成功 /
 * 放弃）后滑出再卸载。减少动态效果时直接出现、直接消失。
 */
export function SaveBar({ editor, className }: { editor: SaveBarEditor; className?: string }): JSX.Element | null {
  const { t } = useT()
  const [shown, setShown] = useState(editor.dirty)
  const ref = useRef<HTMLDivElement>(null)
  const dirty = editor.dirty
  if (dirty && !shown) setShown(true)

  useLayoutEffect(() => {
    const bar = ref.current
    if (bar === null) return
    if (!motionAllowed()) {
      if (!dirty) setShown(false)
      return
    }
    const tween = dirty
      ? gsap.fromTo(bar, { autoAlpha: 0, y: SAVE_BAR_MOTION.y }, { autoAlpha: 1, y: 0, duration: SAVE_BAR_MOTION.enter, ease: 'power3.out' })
      : gsap.to(bar, { autoAlpha: 0, y: SAVE_BAR_MOTION.y, duration: SAVE_BAR_MOTION.exit, ease: 'power2.in', onComplete: () => setShown(false) })
    return () => { tween.kill() }
  }, [dirty, shown])

  if (!shown) return null
  const blocked = editor.lintBlocked
  return (
    <div ref={ref} className={cn('sticky bottom-0 z-20 flex items-center justify-between gap-4 border-t border-border bg-card/85 backdrop-blur-md', className)} data-testid="wb-save-bar">
      <p className="flex min-w-0 items-center gap-2 text-body text-text-2">
        <span className="size-1.5 flex-none rounded-full bg-(--amber-d)" aria-hidden="true" />
        <span className="truncate whitespace-nowrap" data-testid="wb-dirty" data-count={editor.changeCount} role="status" aria-live="polite">{blocked ? t('workflow.lint_blocked') : t('workflow.dirty_n', { n: editor.changeCount })}</span>
      </p>
      <span className="flex flex-none items-center gap-2">
        {editor.saveStatus.kind === 'error' && (
          <span className="max-w-[40ch] truncate whitespace-nowrap text-caption text-red-d" role="alert" data-testid="wb-save-error" title={editor.saveStatus.errors.join('\n')}>{editor.saveStatus.errors[0]}</span>
        )}
        {editor.saveStatus.kind === 'error' && editor.saveStatus.conflict === true && (
          <button type="button" className={BUTTON_GHOST} data-testid="wb-save-conflict-reload" onClick={editor.reloadDefinition}>{t('workbench.save_conflict_reload')}</button>
        )}
        <button type="button" className={BUTTON_GHOST} data-testid="wb-discard" disabled={!dirty || editor.saving} onClick={editor.discardDraft}>{t('workflow.discard')}</button>
        <button type="button" className={BUTTON_SOLID} data-testid="wb-save" disabled={!editor.canWrite || !dirty || editor.saving || blocked} onClick={() => void editor.save()}>{t('workflow.save')}</button>
      </span>
    </div>
  )
}
