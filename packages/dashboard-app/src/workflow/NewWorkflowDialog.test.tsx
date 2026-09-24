import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { CreateState } from '../workbench/useWorkflowEditor'
import { NewWorkflowDialog } from './NewWorkflowDialog'

function createState(over: Partial<CreateState> = {}): CreateState {
  return {
    open: true, mode: 'blank', setMode: vi.fn(), name: '', setName: vi.fn(), yaml: '', setYaml: vi.fn(),
    openspec: false, setOpenspec: vi.fn(), nameInvalid: false, nameDuplicate: false, errors: [], busy: false,
    canSubmit: false, nameRef: createRef<HTMLInputElement>(), openCreate: vi.fn(), close: vi.fn(), submit: vi.fn(async () => undefined),
    ...over,
  }
}

// Radix Switch 用 ResizeObserver 量滑块尺寸；jsdom 没有它。
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
})

describe('NewWorkflowDialog OpenSpec 开关', () => {
  // 旧的手写开关滑块 absolute 却没有 left，被画到胶囊外并盖住标签首字母；改用共享 Switch。
  it('是带可访问名称的共享 Switch，标签与开关分开渲染', async () => {
    const create = createState()
    render(<I18nProvider><NewWorkflowDialog create={create} currentName="default" /></I18nProvider>)
    const toggle = screen.getByRole('switch', { name: 'OpenSpec' })
    expect(toggle).toHaveAttribute('data-slot', 'switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle.textContent).toBe('')
    await userEvent.click(toggle)
    expect(create.setOpenspec).toHaveBeenCalledWith(true)
    await userEvent.click(screen.getByText('OpenSpec'))
    expect(create.setOpenspec).toHaveBeenCalledTimes(2)
  })

  // 真机：「复制 design-system」折成两行，违背不换行；改为单行截断，全名放 title。
  it('模式按钮单行不换行，长名称截断并带全名', () => {
    render(<I18nProvider><NewWorkflowDialog create={createState()} currentName="design-system" /></I18nProvider>)
    const copy = screen.getByTestId('wb-new-template-copy')
    expect(copy.className).toContain('whitespace-nowrap')
    const label = copy.querySelector('span')
    expect(label?.className).toContain('truncate')
    expect(label?.getAttribute('title')).toContain('design-system')
  })

  it('导入模式不显示开关', () => {
    render(<I18nProvider><NewWorkflowDialog create={createState({ mode: 'import' })} currentName="default" /></I18nProvider>)
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
