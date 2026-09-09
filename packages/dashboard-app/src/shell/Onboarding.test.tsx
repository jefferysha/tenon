import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n'
import { Onboarding } from './Onboarding'

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
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

// full-install W2（旅程 P0 断点）：no-project 从单命令教学升级为「诚实两步 checklist」——起步
// 去终端（决议#7 不加注册 UI），两条真命令（tenon init / doctor）逐条可复制。Dashboard 本身
// 已是 setup 的结果，因此不再给无宿主参数的 setup 命令；「自动登记项目」事实并入 step_init 文案。
describe('Onboarding no-project（自动发现 + 终端初始化 checklist）', () => {
  it('渲染标题 + 诚实框架，不再要求用户输入本机绝对路径', () => {
    renderOb()
    const card = screen.getByTestId('onboard-no-project')
    expect(screen.getByRole('heading', { level: 1, name: '还没有注册任何项目' })).toBeInTheDocument()
    expect(card).toBeInTheDocument()
    expect(card.textContent).toContain('终端')
    expect(screen.queryByTestId('project-register-form')).toBeNull()
    expect(screen.queryByTestId('project-register-path')).toBeNull()
    expect(screen.queryByTestId('project-register-submit')).toBeNull()
    expect(card).toHaveTextContent('自动出现在这里')
    expect(card).not.toHaveTextContent('注册现有目录')
    expect(card).not.toHaveTextContent('⧉')
    expect(card.querySelector('svg')).not.toBeNull()
  })

  it('两步可执行 checklist：只给 init / doctor，不猜宿主并重复 setup', () => {
    renderOb()
    // 命令文本（可复制的字面终端命令，非 i18n）
    expect(screen.getByTestId('onboard-cli').textContent).toContain('tenon init')
    expect(screen.getByTestId('onboard-cmd-doctor').textContent).toBe('tenon doctor')
    // 每条都有独立复制钮
    expect(screen.getByTestId('onboard-copy')).toBeInTheDocument()
    expect(screen.getByTestId('onboard-copy-doctor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制命令：tenon init my-change --track chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制命令：tenon doctor' })).toBeInTheDocument()
    expect(screen.queryByTestId('onboard-cmd-setup')).toBeNull()
    expect(screen.getByTestId('onboard-no-project')).not.toHaveTextContent('tenon setup')
  })

  it('只在 1024px 起启用宽卡与步骤卡视觉，保留既有小屏契约', () => {
    renderOb()
    const card = screen.getByTestId('onboard-no-project')
    const steps = card.querySelectorAll('ol > li')

    expect(card).toHaveClass('max-w-[620px]', 'min-[1024px]:max-w-[920px]')
    expect(steps).toHaveLength(2)
    for (const step of steps) {
      expect(step).toHaveClass(
        'flex',
        'gap-3',
        'min-[1024px]:rounded-md',
        'min-[1024px]:border',
        'min-[1024px]:bg-fill/55',
        'min-[1024px]:p-3.5',
      )
    }
  })

  it('每条命令逐个可复制：clipboard 写入对应命令 + 文案切「已复制」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderOb()
    fireEvent.click(screen.getByTestId('onboard-copy'))
    await waitFor(() => expect(screen.getByTestId('onboard-copy').textContent).toContain('已复制'))
    expect(screen.getByTestId('onboard-copy')).not.toHaveTextContent('✓')
    expect(screen.getByTestId('onboard-copy').querySelector('svg')).not.toBeNull()
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('tenon init'))
    fireEvent.click(screen.getByTestId('onboard-copy-doctor'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('tenon doctor'))
  })

  it('复制进行中禁用当前行，并保持另一条命令可操作', async () => {
    let resolveWrite: (() => void) | undefined
    const copyText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        }),
    )
    renderOb({ copyText })

    const initCopy = screen.getByTestId('onboard-copy')
    const doctorCopy = screen.getByTestId('onboard-copy-doctor')
    fireEvent.click(initCopy)

    expect(initCopy).toHaveAttribute('aria-disabled', 'true')
    expect(initCopy).toHaveTextContent('复制中')
    expect(doctorCopy).toHaveAttribute('aria-disabled', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('正在复制命令')
    fireEvent.click(initCopy)
    await act(async () => {
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveWrite?.()
      await Promise.resolve()
    })
    expect(initCopy).toHaveAttribute('aria-disabled', 'false')
    expect(initCopy).toHaveTextContent('已复制')
  })

  it('Clipboard API 缺失时显示可恢复错误并保留命令', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    renderOb()

    const copy = screen.getByTestId('onboard-copy')
    copy.focus()
    fireEvent.click(copy)

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('未能复制，请手动选择上方命令')
    expect(copy).toHaveTextContent('重试复制')
    expect(screen.getByTestId('onboard-cli')).toHaveTextContent('tenon init my-change --track chat')
    expect(copy).toHaveFocus()
  })

  it.each([
    ['同步抛错', () => {
      throw new Error('clipboard blocked')
    }],
    ['异步拒绝', () => Promise.reject(new Error('clipboard denied'))],
  ])('%s统一进入错误状态且没有未处理 rejection', async (_label, copyText) => {
    renderOb({ copyText })
    fireEvent.click(screen.getByTestId('onboard-copy'))
    expect(await screen.findByRole('status')).toHaveTextContent('未能复制，请手动选择上方命令')
  })

  it('英文 locale 提供成对的 pending 与失败恢复文案', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const copyText = vi.fn().mockRejectedValue(new Error('denied'))
    renderOb({ copyText })

    const copy = screen.getByTestId('onboard-copy')
    fireEvent.click(copy)
    expect(copy).toHaveTextContent('Copying')
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Could not copy. Select the command above to copy it manually.',
    )
    expect(copy).toHaveTextContent('Retry copy')
  })

  it('成功与错误按各自时序回到 idle', async () => {
    vi.useFakeTimers()
    const copyText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'))
    renderOb({ copyText })
    const copy = screen.getByTestId('onboard-copy')

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })
    expect(copy).toHaveTextContent('已复制')
    act(() => vi.advanceTimersByTime(1999))
    expect(copy).toHaveTextContent('已复制')
    act(() => vi.advanceTimersByTime(1))
    expect(copy).toHaveTextContent('复制')

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(copy).toHaveTextContent('重试复制')
    act(() => vi.advanceTimersByTime(3999))
    expect(copy).toHaveTextContent('重试复制')
    act(() => vi.advanceTimersByTime(1))
    expect(copy).toHaveTextContent('复制')
  })

  it('重复复制以最后一次为准，并在命令行卸载时清理反馈 timer', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const result = render(
      <I18nProvider>
        <Onboarding kind="no-project" copyText={vi.fn().mockResolvedValue(undefined)} />
      </I18nProvider>,
    )
    const copy = screen.getByTestId('onboard-copy')

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })
    act(() => vi.advanceTimersByTime(1000))
    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })
    act(() => vi.advanceTimersByTime(1001))
    expect(copy).toHaveTextContent('已复制')

    result.unmount()
    expect(clearTimeoutSpy).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('剪贴板写入在命令行卸载后才完成时，不再创建反馈 timer', async () => {
    vi.useFakeTimers()
    let resolveWrite: (() => void) | undefined
    const copyText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        }),
    )
    const result = render(
      <I18nProvider>
        <Onboarding kind="no-project" copyText={copyText} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByTestId('onboard-copy'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(resolveWrite).toBeTypeOf('function')
    result.unmount()
    await act(async () => {
      resolveWrite?.()
      await Promise.resolve()
    })

    expect(vi.getTimerCount()).toBe(0)
  })

  it('项目来源只给自动登记的真实 init 路径，不再发送 POST /api/projects', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderOb()
    expect(screen.getByTestId('onboard-cli')).toHaveTextContent('tenon init')
    expect(screen.getByTestId('onboard-no-project')).not.toHaveTextContent('projects add')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

