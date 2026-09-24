/**
 * 聚合视图的 URL `change` 必须唯一定位一个任务：两个项目有同名 change 时，选中第二个项目的那一个，
 * 刷新（用 URL 里的 change 重新挂载）后仍是它，而不是第一个同名任务。
 */
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { matchesTaskRef, rootTag, taskRef } from './taskRef'
import { WorkspaceView } from './WorkspaceView'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const FIRST = '/Users/me/code/alpha'
const SECOND = '/Users/me/code/beta'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('taskRef', () => {
  it('聚合视图写可读的「项目名:任务名」，单项目视图只写名字；匹配时同名不同项目不算；旧的短标识链接仍认', () => {
    const first = { root: FIRST, change: { name: 'fix-login' } }
    const second = { root: SECOND, change: { name: 'fix-login' } }
    expect(rootTag(FIRST)).toMatch(/^[0-9a-f]{8}$/u)
    expect(rootTag(FIRST)).not.toBe(rootTag(SECOND))
    expect(taskRef(first, false)).toBe('fix-login')
    const ref = taskRef(second, true)
    expect(ref).toBe('beta:fix-login')
    expect(matchesTaskRef(ref, second)).toBe(true)
    expect(matchesTaskRef(ref, first)).toBe(false)
    expect(matchesTaskRef(`${rootTag(SECOND)}:fix-login`, second)).toBe(true)
    expect(matchesTaskRef(`${rootTag(SECOND)}:fix-login`, first)).toBe(false)
    // 不带标识的旧链接按名字匹配。
    expect(matchesTaskRef('fix-login', first)).toBe(true)
  })
})

function Harness({ initial }: { initial: string | null }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(initial)
  const snapshot = makeSnapshot([
    makeProject(FIRST, [makeChange('fix-login', 'build')]),
    makeProject(SECOND, [makeChange('fix-login', 'verify')]),
  ])
  return (
    <I18nProvider><TooltipProvider>
      <WorkspaceView
        snapshot={snapshot}
        currentRoot=""
        rulesByKey={new Map()}
        projects={[
          { root: FIRST, name: 'alpha', count: 1, ok: true },
          { root: SECOND, name: 'beta', count: 1, ok: true },
        ]}
        onSelectProject={() => undefined}
        selectedChange={selected}
        onSelectedChange={setSelected}
      />
      <output data-testid="selected">{selected ?? ''}</output>
    </TooltipProvider></I18nProvider>
  )
}

function selectedCardMeta(): string {
  const card = screen.getAllByTestId('task-card-fix-login').find((candidate) => candidate.getAttribute('aria-current') === 'true')
  if (card === undefined) throw new Error('no selected card')
  return within(card).getByTestId('task-meta-fix-login').textContent ?? ''
}

describe('聚合视图的同名 change', () => {
  it('选中第二个项目的同名任务写入带项目标识的 change；用它重新挂载仍选中第二个', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }))
    const user = userEvent.setup()
    const { unmount } = render(<Harness initial={null} />)
    const cards = screen.getAllByTestId('task-card-fix-login')
    expect(cards).toHaveLength(2)
    const beta = cards.find((card) => within(card).getByTestId('task-meta-fix-login').textContent?.includes('beta'))
    if (beta === undefined) throw new Error('beta card missing')
    await user.click(beta)
    const ref = screen.getByTestId('selected').textContent ?? ''
    expect(ref).toBe('beta:fix-login')
    expect(selectedCardMeta()).toContain('beta')

    unmount()
    render(<Harness initial={ref} />)
    expect(selectedCardMeta()).toContain('beta')
  })
})
