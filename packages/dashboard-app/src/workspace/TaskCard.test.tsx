import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { LIST_ROW } from '../library/libraryChrome'
import { LIST_SELECTED, LIST_SELECTED_ARIA } from '../shared/uiRecipes'
import { WorkspaceView } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const ROOT = '/Users/me/code/repo'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderList(): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 }))
  render(
    <I18nProvider>
      <WorkspaceView
        snapshot={makeSnapshot([makeProject(ROOT, [makeChange('a', 'build'), makeChange('b', 'spec')], { uncommittedDeletions: 2 })])}
        currentRoot={ROOT}
        rulesByKey={new Map()}
        projects={[{ root: ROOT, name: 'repo', count: 2, ok: true }]}
        onSelectProject={() => undefined}
        selectedChange={null}
        onSelectedChange={() => undefined}
      />
    </I18nProvider>,
  )
}

describe('任务卡选中态（A6）', () => {
  it('选中 = 中性选中底 + 左侧 2px 内嵌边，不加描边、不改内边距', () => {
    renderList()
    const selected = screen.getByTestId('task-card-a')
    expect(selected).toHaveAttribute('aria-current', 'true')
    expect(LIST_SELECTED).toBe('bg-sel-bg shadow-[inset_2px_0_0_var(--sel-edge)]')
    for (const cls of LIST_SELECTED.split(' ')) expect(selected.className).toContain(cls)
    expect(selected.className).not.toMatch(/(?:^|\s)border/u)
    expect(selected.className).not.toContain('pl-3 ')
    const other = screen.getByTestId('task-card-b')
    expect(other.className).not.toContain('bg-sel-bg')
    expect(other.className).not.toContain('shadow-[inset')
  })
})

describe('全站列表选中态只有一份（uiRecipes）', () => {
  it('工作台卡片、侧栏项、库列表行用同一类串', () => {
    renderList()
    const card = screen.getByTestId('task-card-a').className.split(/\s+/u)
    expect(card).toEqual(expect.arrayContaining(LIST_SELECTED.split(' ')))
    const rail = screen.getByTestId('project-rail-item-repo')
    expect(rail).toHaveAttribute('aria-current', 'true')
    expect(rail.className.split(/\s+/u)).toEqual(expect.arrayContaining(LIST_SELECTED_ARIA.split(' ')))
    expect(LIST_ROW.split(/\s+/u)).toEqual(expect.arrayContaining(LIST_SELECTED_ARIA.split(' ')))
    expect(LIST_SELECTED_ARIA).toBe(LIST_SELECTED.split(' ').map((cls) => `aria-[current=true]:${cls}`).join(' '))
  })
})

describe('筛选栏计数（B10）', () => {
  it('已归档与未提交删除的计数用 tabular-nums，不用等宽', () => {
    renderList()
    for (const id of ['task-view-archived', 'task-uncommitted-deletions']) {
      const count = screen.getByTestId(id).querySelector('span')
      expect(count?.className).toContain('tabular-nums')
      expect(count?.className).not.toContain('font-mono')
    }
  })
})
