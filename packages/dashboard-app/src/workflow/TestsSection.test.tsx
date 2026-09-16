import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TestsSection } from './TestsSection'
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

describe('TestsSection', () => {
  it('+ 打开方向列表；选中方向抄成步骤测试项并打开抽屉', async () => {
    stubFetch()
    const onAdd = vi.fn()
    render(<I18nProvider><TestsSection tests={[]} editable onAdd={onAdd} onOpen={() => undefined} /></I18nProvider>)
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
    render(<I18nProvider><TestsSection tests={existing} editable onAdd={onAdd} onOpen={() => undefined} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('wb-tests-add'))
    await waitFor(() => expect(screen.getByTestId('wb-tests-direction-unit')).toBeTruthy())
    await userEvent.click(screen.getByTestId('wb-tests-direction-unit'))
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ id: 'unit-2', direction: 'unit' })
  })

  it('表格每行可点开；只读时没有新增入口', async () => {
    stubFetch()
    const onOpen = vi.fn()
    const tests: WbStepTest[] = [
      { id: 'unit', direction: 'unit', command: 'npm test', label: '单测', required: true },
      { id: 'bench', direction: 'benchmark', command: 'npm run bench', required: false },
    ]
    const view = render(<I18nProvider><TestsSection tests={tests} editable onAdd={() => undefined} onOpen={onOpen} /></I18nProvider>)
    await userEvent.click(screen.getByTestId('wb-test-bench'))
    expect(onOpen).toHaveBeenCalledWith('bench')
    expect(screen.getByTestId('wb-tests').textContent).toContain('npm run bench')
    view.unmount()

    render(<I18nProvider><TestsSection tests={tests} editable={false} onAdd={() => undefined} onOpen={onOpen} /></I18nProvider>)
    expect(screen.queryByTestId('wb-tests-add')).toBeNull()
  })
})
