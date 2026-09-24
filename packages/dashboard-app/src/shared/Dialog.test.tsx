import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { Dialog, DialogInteractionBoundary } from './Dialog'

describe('Dialog', () => {
  it.each(['default', 'workspace'] as const)('%s variant: raised shadow surface without a border, entering with fade + scale + rise', (variant) => {
    render(
      <I18nProvider>
        <Dialog onClose={vi.fn()} title="Motion" testid="motion-dialog" variant={variant}>
          <button type="button">Inside</button>
        </Dialog>
      </I18nProvider>,
    )
    const overlay = screen.getByTestId('motion-dialog')
    const content = screen.getByRole('dialog')
    expect(overlay).toHaveAttribute('data-state', 'open')
    for (const name of ['bg-scrim', 'backdrop-blur-[2px]', 'data-[state=open]:animate-in', 'data-[state=open]:fade-in-0', 'data-[state=open]:duration-(--dur-base)']) {
      expect(overlay).toHaveClass(name)
    }
    for (const name of ['rounded-lg', 'shadow-(--shadow-3)', 'data-[state=open]:animate-in', 'data-[state=open]:fade-in-0', 'data-[state=open]:zoom-in-[.97]', 'data-[state=open]:slide-in-from-bottom-2', 'data-[state=open]:duration-(--dur-panel)', 'data-[state=open]:ease-(--ease-out)', 'data-[state=closed]:duration-(--dur-exit)']) {
      expect(content).toHaveClass(name)
    }
    expect(content.className.split(/\s+/u)).not.toContain('border')
    if (variant === 'default') expect(content).toHaveClass('bg-surface-raised')
    expect(screen.getByRole('heading', { name: 'Motion' })).toHaveClass('font-semibold')
  })

  it('a kept-mounted dialog closes through Radix presence when open turns false', () => {
    const onClose = vi.fn()
    const view = (open: boolean): JSX.Element => (
      <I18nProvider>
        <Dialog open={open} onClose={onClose} title="Presence" testid="presence-dialog">
          <button type="button">Inside</button>
        </Dialog>
      </I18nProvider>
    )
    const { rerender } = render(view(true))
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open')
    rerender(view(false))
    // jsdom 没有 CSS 动画，Presence 直接卸载；浏览器里先播 120ms 退场。
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the workspace close control inert when close is disabled', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <I18nProvider>
        <Dialog
          closeDisabled
          closeLabel="Close workspace"
          onClose={onClose}
          title="Workspace"
          variant="workspace"
        >
          Content
        </Dialog>
      </I18nProvider>,
    )

    const close = screen.getByRole('button', { name: 'Close workspace' })
    expect(close).toBeDisabled()
    await user.click(close)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('allows an authorized portal submit and blocks the same action after its interaction boundary loses authority', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const renderDialog = (disabled: boolean): JSX.Element => (
      <I18nProvider>
        <DialogInteractionBoundary disabled={disabled}>
          <Dialog onClose={vi.fn()} title="Track settings" testid="track-settings-dialog">
            <form onSubmit={onSubmit}>
              <button type="submit">Save track</button>
            </form>
          </Dialog>
        </DialogInteractionBoundary>
      </I18nProvider>
    )
    const { rerender } = render(renderDialog(false))

    fireEvent.click(screen.getByRole('button', { name: 'Save track' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)

    rerender(renderDialog(true))
    const overlay = screen.getByTestId('track-settings-dialog')
    expect(overlay).toHaveAttribute('inert')
    expect(overlay).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Save track', hidden: true }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('restores focus inside a still-open portal dialog when authority returns after the outer guard closes', () => {
    const renderDialogs = (disabled: boolean, showGuard: boolean): JSX.Element => (
      <I18nProvider>
        <DialogInteractionBoundary disabled={disabled}>
          <Dialog onClose={vi.fn()} title="Track settings" testid="track-settings-dialog">
            <button type="button">Save track</button>
          </Dialog>
        </DialogInteractionBoundary>
        {showGuard && (
          <Dialog onClose={vi.fn()} title="Unsaved changes" testid="unsaved-guard-dialog">
            <button type="button">Keep editing</button>
          </Dialog>
        )}
      </I18nProvider>
    )
    const { rerender } = render(renderDialogs(false, false))
    const save = screen.getByRole('button', { name: 'Save track' })
    expect(save).toHaveFocus()

    rerender(renderDialogs(true, true))
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus()
    expect(screen.getByTestId('track-settings-dialog')).toHaveAttribute('inert')

    rerender(renderDialogs(true, false))
    expect(document.body).toHaveFocus()

    rerender(renderDialogs(false, false))
    expect(save).toHaveFocus()

    rerender(renderDialogs(true, true))
    const keepEditing = screen.getByRole('button', { name: 'Keep editing' })
    expect(keepEditing).toHaveFocus()

    rerender(renderDialogs(false, true))
    expect(keepEditing).toHaveFocus()

    rerender(renderDialogs(false, false))
    expect(save).toHaveFocus()
  })
})
