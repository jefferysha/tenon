/**
 * 中栏头部的布局契约。jsdom 不做布局，只能断言承担契约的类：头部块不可被 flex 压缩（长列表时
 * 搜索框曾从 44px 被压到 25px），筛选行换行而不是横向溢出被裁切。
 */
import { render, screen } from '@testing-library/react'
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
    expect(classesOf(screen.getByText('E'))).toContain('shrink-0')
    expect(classesOf(screen.getByText('T'))).toContain('shrink-0')
    expect(classesOf(screen.getByTestId('col'))).toContain('overflow-y-auto')
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
