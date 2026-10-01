import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WbStepTest, WbStepTestPolicy } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { TestPolicyForm } from './TestPolicyForm'

const FULL: WbStepTestPolicy = {
  plan: 'required',
  kinds: ['unit', 'playwright'],
  run: ['unit'],
  run_if_registered: ['benchmark'],
  scope: 'full',
  files: 'registered',
  scenarios: 'required',
  coverage: { lines: 80, branches: 70, functions: 60 },
  flaky: { max: 2, fail_on_new: true },
  benchmark: { require_baseline: true },
  browsers: ['chromium'],
}

const LEGACY: WbStepTest[] = [
  { id: 'unit', direction: 'unit', command: 'npm test', label: '单测', required: true },
  { id: 'odd', direction: 'my dir', command: 'run odd' },
]

function Harness({ initial, legacy = [], editable = true, spy }: {
  initial: WbStepTestPolicy | undefined
  legacy?: WbStepTest[]
  editable?: boolean
  spy: (next: WbStepTestPolicy | undefined) => void
}): JSX.Element {
  const [policy, setPolicy] = useState(initial)
  return (
    <TestPolicyForm
      stepId="verify"
      policy={policy}
      legacyTests={legacy}
      editable={editable}
      onChange={(next) => { spy(next); setPolicy(next) }}
    />
  )
}

function mount(initial: WbStepTestPolicy | undefined, extra: { legacy?: WbStepTest[]; editable?: boolean } = {}) {
  const spy = vi.fn<(next: WbStepTestPolicy | undefined) => void>()
  render(<I18nProvider><TooltipProvider><Harness initial={initial} spy={spy} {...extra} /></TooltipProvider></I18nProvider>)
  return spy
}

function last(spy: ReturnType<typeof mount>): WbStepTestPolicy | undefined {
  return spy.mock.calls.at(-1)?.[0]
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('TestPolicyForm · 展示', () => {
  it('完整策略：每个字段显示当前值，子块头一行（测试 · 计数）', () => {
    mount(FULL)
    const head = screen.getByRole('heading', { level: 3 })
    expect(head.textContent).toBe('测试2')
    expect(head.parentElement?.className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('wb-policy-kinds').textContent).toBe('单测 · Playwright')
    expect(screen.getByTestId('wb-policy-run').textContent).toBe('单测')
    expect(screen.getByTestId('wb-policy-scope-full')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-policy-scope-changed')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('wb-policy-coverage-lines')).toHaveValue('80')
    expect(screen.getByTestId('wb-policy-coverage-branches')).toHaveValue('70')
    expect(screen.getByTestId('wb-policy-coverage-changed_lines')).toHaveValue('')
    expect(screen.getByTestId('wb-policy-flaky')).toHaveValue('2')
    expect(screen.getByTestId('wb-policy-baseline')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-policy-scenarios-required')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByText('%')).toHaveLength(3)
  })

  it('缺省值：范围全量、场景不要求、基线关；种类空显示破折号', () => {
    mount({ plan: 'required' })
    expect(screen.getByTestId('wb-policy-scope-full')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-policy-scenarios-off')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-policy-baseline')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('wb-policy-kinds').textContent).toBe('—')
    expect(screen.queryByTestId('wb-policy-count')).toBeTruthy()
    expect(screen.getByTestId('wb-policy-count').textContent).toBe('0')
  })

  it('页面上没有说明句子：字段说明全在 Tooltip，键盘聚焦说明按钮即可读到', async () => {
    mount(FULL)
    const text = screen.getByTestId('stage-tests').textContent ?? ''
    expect(text).not.toContain('。')
    expect(text).not.toContain('计划里必须有')
    screen.getByTestId('wb-policy-kinds-row-hint').focus()
    expect((await screen.findAllByText('计划里必须有这些种类的套件，或已批准的豁免')).length).toBeGreaterThan(0)
    screen.getByTestId('wb-policy-baseline-row-hint').focus()
    expect((await screen.findAllByText('基准套件在本机器画像下没有基线时也拦下；关闭时只提示')).length).toBeGreaterThan(0)
  })

  it('标签与控件不折行', () => {
    mount(FULL)
    for (const row of ['kinds', 'run', 'scope', 'coverage', 'flaky', 'baseline', 'scenarios']) {
      const element = screen.getByTestId(`wb-policy-${row}-row`)
      expect(element.firstElementChild?.className).toContain('whitespace-nowrap')
      expect(element.lastElementChild?.className).toContain('flex-nowrap')
    }
    expect(screen.getByTestId('wb-policy-kinds').querySelector('span')?.className).toContain('truncate')
  })
})

describe('TestPolicyForm · 编辑', () => {
  it('种类多选：勾选追加、取消移除、清空后删键；勾选不关菜单', async () => {
    const spy = mount({ plan: 'required', kinds: ['unit'] })
    await userEvent.click(screen.getByTestId('wb-policy-kinds'))
    const menu = await screen.findByTestId('wb-policy-kinds-menu')
    await userEvent.click(within(menu).getByTestId('wb-policy-kinds-option-integration'))
    expect(last(spy)).toEqual({ plan: 'required', kinds: ['unit', 'integration'] })
    expect(screen.getByTestId('wb-policy-kinds-menu')).toBeInTheDocument()
    await userEvent.click(within(menu).getByTestId('wb-policy-kinds-option-unit'))
    expect(last(spy)).toEqual({ plan: 'required', kinds: ['integration'] })
    await userEvent.click(within(menu).getByTestId('wb-policy-kinds-option-integration'))
    expect(last(spy)).toEqual({ plan: 'required' })
    expect(within(menu).getAllByRole('menuitemcheckbox')).toHaveLength(17)
  })

  it('种类多选键盘可达：聚焦触发钮 → 回车打开 → 方向键与回车勾选', async () => {
    const spy = mount({ plan: 'required' })
    screen.getByTestId('wb-policy-run').focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByTestId('wb-policy-run-menu')
    // 键盘打开后焦点落在第一项（unit），向下一格是 integration。
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(last(spy)).toEqual({ plan: 'required', run: ['integration'] })
  })

  it('必跑与登记是两个独立列表', async () => {
    const spy = mount({ plan: 'required', kinds: ['unit'] })
    await userEvent.click(screen.getByTestId('wb-policy-run'))
    await userEvent.click(within(await screen.findByTestId('wb-policy-run-menu')).getByTestId('wb-policy-run-option-regression'))
    expect(last(spy)).toEqual({ plan: 'required', kinds: ['unit'], run: ['regression'] })
  })

  it('范围与场景是单选：点选与方向键都即时上报', async () => {
    const spy = mount({ plan: 'required' })
    await userEvent.click(screen.getByTestId('wb-policy-scope-changed'))
    expect(last(spy)).toEqual({ plan: 'required', scope: 'changed' })
    screen.getByTestId('wb-policy-scope-changed').focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(last(spy)).toEqual({ plan: 'required', scope: 'full' })
    screen.getByTestId('wb-policy-scenarios-off').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(last(spy)).toMatchObject({ scenarios: 'required' })
    await userEvent.keyboard('{End}')
    expect(last(spy)).toMatchObject({ scenarios: 'passing' })
    expect(screen.getByTestId('wb-policy-scenarios-passing')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('wb-policy-scenarios-passing')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('wb-policy-scenarios-off')).toHaveAttribute('tabindex', '-1')
  })

  it('完整性是单选：缺省提示；选阻塞写出 integrity: block；选回提示就去掉这个键；只读时禁用', async () => {
    const spy = mount({ plan: 'required' })
    expect(screen.getByTestId('wb-policy-integrity-notice')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('wb-policy-integrity-block'))
    expect(last(spy)).toEqual({ plan: 'required', integrity: 'block' })
    expect(screen.getByTestId('wb-policy-integrity-row').textContent).toContain('完整性')
    cleanup()
    const back = mount({ plan: 'required', integrity: 'block' })
    expect(screen.getByTestId('wb-policy-integrity-block')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('wb-policy-integrity-notice'))
    expect(last(back)).toEqual({ plan: 'required' })
  })

  it('覆盖率：输入合法值上报，保留 functions 等未管的键；清空一项只去掉那一项', async () => {
    const spy = mount(FULL)
    const lines = screen.getByTestId('wb-policy-coverage-lines')
    await userEvent.clear(lines)
    expect(last(spy)?.coverage).toEqual({ branches: 70, functions: 60 })
    await userEvent.type(lines, '85.5')
    expect(last(spy)?.coverage).toEqual({ lines: 85.5, branches: 70, functions: 60 })
    await userEvent.type(screen.getByTestId('wb-policy-coverage-changed_lines'), '90')
    expect(last(spy)?.coverage).toEqual({ lines: 85.5, branches: 70, functions: 60, changed_lines: 90 })
  })

  it('覆盖率三项都清空且没有别的指标时，整个 coverage 键消失', async () => {
    const spy = mount({ plan: 'required', coverage: { lines: 80 } })
    await userEvent.clear(screen.getByTestId('wb-policy-coverage-lines'))
    expect(last(spy)).toEqual({ plan: 'required' })
  })

  it('非法数字只标红不上报：越界、负数、字母；改回合法后恢复', async () => {
    const spy = mount({ plan: 'required' })
    const lines = screen.getByTestId('wb-policy-coverage-lines')
    await userEvent.type(lines, '101')
    expect(lines).toHaveAttribute('aria-invalid', 'true')
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ coverage: { lines: 101 } }))
    await userEvent.clear(lines)
    await userEvent.type(lines, 'abc')
    expect(lines).toHaveAttribute('aria-invalid', 'true')
    expect(spy.mock.calls.every(([next]) => next?.coverage === undefined || next.coverage.lines !== 101)).toBe(true)
    await userEvent.clear(lines)
    await userEvent.type(lines, '75')
    expect(lines).not.toHaveAttribute('aria-invalid')
    expect(last(spy)).toEqual({ plan: 'required', coverage: { lines: 75 } })
  })

  it('flaky 上限：整数上报并保留 fail_on_new；清空删整个 flaky；小数与越界无效', async () => {
    const spy = mount(FULL)
    const flaky = screen.getByTestId('wb-policy-flaky')
    await userEvent.clear(flaky)
    expect(last(spy)).not.toHaveProperty('flaky')
    await userEvent.type(flaky, '3')
    expect(last(spy)?.flaky).toEqual({ max: 3 })
    await userEvent.clear(flaky)
    await userEvent.type(flaky, '1.5')
    expect(flaky).toHaveAttribute('aria-invalid', 'true')
    await userEvent.clear(flaky)
    await userEvent.type(flaky, '1001')
    expect(flaky).toHaveAttribute('aria-invalid', 'true')
  })

  it('flaky 上限保留已有的 fail_on_new', async () => {
    const spy = mount({ plan: 'required', flaky: { max: 2, fail_on_new: true } })
    const flaky = screen.getByTestId('wb-policy-flaky')
    await userEvent.type(flaky, '0')
    expect(last(spy)?.flaky).toEqual({ max: 20, fail_on_new: true })
  })

  it('要求基线开关：开写入 benchmark.require_baseline，关删键', async () => {
    const spy = mount({ plan: 'required' })
    await userEvent.click(screen.getByTestId('wb-policy-baseline'))
    expect(last(spy)).toEqual({ plan: 'required', benchmark: { require_baseline: true } })
    await userEvent.click(screen.getByTestId('wb-policy-baseline'))
    expect(last(spy)).toEqual({ plan: 'required' })
  })

  it('连续编辑后，表单不管的键（plan / files / run_if_registered / browsers / functions / fail_on_new）逐字保留', async () => {
    const spy = mount(FULL)
    await userEvent.click(screen.getByTestId('wb-policy-scope-changed'))
    await userEvent.click(screen.getByTestId('wb-policy-baseline'))
    await userEvent.click(screen.getByTestId('wb-policy-scenarios-passing'))
    const final = last(spy)
    const { benchmark: _removed, ...unchanged } = FULL
    expect(final).toEqual({ ...unchanged, scope: 'changed', scenarios: 'passing' })
    expect(final).not.toHaveProperty('benchmark')
    expect(final?.files).toBe('registered')
    expect(final?.run_if_registered).toEqual(['benchmark'])
    expect(final?.browsers).toEqual(['chromium'])
    expect(final?.coverage?.functions).toBe(60)
    expect(final?.flaky?.fail_on_new).toBe(true)
  })
})

describe('TestPolicyForm · 添加、移除与只读', () => {
  it('没有策略：段头只有「策略」添加动作，点它写入 { plan: required }；添加后出现表单与移除动作', async () => {
    const spy = mount(undefined)
    expect(screen.queryByTestId('wb-policy')).toBeNull()
    expect(screen.queryByTestId('wb-policy-count')).toBeNull()
    expect(screen.getByTestId('wb-policy-add').textContent).toBe('策略')
    await userEvent.click(screen.getByTestId('wb-policy-add'))
    expect(spy).toHaveBeenCalledWith({ plan: 'required' })
    expect(screen.getByTestId('wb-policy')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-policy-add')).toBeNull()
  })

  it('移除动作在对象旁（段头），点一下就上报 undefined 并收起表单', async () => {
    const spy = mount(FULL)
    await userEvent.click(screen.getByTestId('wb-policy-remove'))
    expect(spy).toHaveBeenCalledWith(undefined)
    expect(screen.queryByTestId('wb-policy')).toBeNull()
    expect(screen.getByTestId('wb-policy-add')).toBeInTheDocument()
  })

  it('只读：所有控件禁用，没有添加与移除动作，值照常显示', async () => {
    const spy = mount(FULL, { editable: false })
    expect(screen.queryByTestId('wb-policy-add')).toBeNull()
    expect(screen.queryByTestId('wb-policy-remove')).toBeNull()
    expect(screen.getByTestId('wb-policy-kinds')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-run')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-scope-changed')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-coverage-lines')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-flaky')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-baseline')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-scenarios-passing')).toBeDisabled()
    expect(screen.getByTestId('wb-policy-coverage-lines')).toHaveValue('80')
    await userEvent.click(screen.getByTestId('wb-policy-scope-changed'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('只读且既没有策略也没有旧测试：只有段头与一个破折号', () => {
    mount(undefined, { editable: false })
    expect(screen.getByTestId('wb-policy-none').textContent).toBe('—')
    expect(screen.queryByTestId('wb-policy-add')).toBeNull()
  })
})

describe('TestPolicyForm · 旧步骤测试（只读行）', () => {
  it('一行一项：名称（label，缺省 id）· 种类 · 命令 · 可复制的转成目录套件命令；没有编辑入口', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    mount(undefined, { legacy: LEGACY })
    const table = screen.getByTestId('wb-tests')
    expect(within(table).getAllByRole('columnheader').slice(0, 3).map((cell) => cell.textContent)).toEqual(['名称', '种类', '命令'])
    const unit = screen.getByTestId('wb-test-unit')
    expect(within(unit).getAllByRole('cell').map((cell) => cell.textContent).slice(0, 3)).toEqual(['单测', '单测', 'npm test'])
    expect(screen.getByTestId('wb-test-convert-unit-text').textContent).toBe('tenon test catalog add --from unit')
    expect(screen.getByTestId('wb-test-odd')).toBeInTheDocument()
    expect(within(screen.getByTestId('wb-test-odd')).getAllByRole('cell')[0]?.textContent).toBe('odd')
    expect(screen.getByTestId('wb-test-convert-odd-text').textContent).toBe("tenon test catalog add --from 'my dir'")
    await userEvent.click(screen.getByTestId('wb-test-convert-unit-copy'))
    expect(write).toHaveBeenCalledWith('tenon test catalog add --from unit')
    expect(screen.queryByTestId('wb-tests-add')).toBeNull()
    expect(within(table).queryByRole('textbox')).toBeNull()
  })

  it('旧测试与策略并存：两者都显示，计数只数策略里的种类', () => {
    mount(FULL, { legacy: LEGACY })
    expect(screen.getByTestId('wb-policy')).toBeInTheDocument()
    expect(screen.getByTestId('wb-tests')).toBeInTheDocument()
    expect(screen.getByTestId('wb-policy-count').textContent).toBe('2')
  })
})
