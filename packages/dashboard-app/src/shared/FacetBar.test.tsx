import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n'
import { FacetBar, type FacetGroup } from './FacetBar'
import { fitCount, priorityOf } from './facetLayout'

describe('fitCount', () => {
  it('全部放得下时不留「更多」', () => {
    expect(fitCount([50, 60, 70], 188, 40, 4)).toBe(3)
  })
  it('放不下时从末尾收起，并给「更多」留位', () => {
    // 50 + 4 + 60 + 4 + 更多 40 = 158 ≤ 160；再加 70 放不下。
    expect(fitCount([50, 60, 70], 160, 40, 4)).toBe(2)
    expect(fitCount([50, 60, 70], 100, 40, 4)).toBe(1)
    expect(fitCount([50, 60, 70], 60, 40, 4)).toBe(0)
  })
})

describe('priorityOf', () => {
  it('芯片组里选中的那颗排到本组最前，其余顺序不变', () => {
    const group = { id: 's', kind: 'chips', value: 'c' }
    const menu = { id: 'm', kind: 'menu', value: 'all' }
    const items = [
      { key: 'm0', group: menu, option: null },
      { key: 'a', group, option: { id: 'a' } },
      { key: 'b', group, option: { id: 'b' } },
      { key: 'c', group, option: { id: 'c' } },
    ]
    expect(priorityOf(items).map((item) => item.key)).toEqual(['m0', 'c', 'a', 'b'])
  })
})

function Harness({ widths }: { widths?: Record<string, number> }): JSX.Element {
  const [status, setStatus] = useState('all')
  const [owner, setOwner] = useState('all')
  const [single, setSingle] = useState('all')
  const groups: FacetGroup[] = [
    {
      id: 'status', kind: 'chips', label: '状态', value: status, onChange: setStatus, testId: 'st',
      options: [{ id: 'all', label: '全部', count: 3 }, { id: 'run', label: '进行中', count: 2 }, { id: 'done', label: '已完成', count: 1 }],
    },
    {
      id: 'owner', kind: 'menu', label: '负责人', value: owner, onChange: setOwner, testId: 'ow',
      options: [{ id: 'all', label: '全部', count: 3 }, { id: 'ann', label: 'Ann', count: 2 }, { id: 'bob', label: 'Bob', count: 1 }],
    },
    {
      id: 'single', kind: 'menu', label: '轨道', value: single, onChange: setSingle, testId: 'sg',
      options: [{ id: 'all', label: '全部', count: 3 }, { id: 'chat', label: 'chat', count: 3 }],
    },
  ]
  const measureWidth = widths === undefined
    ? undefined
    : (element: HTMLElement) => widths[element.dataset.measure ?? ''] ?? 0
  return (
    <I18nProvider>
      <FacetBar groups={groups} label="筛选" testId="bar" {...(measureWidth === undefined ? {} : { measureWidth })} />
    </I18nProvider>
  )
}

describe('FacetBar', () => {
  it('一行显示：不换行、不横向滚动；只有一个取值的维度隐藏', () => {
    render(<Harness />)
    const bar = screen.getByTestId('bar')
    expect(bar.className.split(/\s+/u)).toContain('flex-nowrap')
    expect(bar.className.split(/\s+/u)).not.toContain('flex-wrap')
    expect(bar.className.split(/\s+/u)).not.toContain('overflow-x-auto')
    expect(screen.getByTestId('st')).toHaveAttribute('role', 'radiogroup')
    expect(screen.getByTestId('st-all')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('ow')).toBeInTheDocument()
    expect(screen.queryByTestId('sg')).toBeNull()
    expect(screen.queryByTestId('bar-more')).toBeNull()
  })

  it('芯片键盘：方向键移动并选中', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    screen.getByTestId('st-all').focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByTestId('st-run')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('st-run')).toHaveFocus()
    expect(screen.getByTestId('st-all')).toHaveAttribute('tabindex', '-1')
  })

  it('下拉触发器：选一项后显示当前值与计数', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('ow'))
    await user.click(await screen.findByTestId('ow-ann'))
    expect(screen.getByTestId('ow')).toHaveTextContent('负责人Ann2')
    expect(screen.getByTestId('ow')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('ow')).toHaveAttribute('aria-label', '负责人: Ann')
  })

  it('宽度不够时末尾项整颗收进「更多 N」，菜单里仍可选', async () => {
    const user = userEvent.setup()
    // 容器 200：全部 50 + 进行中 60 + 更多 60 = 178 放得下；再放已完成 60 就超了。
    render(<Harness widths={{ container: 200, 'item:status:all': 50, 'item:status:run': 60, 'item:status:done': 60, 'item:owner': 80, more: 60 }} />)
    expect(screen.getByTestId('st-all')).toBeInTheDocument()
    expect(screen.getByTestId('st-run')).toBeInTheDocument()
    expect(screen.queryByTestId('st-done')).toBeNull()
    expect(screen.queryByTestId('ow')).toBeNull()
    const more = screen.getByTestId('bar-more')
    expect(more).toHaveTextContent('更多2')
    await user.click(more)
    const menu = await screen.findByTestId('bar-more-menu')
    expect(within(menu).getByText('负责人')).toBeInTheDocument()
    await user.click(within(menu).getByTestId('st-done'))
    // 选中的芯片提到可见区（行内总有一个选中项），「全部」仍领头；被挤出的那颗进「更多」。
    expect(screen.getByTestId('st-done')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('st').firstElementChild).toBe(screen.getByTestId('st-all'))
    expect(screen.queryByTestId('st-run')).toBeNull()
    expect(screen.getByTestId('bar-more')).toHaveAttribute('data-active', 'false')
    // 选中项藏在「更多」里时，触发器高亮提示有生效的筛选。
    await user.click(screen.getByTestId('bar-more'))
    await user.click(await screen.findByTestId('ow-bob'))
    expect(screen.getByTestId('bar-more')).toHaveAttribute('data-active', 'true')
  })
})
