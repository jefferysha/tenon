import { act, render, screen } from '@testing-library/react'
import gsap from 'gsap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { SAVE_BAR_MOTION, SaveBar, type SaveBarEditor } from './SaveBar'

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduce : !reduce,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

function editor(dirty: boolean): SaveBarEditor {
  return { dirty, changeCount: dirty ? 2 : 0, saving: false, saveStatus: { kind: 'idle' }, lintBlocked: false, canWrite: true, save: vi.fn(), discardDraft: vi.fn(), reloadDefinition: vi.fn() } as unknown as SaveBarEditor
}

describe('SaveBar', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('有改动才出现：从底部 12px 滑入 + 淡入 200ms；改动清空后滑出 120ms 再卸载', () => {
    stubMatchMedia(false)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const to = vi.spyOn(gsap, 'to')
    const { rerender } = render(<I18nProvider><SaveBar editor={editor(false)} /></I18nProvider>)
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
    rerender(<I18nProvider><SaveBar editor={editor(true)} /></I18nProvider>)
    expect(screen.getByTestId('wb-save-bar')).toBeInTheDocument()
    expect(fromTo.mock.calls.at(-1)?.[1]).toMatchObject({ autoAlpha: 0, y: SAVE_BAR_MOTION.y })
    expect(fromTo.mock.calls.at(-1)?.[2]).toMatchObject({ autoAlpha: 1, y: 0, duration: 0.2 })
    rerender(<I18nProvider><SaveBar editor={editor(false)} /></I18nProvider>)
    const exit = to.mock.calls.at(-1)?.[1] as gsap.TweenVars
    expect(exit).toMatchObject({ autoAlpha: 0, y: 12, duration: 0.12 })
    expect(screen.getByTestId('wb-save-bar')).toBeInTheDocument()
    act(() => { (exit.onComplete as () => void)() })
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
  })

  it('减少动态效果：不起补间，直接出现、直接消失', () => {
    stubMatchMedia(true)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const { rerender } = render(<I18nProvider><SaveBar editor={editor(true)} /></I18nProvider>)
    expect(screen.getByTestId('wb-save-bar')).toBeInTheDocument()
    rerender(<I18nProvider><SaveBar editor={editor(false)} /></I18nProvider>)
    expect(screen.queryByTestId('wb-save-bar')).toBeNull()
    expect(fromTo).not.toHaveBeenCalled()
  })
})
