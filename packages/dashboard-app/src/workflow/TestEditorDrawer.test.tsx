import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
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
      <TestEditorDrawer
        test={test}
        editable={handlers.editable ?? true}
        onApply={handlers.onApply ?? (() => undefined)}
        onDelete={handlers.onDelete ?? (() => undefined)}
        onClose={handlers.onClose ?? (() => undefined)}
      />
    </I18nProvider>,
  )
}

describe('TestEditorDrawer', () => {
  it('改命令后「应用」把整份改动交回；方向只读', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    open(TEST, { onApply, onClose })
    expect(screen.getByTestId('wb-test-direction').textContent).toBe('unit')
    await userEvent.clear(screen.getByTestId('wb-test-command'))
    await userEvent.type(screen.getByTestId('wb-test-command'), 'npm run unit')
    await userEvent.click(screen.getByTestId('wb-test-apply'))
    expect(onApply).toHaveBeenCalledWith({ ...TEST, command: 'npm run unit' })
    expect(onClose).toHaveBeenCalled()
  })

  it('不点应用直接关闭不写回；删除要二次确认', async () => {
    const onApply = vi.fn()
    const onDelete = vi.fn()
    open(TEST, { onApply, onDelete })
    await userEvent.clear(screen.getByTestId('wb-test-command'))
    await userEvent.type(screen.getByTestId('wb-test-command'), 'rm -rf /')
    expect(onApply).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('wb-test-delete'))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('wb-test-delete-confirm'))
    expect(onDelete).toHaveBeenCalledWith('unit')
  })

  it('输入输出可增删；没有测试时不渲染；只读时没有写入口', async () => {
    const onApply = vi.fn()
    const view = open(TEST, { onApply })
    await userEvent.click(screen.getByTestId('wb-test-output-add'))
    await userEvent.click(screen.getByTestId('wb-test-input-add'))
    await userEvent.click(screen.getByTestId('wb-test-apply'))
    const applied = onApply.mock.calls[0]?.[0] as WbStepTest
    expect(applied.outputs).toHaveLength(2)
    expect(applied.inputs).toEqual([{ kind: 'file', path: '' }])
    view.unmount()

    const empty = open(null)
    expect(empty.container.textContent).toBe('')
    empty.unmount()

    open(TEST, { editable: false })
    expect(screen.queryByTestId('wb-test-apply')).toBeNull()
    expect(screen.getByTestId('wb-test-command')).toBeDisabled()
  })
})
