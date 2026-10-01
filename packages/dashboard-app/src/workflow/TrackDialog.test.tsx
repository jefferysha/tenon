import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { TrackDialog } from './TrackDialog'

function Harness({ onSubmit = vi.fn(), onClose = vi.fn(), existing = ['frontend'] }: {
  onSubmit?: (id: string, label: string) => void
  onClose?: () => void
  existing?: readonly string[]
}): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <I18nProvider>
      <TooltipProvider>
        <TrackDialog open={open} existing={existing} onClose={() => { onClose(); setOpen(false) }} onSubmit={onSubmit} />
      </TooltipProvider>
    </I18nProvider>
  )
}

/** 新建轨道对话框走共享的 FormDialog（产品评估 P2：此前是裸 Dialog，没有二次确认、没有 Enter 提交、没有测试）。 */
describe('TrackDialog', () => {
  it('用共享外壳：整张表单、固定高度主体、打开即聚焦 id 输入框；没有合法 id 时不能提交', () => {
    render(<Harness />)
    expect(screen.getByTestId('track-dialog-form')).toBeInTheDocument()
    expect(screen.getByTestId('track-dialog-body').className).toContain('overflow-y-auto')
    expect(screen.getByTestId('track-dialog-id')).toHaveFocus()
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
  })

  it('id 非法 / 重复：错误贴在字段下方（alert），提交保持禁用；合法后可提交', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(screen.getByTestId('track-dialog-id'), 'Bad Id')
    expect(screen.getByRole('alert')).toHaveTextContent('小写字母开头')
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
    await user.clear(screen.getByTestId('track-dialog-id'))
    await user.type(screen.getByTestId('track-dialog-id'), 'frontend')
    expect(screen.getByRole('alert')).toHaveTextContent('轨道已存在')
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
    await user.clear(screen.getByTestId('track-dialog-id'))
    await user.type(screen.getByTestId('track-dialog-id'), 'mobile')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('track-dialog-submit')).toBeEnabled()
  })

  it('Enter 提交（id 与名称去空白）；名称可空', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await user.type(screen.getByTestId('track-dialog-id'), '{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.type(screen.getByTestId('track-dialog-id'), ' mobile ')
    await user.type(screen.getByTestId('track-dialog-label'), ' 移动端 {Enter}')
    expect(onSubmit).toHaveBeenCalledWith('mobile', '移动端')
  })

  it('没有输入时取消直接关闭；有输入时先二次确认，保留继续编辑、放弃才关闭', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { unmount } = render(<Harness onClose={onClose} />)
    await user.click(screen.getByTestId('track-dialog-cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    const again = vi.fn()
    render(<Harness onClose={again} />)
    await user.type(screen.getByTestId('track-dialog-id'), 'mob')
    await user.click(screen.getByTestId('track-dialog-cancel'))
    expect(screen.getByTestId('track-dialog-discard')).toBeInTheDocument()
    expect(again).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('track-dialog-discard-keep'))
    expect(screen.queryByTestId('track-dialog-discard')).toBeNull()
    expect(screen.getByTestId('track-dialog-id')).toHaveValue('mob')
    await user.click(screen.getByTestId('track-dialog-cancel'))
    await user.click(screen.getByTestId('track-dialog-discard-confirm'))
    expect(again).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('track-dialog')).toBeNull()
  })

  it('关掉再打开是一份干净的表单', async () => {
    const user = userEvent.setup()
    function Reopen(): JSX.Element {
      const [open, setOpen] = useState(true)
      return (
        <I18nProvider>
          <TooltipProvider>
            <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>open</button>
            <TrackDialog open={open} existing={[]} onClose={() => setOpen(false)} onSubmit={() => setOpen(false)} />
          </TooltipProvider>
        </I18nProvider>
      )
    }
    render(<Reopen />)
    await user.type(screen.getByTestId('track-dialog-id'), 'mobile{Enter}')
    expect(screen.queryByTestId('track-dialog')).toBeNull()
    await user.click(screen.getByTestId('reopen'))
    expect(screen.getByTestId('track-dialog-id')).toHaveValue('')
  })
})
