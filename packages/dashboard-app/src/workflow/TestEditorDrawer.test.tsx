import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TestEditorDrawer } from './TestEditorDrawer'
import type { WbStepTest } from '../api/governanceTypes'

const TEST: WbStepTest = {
  id: 'unit', direction: 'unit', command: 'npm test', label: '单测', timeout_s: 900, required: true,
  outputs: [{ path: 'test-results/junit.xml', kind: 'report', required: true }],
}

function open(test: WbStepTest | null, handlers: {
  onApply?: (next: WbStepTest) => void
  onDelete?: (id: string) => void
  onClose?: () => void
  editable?: boolean
} = {}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <TestEditorDrawer
          test={test}
          editable={handlers.editable ?? true}
          onApply={handlers.onApply ?? (() => undefined)}
          onDelete={handlers.onDelete ?? (() => undefined)}
          onClose={handlers.onClose ?? (() => undefined)}
        />
      </TooltipProvider>
    </I18nProvider>,
  )
}

describe('TestEditorDrawer', () => {
  it('改动即时交回整份测试项（没有「应用」）；类型只读', () => {
    const onApply = vi.fn()
    open(TEST, { onApply })
    expect(screen.queryByTestId('wb-test-apply')).toBeNull()
    expect(screen.getByTestId('wb-test-direction').textContent).toBe('unit')
    fireEvent.change(screen.getByTestId('wb-test-command'), { target: { value: 'npm run unit' } })
    expect(onApply).toHaveBeenLastCalledWith({ ...TEST, command: 'npm run unit' })
  })

  it('「方向」改叫「类型」；每个字段的说明在问号 Tooltip 里，页面上不写句子', () => {
    open(TEST)
    const drawer = screen.getByTestId('test-editor-drawer')
    expect(drawer).toHaveTextContent('类型')
    expect(drawer).not.toHaveTextContent('方向')
    expect(within(drawer).getByRole('button', { name: '在目录下执行的命令' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: '失败时挡住阶段出口' })).toBeInTheDocument()
    expect(drawer).not.toHaveTextContent('在目录下执行的命令')
  })

  it('「必需」只出现一次：产物行只有勾选框，名称在 aria-label / Tooltip', () => {
    open(TEST)
    const drawer = screen.getByTestId('test-editor-drawer')
    expect(drawer.textContent?.match(/必需/g)).toHaveLength(1)
    expect(screen.getByTestId('wb-test-output-required-0')).toHaveAttribute('aria-label', '必须生成')
  })

  it('删除要二次确认', async () => {
    const onDelete = vi.fn()
    open(TEST, { onDelete })
    await userEvent.click(screen.getByTestId('wb-test-delete'))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('wb-test-delete-confirm'))
    expect(onDelete).toHaveBeenCalledWith('unit')
  })

  it('输入输出可增删；没有测试时不渲染；只读时没有写入口', async () => {
    const onApply = vi.fn()
    const view = open(TEST, { onApply })
    await userEvent.click(screen.getByTestId('wb-test-output-add'))
    expect((onApply.mock.lastCall?.[0] as WbStepTest).outputs).toHaveLength(2)
    await userEvent.click(screen.getByTestId('wb-test-input-add'))
    expect((onApply.mock.lastCall?.[0] as WbStepTest).inputs).toEqual([{ kind: 'file', path: '' }])
    view.unmount()

    const empty = open(null)
    expect(empty.container.textContent).toBe('')
    empty.unmount()

    open(TEST, { editable: false })
    expect(screen.queryByTestId('wb-test-delete')).toBeNull()
    expect(screen.getByTestId('wb-test-command')).toBeDisabled()
  })
})
