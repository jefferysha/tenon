import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CurrentUserState } from '../api/userClient'
import { I18nProvider } from '../i18n'
import { TopBar } from './TopBar'
import { UserDialog } from './UserDialog'

function renderBar(user: CurrentUserState | null, onUser = vi.fn()) {
  render(
    <I18nProvider>
      <TopBar
        view="progress" onView={() => undefined} projects={[]} currentRoot="" onRoot={() => undefined} connected
        lang="zh" onLang={() => undefined} theme="system" onTheme={() => undefined} decisionCount={0}
        user={user} onUser={onUser}
      />
    </I18nProvider>,
  )
  return onUser
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__TENON_DASHBOARD_TOKEN__
})

describe('top bar user', () => {
  it('shows the declared user name with the id as title and opens the dialog on click', async () => {
    const onUser = renderBar({ kind: 'set', user: { id: 'jeff@x.io', name: 'Jeff Sha', slug: 'jeff-at-x.io', source: 'git' } })
    const button = screen.getByTestId('top-bar-user')
    expect(button).toHaveTextContent('Jeff Sha')
    expect(button).toHaveAttribute('title', 'jeff@x.io')
    expect(button).toHaveAttribute('data-source', 'git')
    await userEvent.click(button)
    expect(onUser).toHaveBeenCalledTimes(1)
  })

  it('shows 未设置 when identity is missing and nothing while loading', () => {
    renderBar({ kind: 'missing', invalid: 'env' })
    expect(screen.getByTestId('top-bar-user-missing')).toHaveTextContent('未设置')
    expect(screen.queryByTestId('top-bar-user')).toBeNull()
  })

  it('renders no user control before the user is known', () => {
    renderBar(null)
    expect(screen.queryByTestId('top-bar-user')).toBeNull()
    expect(screen.queryByTestId('top-bar-user-missing')).toBeNull()
  })
})

describe('user dialog', () => {
  it('saving posts {id,name} to /api/user and reports the saved user', async () => {
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true, user: { id: 'jeff@x.io', name: 'Jeff Sha', slug: 'jeff-at-x.io', source: 'config', trust: 'declared' },
    }), { status: 200 }))
    const onSaved = vi.fn()
    render(<I18nProvider><UserDialog onClose={() => undefined} onSaved={onSaved} /></I18nProvider>)
    expect(screen.getByTestId('user-dialog-save')).toBeDisabled()
    await userEvent.type(screen.getByTestId('user-dialog-id'), 'jeff@x.io')
    await userEvent.type(screen.getByTestId('user-dialog-name'), 'Jeff Sha')
    await userEvent.click(screen.getByTestId('user-dialog-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      kind: 'set', user: { id: 'jeff@x.io', name: 'Jeff Sha', slug: 'jeff-at-x.io', source: 'config' },
    }))
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/user')
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'jeff@x.io', name: 'Jeff Sha' })
  })

  it('names its global scope and keeps 保存 disabled until a field actually changes', async () => {
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    render(<I18nProvider><UserDialog initial={{ id: 'jeff@x.io', name: 'Jeff', source: 'config' }} onClose={() => undefined} onSaved={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('user-dialog-scope')).toHaveTextContent('适用于本机所有项目')
    const save = screen.getByTestId('user-dialog-save')
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByTestId('user-dialog-name'), ' Sha')
    expect(save).toBeEnabled()
    await userEvent.clear(screen.getByTestId('user-dialog-name'))
    await userEvent.type(screen.getByTestId('user-dialog-name'), 'Jeff')
    expect(save).toBeDisabled()
  })

  it('allows saving an unedited git identity so it becomes the declared user.json', () => {
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    render(<I18nProvider><UserDialog initial={{ id: 'jeff@x.io', name: 'Jeff', source: 'git' }} onClose={() => undefined} onSaved={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('user-dialog-save')).toBeEnabled()
  })

  it('stays disabled without a token and shows an error when the server rejects the id', async () => {
    render(<I18nProvider><UserDialog onClose={() => undefined} onSaved={() => undefined} /></I18nProvider>)
    await userEvent.type(screen.getByTestId('user-dialog-id'), 'bad')
    expect(screen.getByTestId('user-dialog-save')).toBeDisabled()
  })

  it('shows user-dialog-error on a rejected save', async () => {
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, code: 'invalid-user', error: '用户邮箱非法: bad' }), { status: 400 }))
    const onSaved = vi.fn()
    render(<I18nProvider><UserDialog onClose={() => undefined} onSaved={onSaved} /></I18nProvider>)
    await userEvent.type(screen.getByTestId('user-dialog-id'), 'bad')
    await userEvent.click(screen.getByTestId('user-dialog-save'))
    expect(await screen.findByTestId('user-dialog-error')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })
})
