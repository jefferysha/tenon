import { cleanup, render, screen } from '@testing-library/react'
import gsap from 'gsap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { MiniPipeline } from './MiniPipeline'
import type { StageState } from './taskModel'

function stages(current: number): StageState[] {
  return ['spec', 'build', 'verify'].map((id, index) => ({
    id,
    label: id,
    status: index < current ? 'done' : index === current ? 'current' : 'todo',
  }))
}

function renderPipeline(current: number) {
  return render(<I18nProvider><MiniPipeline stages={stages(current)} testId="pipe" /></I18nProvider>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MiniPipeline', () => {
  it('与阶段轨同款：4px 段、2px 段距；完成 = 成功绿，当前 = 强调色，未到 = 边框灰；无内填', () => {
    renderPipeline(1)
    const pipeline = screen.getByTestId('pipe')
    expect(pipeline.className).toContain('gap-x-0.5')
    const segments = [...pipeline.querySelectorAll('[data-status]')]
    expect(segments.map((segment) => segment.getAttribute('data-status'))).toEqual(['done', 'current', 'todo'])
    for (const segment of segments) {
      expect(segment.className).toContain('h-1')
      expect(segment.childElementCount).toBe(0)
    }
    expect(segments[0]?.className).toContain('bg-green')
    expect(segments[1]?.className).toContain('bg-(--accent)')
    expect(segments[2]?.className).toContain('bg-border')
    expect(pipeline.innerHTML).not.toMatch(/seg-now|amber|w-2\/5/)
  })

  it('列表卡静态：挂载与推进都不调用 GSAP', () => {
    const to = vi.spyOn(gsap, 'to')
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const view = renderPipeline(0)
    view.rerender(<I18nProvider><MiniPipeline stages={stages(1)} testId="pipe" /></I18nProvider>)
    expect(to).not.toHaveBeenCalled()
    expect(fromTo).not.toHaveBeenCalled()
  })

  it('单阶段工作流不画分段条', () => {
    render(<I18nProvider><MiniPipeline stages={[{ id: 'only', label: 'only', status: 'current' }]} testId="pipe" /></I18nProvider>)
    expect(screen.queryByTestId('pipe')).toBeNull()
  })
})
