import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FitName } from './flowGlyphs'
import { fitName, nameSegments, pairCandidates } from './fitName'

/** 每个字符 7px（省略号也算一个），与真实字体无关，只验证选择逻辑。 */
const measure = (texts: readonly string[]): number[] => texts.map((text) => [...text].length * 7)
/** 名称那一格的可用宽度（一个窄节点）。 */
const NARROW = 130

describe('nameSegments / pairCandidates', () => {
  it('splits on - and :, each segment carries its trailing separator, and the pieces rejoin to the original', () => {
    expect(nameSegments('test-driven-development')).toEqual(['test-', 'driven-', 'development'])
    expect(nameSegments('superpowers:test-driven-development')).toEqual(['superpowers:', 'test-', 'driven-', 'development'])
    expect(nameSegments('brainstorming')).toEqual(['brainstorming'])
    expect(nameSegments('finishing-a-development-branch').join('')).toBe('finishing-a-development-branch')
  })

  it('writes first…last for every way of keeping whole segments at both ends, without the separator before the ellipsis', () => {
    expect(pairCandidates(nameSegments('openspec-propose'))).toEqual([])
    expect(pairCandidates(nameSegments('test-driven-development'))).toEqual(['test…development'])
    expect(pairCandidates(nameSegments('finishing-a-development-branch'))).toEqual([
      'finishing…branch', 'finishing…development-branch', 'finishing-a…branch',
    ])
  })
})

describe('fitName', () => {
  it('shows the whole name when it fits (a pixel to spare)', () => {
    expect(fitName('openspec-propose', NARROW, measure)).toBe('openspec-propose')
    expect(fitName('brainstorming', NARROW, measure)).toBe('brainstorming')
    expect(fitName('abcdefghijklmnopqr', 127, measure)).toBe('abcdefghijklmnopqr')
  })

  it('too long: keeps the first and the last segment with an ellipsis between, never cutting a word', () => {
    expect(fitName('test-driven-development', NARROW, measure)).toBe('test…development')
    expect(fitName('subagent-driven-development', 150, measure)).toBe('subagent…development')
    expect(fitName('dispatching-parallel-agents', NARROW, measure)).toBe('dispatching…agents')
  })

  it('keeps more segments when they fit: the widest written form that still fits wins', () => {
    expect(fitName('finishing-a-development-branch', NARROW, measure)).toBe('finishing-a…branch')
    expect(fitName('finishing-a-development-branch', 200, measure)).toBe('finishing…development-branch')
    expect(fitName('finishing-a-development-branch', 220, measure)).toBe('finishing-a-development-branch')
  })

  it('when even first…last does not fit, shortens the first segment and keeps the last one whole', () => {
    expect(fitName('verification-before-completion', NARROW, measure)).toBe('verific…completion')
    expect(fitName('subagent-driven-development', NARROW, measure)).toBe('subage…development')
    expect(fitName('openspec-propose', 90, measure)).toBe('open…propose')
  })

  it('a single segment (or one that cannot be shortened) is left to the end-truncation of the element', () => {
    expect(fitName('supercalifragilistic', NARROW, measure)).toBe('supercalifragilistic')
    expect(fitName('abcdefghijklmnopqr', 126, measure)).toBe('abcdefghijklmnopqr')
    expect(fitName('a-supercalifragilistic', 60, measure)).toBe('a-supercalifragilistic')
    expect(fitName('代码规模', 20, measure)).toBe('代码规模')
  })

  it('does nothing when the width cannot be measured (no layout)', () => {
    expect(fitName('test-driven-development', 0, measure)).toBe('test-driven-development')
  })
})

describe('FitName', () => {
  const proto = HTMLElement.prototype
  let boxWidth = NARROW
  const resizeObservers: Array<() => void> = []

  function stubLayout(): void {
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.getAttribute('data-testid') === 'name' ? boxWidth : 0 } })
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.className === 'block w-max' ? [...(this.textContent ?? '')].length * 7 : 0 } })
  }

  afterEach(() => {
    Reflect.deleteProperty(proto, 'clientWidth')
    Reflect.deleteProperty(proto, 'offsetWidth')
    vi.unstubAllGlobals()
    resizeObservers.length = 0
    boxWidth = NARROW
  })

  it('shows the whole name with no layout to measure (jsdom), the full name always in title', () => {
    render(<FitName text="test-driven-development" testId="name" />)
    expect(screen.getByTestId('name')).toHaveTextContent('test-driven-development')
    expect(screen.getByTestId('name')).toHaveAttribute('title', 'test-driven-development')
  })

  it('shows first…last when the box is too narrow, the full name in title, and leaves no ruler behind', () => {
    stubLayout()
    const { container } = render(<FitName text="test-driven-development" testId="name" className="font-sans" />)
    const name = screen.getByTestId('name')
    expect(name).toHaveTextContent(/^test…development$/u)
    expect(name).toHaveAttribute('title', 'test-driven-development')
    expect(name.className).toContain('truncate')
    expect(name.className).toContain('whitespace-nowrap')
    expect(name.className).toContain('font-sans')
    expect(container.querySelector('[data-fit-ruler]')).toBeNull()
  })

  it('follows the text, and measures again when the box width changes', () => {
    stubLayout()
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: () => void
      constructor(callback: () => void) { this.callback = callback; resizeObservers.push(callback) }
      observe(): void {}
      disconnect(): void {
        const at = resizeObservers.indexOf(this.callback)
        if (at >= 0) resizeObservers.splice(at, 1)
      }
    })
    const { rerender } = render(<FitName text="test-driven-development" testId="name" />)
    expect(screen.getByTestId('name')).toHaveTextContent(/^test…development$/u)
    rerender(<FitName text="openspec-propose" testId="name" />)
    expect(screen.getByTestId('name')).toHaveTextContent(/^openspec-propose$/u)
    rerender(<FitName text="test-driven-development" testId="name" />)
    boxWidth = 200
    act(() => { for (const callback of resizeObservers) callback() })
    expect(screen.getByTestId('name')).toHaveTextContent(/^test-driven-development$/u)
    boxWidth = 130
    act(() => { for (const callback of resizeObservers) callback() })
    expect(screen.getByTestId('name')).toHaveTextContent(/^test…development$/u)
  })
})
