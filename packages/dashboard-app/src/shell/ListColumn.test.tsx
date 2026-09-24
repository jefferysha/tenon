/**
 * 中栏头部的布局契约。jsdom 不做布局，只能断言承担契约的类：头部块不可被 flex 压缩（长列表时
 * 搜索框曾从 44px 被压到 25px）。筛选栏单行 + 「更多」的契约见 workspace/TaskFilters.test.tsx。
 */
import { render, screen } from '@testing-library/react'
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
          eyebrow="E"
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
    expect(classesOf(screen.getByText('E'))).toContain('shrink-0')
    expect(classesOf(screen.getByText('T'))).toContain('shrink-0')
    expect(classesOf(screen.getByTestId('col'))).toContain('overflow-y-auto')
  })
})
