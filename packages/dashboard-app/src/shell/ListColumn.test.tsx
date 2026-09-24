/**
 * 中栏头部的布局契约。jsdom 不做布局，只能断言承担契约的类：头部块不可被 flex 压缩（长列表时
 * 搜索框曾从 44px 被压到 25px），筛选行换行而不是横向溢出被裁切。
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { WorkspaceView } from '../workspace/WorkspaceView'
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
    expect(classesOf(screen.getByTestId('col-head'))).toContain('shrink-0')
    expect(classesOf(screen.getByTestId('col'))).toContain('overflow-y-auto')
  })

  it('页面名只在 H1 出现一次：eyebrow 不再渲染，H1 不换行', () => {
    render(
      <I18nProvider>
        <ListColumn testId="col" eyebrow="库" title="模板"><p>x</p></ListColumn>
      </I18nProvider>,
    )
    expect(screen.queryByText('库')).toBeNull()
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

describe('工作台筛选行', () => {
  it('负责人 / 工作流 / 轨道 / 阶段各行换行显示，不横向溢出裁切', () => {
    const changes = [
      makeChange('a', 'build', { track: 'chat' }),
      makeChange('b', 'verify', { track: 'chat' }),
    ]
    render(
      <I18nProvider>
        <WorkspaceView
          snapshot={makeSnapshot([makeProject('/repo', changes, { uncommittedDeletions: 2 })])}
          currentRoot="/repo"
          rulesByKey={new Map()}
          projects={[{ root: '/repo', name: 'repo', count: 2, ok: true }]}
          onSelectProject={() => undefined}
          selectedChange={null}
          onSelectedChange={() => undefined}
          me={{ id: 'me@x.io', slug: 'me', name: 'me' }}
        />
      </I18nProvider>,
    )
    for (const id of ['task-facet-owner', 'task-facet-workflow', 'task-facet-track', 'task-facet-stage', 'task-facet-workflow-row']) {
      const row = screen.getByTestId(id)
      expect(classesOf(row), id).toContain('flex-wrap')
      expect(classesOf(row), id).not.toContain('overflow-x-auto')
    }
    expect(screen.getByTestId('task-uncommitted-deletions')).toHaveTextContent('未提交删除')
    // 状态开关与工作流芯片不在同一行：同行时芯片会被挤成竖排（1440 宽真机复查发现）。
    const toggles = screen.getByTestId('task-facet-workflow-row')
    expect(toggles).toContainElement(screen.getByTestId('task-filter-completed'))
    expect(toggles).not.toContainElement(screen.getByTestId('task-facet-workflow'))
  })

})
