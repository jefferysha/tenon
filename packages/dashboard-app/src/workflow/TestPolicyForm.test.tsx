import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WbStepTest, WbStepTestPolicy, WbTestLevel } from '../api/governanceTypes'
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

const LEVELS: readonly WbTestLevel[] = ['none', 'plan', 'changed', 'full']

interface State {
  level?: WbTestLevel
  policy?: WbStepTestPolicy
  legacy?: WbStepTest[]
  editable?: boolean
}

function Harness({ initial, spy }: { initial: State; spy: (level: WbTestLevel) => void }): JSX.Element {
  const [state, setState] = useState<{ level: WbTestLevel | undefined; policy: WbStepTestPolicy | undefined }>({
    level: initial.level, policy: initial.policy,
  })
  return (
    <TestPolicyForm
      stepId="verify"
      level={state.level}
      legacyPolicy={state.policy}
      legacyTests={initial.legacy ?? []}
      editable={initial.editable ?? true}
      onChange={(next) => { spy(next); setState({ level: next, policy: undefined }) }}
    />
  )
}

function mount(initial: State = {}) {
  const spy = vi.fn<(level: WbTestLevel) => void>()
  render(<I18nProvider><TooltipProvider><Harness initial={initial} spy={spy} /></TooltipProvider></I18nProvider>)
  return spy
}

const radio = (level: WbTestLevel): HTMLElement => screen.getByTestId(`wb-test-level-${level}`)
const checked = (): string[] => LEVELS.filter((level) => radio(level).getAttribute('aria-checked') === 'true')

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('TestPolicyForm · 档位单选', () => {
  it('四选一：不要求 / 写计划 / 跑改动 / 全量，按这个顺序；子块头一行，只有一个标题', () => {
    mount()
    expect(within(screen.getByRole('radiogroup', { name: '档位' })).getAllByRole('radio').map((item) => item.textContent))
      .toEqual(['不要求', '写计划', '跑改动', '全量'])
    const head = screen.getByRole('heading', { level: 3 })
    expect(head.textContent).toBe('测试')
    expect(head.parentElement?.className).toContain('whitespace-nowrap')
  })

  it('没有声明：选中「不要求」；声明了哪档就选中哪档', () => {
    mount()
    expect(checked()).toEqual(['none'])
  })

  it.each(LEVELS)('档位 %s 被选中，别的不选', (level) => {
    mount({ level })
    expect(checked()).toEqual([level])
  })

  it('点另一档上报该档位；点已选中的不上报', async () => {
    const spy = mount({ level: 'changed' })
    await userEvent.click(radio('changed'))
    expect(spy).not.toHaveBeenCalled()
    await userEvent.click(radio('full'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenLastCalledWith('full')
    expect(checked()).toEqual(['full'])
    await userEvent.click(radio('none'))
    expect(spy).toHaveBeenLastCalledWith('none')
  })

  it('键盘：只有选中的那一项在 Tab 序里；方向键、Home、End 在选项间移动并即时选中', async () => {
    const spy = mount({ level: 'plan' })
    expect(LEVELS.filter((level) => radio(level).tabIndex === 0)).toEqual(['plan'])
    radio('plan').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(spy).toHaveBeenLastCalledWith('changed')
    expect(radio('changed')).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(spy).toHaveBeenLastCalledWith('full')
    await userEvent.keyboard('{ArrowRight}')
    expect(spy).toHaveBeenLastCalledWith('none')
    await userEvent.keyboard('{ArrowLeft}')
    expect(spy).toHaveBeenLastCalledWith('full')
    await userEvent.keyboard('{Home}')
    expect(spy).toHaveBeenLastCalledWith('none')
  })

  it('页面上没有说明句子；档位定义在哪个文件只在图标的 Tooltip 里，键盘聚焦即可读到', async () => {
    mount({ level: 'full' })
    const text = screen.getByTestId('stage-tests').textContent ?? ''
    expect(text).not.toContain('。')
    expect(text).not.toContain('catalog.yaml')
    const hint = screen.getByTestId('wb-test-level-hint')
    expect(hint).toHaveAccessibleName('档位定义: .tenon/tests/catalog.yaml')
    hint.focus()
    expect((await screen.findAllByText('.tenon/tests/catalog.yaml')).length).toBeGreaterThan(0)
  })

  it('标签与选项不折行', () => {
    mount({ level: 'changed' })
    for (const level of LEVELS) expect(radio(level).className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('wb-test-level').parentElement?.className ?? '').not.toContain('flex-wrap')
  })

  it('只读：选项全部禁用，点击不上报，选中项照常显示，没有动作', async () => {
    const spy = mount({ level: 'changed', editable: false })
    for (const level of LEVELS) expect(radio(level)).toBeDisabled()
    expect(checked()).toEqual(['changed'])
    await userEvent.click(radio('full'))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('TestPolicyForm · 旧 test_policy', () => {
  it('只读摘要：种类（必跑 / 登记 / 有则跑去重）· 范围；没有任何档位被选中，第一项可 Tab 进入', () => {
    mount({ policy: FULL })
    expect(checked()).toEqual([])
    expect(LEVELS.filter((level) => radio(level).tabIndex === 0)).toEqual(['none'])
    const summary = screen.getByTestId('wb-policy-legacy')
    expect(summary.textContent).toBe('策略单测 · Playwright · 基准 · 全量')
    expect(within(summary).queryByRole('textbox')).toBeNull()
    expect(within(summary).queryByRole('button')).toBeNull()
  })

  it('旧策略没有种类也没有范围：摘要是破折号', () => {
    mount({ policy: { plan: 'required' } })
    expect(screen.getByTestId('wb-policy-legacy').textContent).toBe('策略—')
  })

  it('选档即替换：上报新档位，摘要随之消失，该档被选中', async () => {
    const spy = mount({ policy: FULL })
    await userEvent.click(radio('changed'))
    expect(spy).toHaveBeenCalledWith('changed')
    expect(screen.queryByTestId('wb-policy-legacy')).toBeNull()
    expect(checked()).toEqual(['changed'])
  })

  it('选「不要求」同样替换旧策略（旧策略下没有任何档位被选中，所以这一点是有效动作）', async () => {
    const spy = mount({ policy: FULL })
    await userEvent.click(radio('none'))
    expect(spy).toHaveBeenCalledWith('none')
    expect(screen.queryByTestId('wb-policy-legacy')).toBeNull()
  })

  it('只读且有旧策略：摘要照常显示，选项禁用', async () => {
    const spy = mount({ policy: FULL, editable: false })
    expect(screen.getByTestId('wb-policy-legacy')).toBeInTheDocument()
    await userEvent.click(radio('full'))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('TestPolicyForm · 旧步骤测试（只读行）', () => {
  it('一行一项：名称（label，缺省 id）· 种类 · 命令 · 可复制的转成目录套件命令；没有编辑入口', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    mount({ legacy: LEGACY })
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
    expect(within(table).queryByRole('textbox')).toBeNull()
  })

  it('旧步骤测试与档位并存：两者都显示', () => {
    mount({ level: 'plan', legacy: LEGACY })
    expect(screen.getByTestId('wb-test-level')).toBeInTheDocument()
    expect(screen.getByTestId('wb-tests')).toBeInTheDocument()
    expect(checked()).toEqual(['plan'])
  })
})
