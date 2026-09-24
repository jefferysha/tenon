/**
 * 中栏头部的布局契约。jsdom 不做布局，只能断言承担契约的类：头部块不可被 flex 压缩（长列表时
 * 搜索框曾从 44px 被压到 25px）。筛选栏单行 + 「更多」的契约见 workspace/TaskFilters.test.tsx。
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { FilterChip, ListColumn } from './ThreeColumns'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const classesOf = (element: Element): string[] => element.className.split(/\s+/u)

describe('ListColumn 头部', () => {
  it('搜索框与筛选行不参与 flex 压缩，列表由本列滚动', () => {
    render(
      <I18nProvider>
        <ListColumn
          testId="col"
          title="T"
          search={{ value: '', onChange: () => undefined, placeholder: 'p', label: 'l' }}
          chips={<FilterChip label="全部" selected testId="chip" onClick={() => undefined} />}
        >
          <ul>{Array.from({ length: 200 }, (_, index) => <li key={index}>{index}</li>)}</ul>
        </ListColumn>
      </I18nProvider>,
    )
    expect(classesOf(screen.getByTestId('col-search-box'))).toContain('shrink-0')
    expect(classesOf(screen.getByTestId('col-chips'))).toContain('shrink-0')
    expect(classesOf(screen.getByTestId('col-head'))).toContain('shrink-0')
    expect(classesOf(screen.getByTestId('col'))).toContain('overflow-y-auto')
  })

  it('页面名只在 H1 出现一次：标题行只有 H1（无 eyebrow），H1 不换行', () => {
    render(
      <I18nProvider>
        <ListColumn testId="col" title="模板"><p>x</p></ListColumn>
      </I18nProvider>,
    )
    expect(screen.getByTestId('col-head').children).toHaveLength(1)
    const heading = screen.getByRole('heading', { level: 1, name: '模板' })
    expect(classesOf(heading)).toEqual(expect.arrayContaining(['whitespace-nowrap', 'truncate']))
    expect(screen.queryByTestId('col-action')).toBeNull()
  })

  it('action 插槽渲染在 H1 同一行右侧', () => {
    render(
      <I18nProvider>
        <ListColumn testId="col" title="模板" action={<button type="button">新建</button>}><p>x</p></ListColumn>
      </I18nProvider>,
    )
    const head = screen.getByTestId('col-head')
    expect(head).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(within(screen.getByTestId('col-action')).getByRole('button', { name: '新建' })).toBeInTheDocument()
    expect(head).toContainElement(screen.getByTestId('col-action'))
  })

  it('搜索框聚焦时强调色边框 + 光环', () => {
    render(
      <I18nProvider>
        <ListColumn testId="col" title="T" search={{ value: '', onChange: () => undefined, placeholder: 'p', label: 'l' }}><p>x</p></ListColumn>
      </I18nProvider>,
    )
    expect(classesOf(screen.getByTestId('col-search-box'))).toEqual(
      expect.arrayContaining(['focus-within:border-(--accent)', 'focus-within:ring-2', 'focus-within:ring-(--accent)/25']),
    )
  })

  it('chipsLabel 给定时芯片行是 radiogroup', () => {
    render(
      <I18nProvider>
        <ListColumn testId="col" title="T" chipsLabel="类别" chips={<FilterChip label="全部" selected testId="chip" onClick={() => undefined} />}><p>x</p></ListColumn>
      </I18nProvider>,
    )
    expect(screen.getByRole('radiogroup', { name: '类别' })).toBe(screen.getByTestId('col-chips'))
  })
})
