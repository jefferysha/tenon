import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TestAddMenu } from './TestAddMenu'
import type { WbStepTest } from '../api/governanceTypes'

const DIRECTIONS = {
  ok: true,
  directions: [
    {
      id: 'unit', label: '单测', source: 'builtin', yaml: 'id: unit\n',
      definition: { id: 'unit', label: '单测', command: 'npm test', timeout_s: 900 },
    },
    {
      id: 'playwright', label: 'Playwright', source: 'builtin', yaml: 'id: playwright\n',
      definition: { id: 'playwright', label: 'Playwright', command: 'npx playwright test', timeout_s: 1800 },
    },
  ],
}

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(DIRECTIONS), { status: 200 }))
}

afterEach(() => vi.restoreAllMocks())

describe('TestAddMenu', () => {
  it('+ 打开类型列表；选中类型抄成步骤测试项', async () => {
    stubFetch()
    const onAdd = vi.fn()
    render(<I18nProvider><TestAddMenu tests={[]} onAdd={onAdd} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('wb-tests-add'))
    await waitFor(() => expect(screen.getByTestId('wb-tests-direction-unit')).toBeTruthy())
    await userEvent.click(screen.getByTestId('wb-tests-direction-unit'))
    expect(onAdd).toHaveBeenCalledWith({
      id: 'unit', direction: 'unit', label: '单测', command: 'npm test', timeout_s: 900, required: true,
    })
  })

  it('id 冲突时抄成 -2', async () => {
    stubFetch()
    const onAdd = vi.fn()
    const existing: WbStepTest[] = [{ id: 'unit', direction: 'unit', command: 'npm test' }]
    render(<I18nProvider><TestAddMenu tests={existing} onAdd={onAdd} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('wb-tests-add'))
    await waitFor(() => expect(screen.getByTestId('wb-tests-direction-unit')).toBeTruthy())
    await userEvent.click(screen.getByTestId('wb-tests-direction-unit'))
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ id: 'unit-2', direction: 'unit' })
  })

  it('菜单只显示名称，挂在 body 的 Portal 上（不被画布层叠盖住）', async () => {
    stubFetch()
    const { container } = render(<I18nProvider><TestAddMenu tests={[]} onAdd={vi.fn()} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('wb-tests-add'))
    const option = await screen.findByTestId('wb-tests-direction-unit')
    expect(option.textContent).toBe('单测')
    const picker = screen.getByTestId('wb-tests-picker')
    expect(container.contains(picker)).toBe(false)
    expect(picker.className).toContain('z-50')
  })

  it('读不到类型时菜单里说明为空', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 500 }))
    render(<I18nProvider><TestAddMenu tests={[]} onAdd={vi.fn()} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('wb-tests-add'))
    expect(await screen.findByRole('status')).toBeTruthy()
  })
})
