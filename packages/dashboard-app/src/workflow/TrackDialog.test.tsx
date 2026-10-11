import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { TrackDialog, type TrackDialogValue, type TrackDialogProps } from './TrackDialog'

function Harness({ onSubmit = vi.fn(), onClose = vi.fn(), existing = ['frontend'], ...rest }: {
  onSubmit?: (value: TrackDialogValue) => void
  onClose?: () => void
  existing?: readonly string[]
} & Partial<Pick<TrackDialogProps, 'defaultSpec' | 'editing'>>): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <I18nProvider>
      <TooltipProvider>
        <TrackDialog open={open} existing={existing} defaultSpec="openspec" onClose={() => { onClose(); setOpen(false) }} onSubmit={onSubmit} {...rest} />
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

  it('Enter 提交（id 与名称去空白）；名称可空；规范缺省继承来源分支、关键词缺省为空', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await user.type(screen.getByTestId('track-dialog-id'), '{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.type(screen.getByTestId('track-dialog-id'), ' mobile ')
    await user.type(screen.getByTestId('track-dialog-label'), ' 移动端 {Enter}')
    expect(onSubmit).toHaveBeenCalledWith({ id: 'mobile', label: '移动端', spec: 'openspec', keywords: [] })
  })

  it('规范：OpenSpec / 无 单选，缺省是来源分支的规范；改成「无」并填关键词后提交带 spec 与去重去空白的关键词', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    const group = screen.getByRole('radiogroup', { name: '规范' })
    expect(group).toBeInTheDocument()
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveTextContent('OpenSpec')
    expect(screen.getByTestId('track-dialog-spec-none')).toHaveTextContent('无')
    await user.click(screen.getByTestId('track-dialog-spec-none'))
    expect(screen.getByTestId('track-dialog-spec-none')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveAttribute('aria-checked', 'false')
    await user.type(screen.getByTestId('track-dialog-id'), 'quick')
    await user.type(screen.getByTestId('track-dialog-keywords'), '修复, typo，  typo ,文案,')
    await user.click(screen.getByTestId('track-dialog-submit'))
    expect(onSubmit).toHaveBeenCalledWith({ id: 'quick', label: '', spec: 'none', keywords: ['修复', 'typo', '文案'] })
  })

  it('规范分段控件与下面的输入框同宽：整行铺满，没有最大宽度把它的右边收在输入框之前', () => {
    render(<Harness />)
    const group = screen.getByTestId('track-dialog-spec')
    expect(group.className).toContain('w-full')
    expect(group.className).not.toMatch(/(?:^|\s)(?:max-w-|w-\[)/u)
    expect(screen.getByTestId('track-dialog-keywords').className).toContain('w-full')
  })

  it('规范可用键盘切换（方向键），缺省取 defaultSpec', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} defaultSpec="none" />)
    expect(screen.getByTestId('track-dialog-spec-none')).toHaveAttribute('aria-checked', 'true')
    screen.getByTestId('track-dialog-spec-none').focus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveAttribute('aria-checked', 'true')
  })

  it('关键词里有方括号 / 花括号，或超过 64 个：错误贴在字段下方，提交禁用', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(screen.getByTestId('track-dialog-id'), 'mobile')
    await user.click(screen.getByTestId('track-dialog-keywords'))
    await user.paste('fix, [bad]')
    expect(screen.getByRole('alert')).toHaveTextContent('关键词至多 64 个')
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
    await user.clear(screen.getByTestId('track-dialog-keywords'))
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByTestId('track-dialog-keywords'))
    await user.paste(Array.from({ length: 65 }, (_, index) => `k${index}`).join(','))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
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
            <TrackDialog open={open} existing={[]} defaultSpec="openspec" onClose={() => setOpen(false)} onSubmit={() => setOpen(false)} />
          </TooltipProvider>
        </I18nProvider>
      )
    }
    render(<Reopen />)
    await user.click(screen.getByTestId('track-dialog-spec-none'))
    await user.type(screen.getByTestId('track-dialog-keywords'), 'fix')
    await user.type(screen.getByTestId('track-dialog-id'), 'mobile{Enter}')
    expect(screen.queryByTestId('track-dialog')).toBeNull()
    await user.click(screen.getByTestId('reopen'))
    expect(screen.getByTestId('track-dialog-id')).toHaveValue('')
    expect(screen.getByTestId('track-dialog-keywords')).toHaveValue('')
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('TrackDialog · 轨道设置（改已有轨道）', () => {
  const EDITING = { id: 'backend', spec: 'openspec' as const, keywords: ['后端', 'api'] }

  it('只有规范与关键词：没有 id / 名称输入，预填现值；没改动时不能保存', async () => {
    render(<Harness editing={EDITING} />)
    expect(screen.getByRole('dialog', { name: '轨道设置' })).toBeInTheDocument()
    expect(screen.queryByTestId('track-dialog-id')).toBeNull()
    expect(screen.queryByTestId('track-dialog-label')).toBeNull()
    expect(screen.getByTestId('track-dialog-spec-openspec')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('track-dialog-keywords')).toHaveValue('后端, api')
    expect(screen.getByTestId('track-dialog-submit')).toBeDisabled()
  })

  it('改关键词与规范后保存：带着这条轨道的 id；清空关键词就是空数组', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness editing={EDITING} onSubmit={onSubmit} />)
    await user.click(screen.getByTestId('track-dialog-spec-none'))
    await user.clear(screen.getByTestId('track-dialog-keywords'))
    expect(screen.getByTestId('track-dialog-submit')).toBeEnabled()
    await user.click(screen.getByTestId('track-dialog-submit'))
    expect(onSubmit).toHaveBeenCalledWith({ id: 'backend', label: '', spec: 'none', keywords: [] })
  })

  it('没有 route 的轨道（keywords 缺省）打开是空输入；只填关键词也能保存', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness editing={{ id: 'free', spec: 'none', keywords: [] }} onSubmit={onSubmit} />)
    expect(screen.getByTestId('track-dialog-keywords')).toHaveValue('')
    await user.type(screen.getByTestId('track-dialog-keywords'), 'x{Enter}')
    expect(onSubmit).toHaveBeenCalledWith({ id: 'free', label: '', spec: 'none', keywords: ['x'] })
  })
})
