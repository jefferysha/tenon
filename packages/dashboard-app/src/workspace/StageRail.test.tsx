import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import gsap from 'gsap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { StageRail } from './StageRail'
import type { StageState } from './taskModel'

const STAGES: StageState[] = [
  { id: 'spec', label: '规格', status: 'done' },
  { id: 'build', label: '实现', status: 'current' },
  { id: 'verify', label: '验证', status: 'todo' },
]

function renderRail(props: { selected?: string | null; running?: boolean; onSelect?: (id: string) => void } = {}) {
  return render(<I18nProvider><StageRail stages={STAGES} selected={props.selected ?? null} onSelect={props.onSelect ?? (() => undefined)} running={props.running ?? false} /></I18nProvider>)
}

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') ? reduce : !reduce, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('StageRail', () => {
  it('3px 段：完成 = 暖灰（--flow-step-done），当前 = 强调色，未到 = 边框灰；无描边', () => {
    renderRail()
    const bars = ['spec', 'build', 'verify'].map((id) => screen.getByTestId(`stage-rail-bar-${id}`))
    for (const bar of bars) expect(bar.className).toContain('h-[3px]')
    expect(bars[0]!.className).toContain('bg-(--flow-step-done)')
    expect(bars[1]!.className).toContain('bg-(--accent)')
    expect(bars[2]!.className).toContain('bg-border')
    expect(bars[0]!.className).not.toContain('bg-green')
  })

  it('选中 = 标签下 2px 墨色下划线，不加粗；当前阶段标签是强调色加粗', () => {
    renderRail({ selected: 'verify' })
    const label = (id: string) => within(screen.getByTestId(`stage-rail-${id}`)).getByText(id === 'spec' ? '规格' : id === 'build' ? '实现' : '验证')
    expect(label('verify').className).toContain('border-b-2')
    expect(label('verify').className).toContain('border-(--ink)')
    expect(label('verify').className).not.toContain('font-semibold')
    expect(label('spec').className).toContain('border-transparent')
    expect(label('build').className).toContain('text-(--accent)')
    expect(label('build').className).toContain('font-semibold')
  })

  it('点段 = 选中该阶段', async () => {
    const onSelect = vi.fn()
    renderRail({ onSelect })
    await userEvent.click(screen.getByTestId('stage-rail-verify'))
    expect(onSelect).toHaveBeenCalledWith('verify')
  })

  it('不呼吸：当前段没有任何循环 tween（阻塞时也是），只有任务在跑才有彗星', () => {
    const to = vi.spyOn(gsap, 'to')
    const fromTo = vi.spyOn(gsap, 'fromTo')
    stubMatchMedia(false)
    renderRail()
    expect(to).not.toHaveBeenCalled()
    expect(fromTo).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stage-rail-comet')).toBeNull()
  })

  it('任务在跑：只有当前段上有一颗四层彗星，按运行流的速度循环；卸载时 kill', () => {
    stubMatchMedia(false)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    const view = renderRail({ running: true })
    const comets = screen.getAllByTestId('stage-rail-comet')
    expect(comets).toHaveLength(1)
    expect(screen.getByTestId('stage-rail-bar-build')).toContainElement(comets[0]!)
    expect([...comets[0]!.children].map((layer) => (layer as HTMLElement).style.width)).toEqual(['72px', '48px', '26px', '10px'])
    expect([...comets[0]!.children].map((layer) => (layer as HTMLElement).style.opacity)).toEqual(['0.14', '0.3', '0.55', '1'])
    expect(fromTo).toHaveBeenCalledTimes(1)
    expect(fromTo.mock.calls[0]![2]).toMatchObject({ ease: 'none', repeat: -1 })
    const tween = fromTo.mock.results[0]!.value as gsap.core.Tween
    const kill = vi.spyOn(tween, 'kill')
    view.unmount()
    expect(kill).toHaveBeenCalled()
  })

  it('减少动态效果：彗星不动（不建 tween）', () => {
    stubMatchMedia(true)
    const fromTo = vi.spyOn(gsap, 'fromTo')
    renderRail({ running: true })
    expect(fromTo).not.toHaveBeenCalled()
  })
})
