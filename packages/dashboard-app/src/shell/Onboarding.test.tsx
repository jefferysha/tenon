import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n'
import { Onboarding } from './Onboarding'

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderOb(over: Partial<Parameters<typeof Onboarding>[0]> = {}) {
  const props = { kind: 'no-project' as const, ...over }
  render(
    <I18nProvider>
      <Onboarding {...props} />
    </I18nProvider>,
  )
  return props
}

// Dashboard 自己能建项目（选已有目录或新建目录 + git init），所以零项目态只留一个动作：
// 旧的「回终端敲 tenon init / doctor」两步 checklist 与逐条复制按钮随之退役。
describe('Onboarding no-project（单一动作：新建项目）', () => {
  it('标题 + 一个新建项目按钮，不再有命令行教学与复制按钮', () => {
    renderOb()
    const card = screen.getByTestId('onboard-no-project')
    expect(screen.getByRole('heading', { level: 1, name: '还没有注册任何项目' })).toBeInTheDocument()
    expect(screen.getByTestId('onboard-new-project')).toHaveTextContent('新建项目')
    expect(screen.queryByTestId('onboard-cli')).toBeNull()
    expect(screen.queryByTestId('onboard-cmd-doctor')).toBeNull()
    expect(screen.queryByTestId('onboard-copy')).toBeNull()
    expect(screen.queryByTestId('onboard-copy-doctor')).toBeNull()
    expect(card).not.toHaveTextContent('tenon init')
    expect(card).not.toHaveTextContent('tenon doctor')
    expect(card.querySelector('ol')).toBeNull()
  })

  it('点新建项目回调一次；不发任何请求', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onNewProject = vi.fn()
    renderOb({ onNewProject })
    fireEvent.click(screen.getByTestId('onboard-new-project'))
    expect(onNewProject).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('没有回调时点击不抛错（App 之外的调用方可只读展示）', () => {
    renderOb()
    expect(() => fireEvent.click(screen.getByTestId('onboard-new-project'))).not.toThrow()
  })

  it('英文 locale 给出成对文案', () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    renderOb()
    expect(screen.getByTestId('onboard-new-project')).toHaveTextContent('New project')
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe('')
  })
})
