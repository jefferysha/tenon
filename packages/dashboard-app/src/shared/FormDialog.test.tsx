import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FormDialog, FormField } from './FormDialog'

function Form({ onSubmit = vi.fn(), onClose = vi.fn(), busy = false }: { onSubmit?: () => void; onClose?: () => void; busy?: boolean }): JSX.Element {
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const error = name.includes(' ') ? '不能有空格' : null
  return (
    <FormDialog
      title="新建"
      testid="demo"
      dirty={name !== '' || notes !== ''}
      busy={busy}
      canSubmit={name !== '' && error === null}
      submitLabel="创建"
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <FormField label="名称" htmlFor="demo-name" hint="只能用小写字母" error={error} testid="demo-name-field">
        <input id="demo-name" value={name} aria-describedby={error === null ? undefined : 'demo-name-error'} onChange={(event) => setName(event.target.value)} />
      </FormField>
      <FormField label="备注" htmlFor="demo-notes">
        <textarea id="demo-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </FormField>
    </FormDialog>
  )
}

function renderForm(props: Parameters<typeof Form>[0] = {}): void {
  render(<I18nProvider><TooltipProvider><Form {...props} /></TooltipProvider></I18nProvider>)
}

describe('FormDialog：新建类对话框的统一行为', () => {
  it('主体固定高度并内部滚动；取消 / 提交按钮在表单内；打开即聚焦第一个输入控件（不是说明图标）', () => {
    renderForm()
    expect(screen.getByLabelText('名称')).toHaveFocus()
    const body = screen.getByTestId('demo-body')
    expect(body.className).toContain('h-[360px]')
    expect(body.className).toContain('overflow-y-auto')
    expect(screen.getByTestId('demo-submit')).toHaveAttribute('type', 'submit')
    expect(screen.getByTestId('demo-submit')).toBeDisabled()
  })

  it('文本框里 Enter 提交；不满足条件时 Enter 不提交；textarea 里 Enter 是换行', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderForm({ onSubmit })
    await user.type(screen.getByLabelText('名称'), '{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('名称'), 'shop{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await user.type(screen.getByLabelText('备注'), 'a{Enter}b')
    expect(screen.getByLabelText('备注')).toHaveValue('a\nb')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('字段下方即时显示校验错误，控件经 aria-describedby 指向它', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('名称'), 'a b')
    const error = screen.getByTestId('demo-name-field-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveAttribute('id', 'demo-name-error')
    expect(error).toHaveTextContent('不能有空格')
    expect(error.className).toContain('whitespace-nowrap')
    expect(screen.getByLabelText('名称')).toHaveAttribute('aria-describedby', 'demo-name-error')
    expect(screen.getByTestId('demo-submit')).toBeDisabled()
  })

  it('说明在标签旁的 Tooltip 图标里，页面上不写句子', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(screen.queryByText('只能用小写字母')).toBeNull()
    await user.hover(screen.getByRole('button', { name: '名称 说明' }))
    expect((await screen.findAllByText('只能用小写字母')).length).toBeGreaterThan(0)
  })

  it('没有输入：Esc 直接关闭', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderForm({ onClose })
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('有输入：Esc / 取消先确认；继续编辑留下，放弃才关闭', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderForm({ onClose })
    await user.type(screen.getByLabelText('名称'), 'x')
    await user.keyboard('{Escape}')
    expect(await screen.findByTestId('demo-discard')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog', { name: '放弃未提交的输入？' })).toBeInTheDocument()
    await user.click(screen.getByTestId('demo-discard-keep'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('demo-discard')).toBeNull()
    await user.click(screen.getByTestId('demo-cancel'))
    await user.click(await screen.findByTestId('demo-discard-confirm'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('提交进行中：不能关闭也不能再次提交', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderForm({ onClose, busy: true })
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('demo-cancel')).toBeDisabled()
    expect(screen.getByTestId('demo-submit')).toBeDisabled()
  })
})
