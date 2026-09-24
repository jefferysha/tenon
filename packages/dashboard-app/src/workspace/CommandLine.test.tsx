import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { makeProject, makeSnapshot } from '../testkit'
import { COPIED_MS, CommandLine } from './CommandLine'
import { WorkspaceView } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ROOT = '/Users/me/code/repo'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CommandLine（A10）', () => {
  it('单行、中性等宽块，不是绿底绿字', () => {
    render(<I18nProvider><CommandLine command="tenon init my-change --track chat" testId="cmd" /></I18nProvider>)
    const text = screen.getByTestId('cmd-text')
    expect(text.tagName).toBe('CODE')
    expect(text.className).toContain('whitespace-nowrap')
    expect(text.className).toContain('overflow-x-auto')
    expect(text.className).toContain('font-mono')
    expect(text.className).toContain('text-text')
    expect(screen.getByTestId('cmd').className).toContain('bg-(--code-bg)')
    expect(screen.getByTestId('cmd').className).not.toContain('accent')
    expect(text.className).not.toContain('accent')
  })

  it('复制按钮写入剪贴板，变勾 1.2s 后复原', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<I18nProvider><CommandLine command="tenon init x" testId="cmd" /></I18nProvider>)
    const button = screen.getByTestId('cmd-copy')
    expect(button).toHaveAttribute('aria-label', '复制命令')
    expect(button.className).toContain('size-8')
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledWith('tenon init x')
    expect(button).toHaveAttribute('data-copied', 'true')
    expect(button).toHaveAttribute('aria-label', '已复制')
    act(() => { vi.advanceTimersByTime(COPIED_MS - 1) })
    expect(button).toHaveAttribute('data-copied', 'true')
    act(() => { vi.advanceTimersByTime(1) })
    expect(button).toHaveAttribute('data-copied', 'false')
    expect(COPIED_MS).toBe(1200)
  })

  it('任务列表空态：命令单行可复制，没有虚线框', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 }))
    render(
      <I18nProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject(ROOT, [])])}
          currentRoot={ROOT}
          rulesByKey={new Map()}
          projects={[{ root: ROOT, name: 'repo', count: 0, ok: true }]}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
        />
      </I18nProvider>,
    )
    const empty = screen.getByTestId('task-list-empty-no-task')
    expect(empty.className).not.toContain('border-dashed')
    expect(screen.getByTestId('task-list-empty-command-text')).toHaveTextContent('tenon init my-change --track chat')
    expect(screen.getByTestId('task-list-empty-command-text').className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('task-list-empty-command-copy')).toBeInTheDocument()
  })
})
