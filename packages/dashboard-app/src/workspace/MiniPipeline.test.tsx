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

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

function renderPipeline(current: number) {
  return render(<I18nProvider><MiniPipeline stages={stages(current)} testId="pipe" /></I18nProvider>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('MiniPipeline（B9）', () => {
  it('首次挂载直接是终态，不播放', () => {
    mockReducedMotion(false)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    renderPipeline(1)
    expect(fromTo).not.toHaveBeenCalled()
  })

  it('当前阶段推进时，新当前段的内填从左端 scaleX 长出（400ms power2.out）', () => {
    mockReducedMotion(false)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const view = renderPipeline(0)
    view.rerender(<I18nProvider><MiniPipeline stages={stages(1)} testId="pipe" /></I18nProvider>)
    expect(fromTo).toHaveBeenCalledTimes(1)
    const [target, from, to] = fromTo.mock.calls[0] ?? []
    expect(target).toBe(screen.getByTestId('pipe-now'))
    expect(from).toEqual({ scaleX: 0 })
    expect(to).toMatchObject({ scaleX: 1, duration: 0.4, ease: 'power2.out', transformOrigin: 'left center' })
  })

  it('reduced-motion 下推进不播放', () => {
    mockReducedMotion(true)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const view = renderPipeline(0)
    view.rerender(<I18nProvider><MiniPipeline stages={stages(1)} testId="pipe" /></I18nProvider>)
    expect(fromTo).not.toHaveBeenCalled()
  })

  it('段底色变化有 240ms 过渡', () => {
    renderPipeline(1)
    for (const segment of screen.getByTestId('pipe').querySelectorAll('[data-status]')) {
      expect(segment.className).toContain('transition-colors')
      expect(segment.className).toContain('duration-(--dur-panel)')
    }
  })
})
