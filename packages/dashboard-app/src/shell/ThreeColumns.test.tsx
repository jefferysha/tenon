/**
 * 三栏原语契约：芯片单选语义与键盘、状态标记（点 + 文字）、空态只写标题、左列首项插槽与折叠钮、
 * 网格宽度。jsdom 不做布局，宽度与可见性只能断言承担契约的类。
 */
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n'
import { DetailEmpty, FilterChip, FilterChipGroup, RailCard, RailColumn, StatusPill, ThreeColumns } from './ThreeColumns'
import { ThreeColumnsSkeleton } from './Skeleton'

const classesOf = (element: Element): string[] => element.className.split(/\s+/u)

function Chips({ initial = 'all' }: { initial?: string }): JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <FilterChipGroup label="状态" testId="group">
      {['all', 'needs-you', 'done'].map((id) => (
        <FilterChip key={id} label={id} selected={value === id} testId={`chip-${id}`} onClick={() => setValue(id)} />
      ))}
    </FilterChipGroup>
  )
}

describe('FilterChip / FilterChipGroup（H3）', () => {
  it('radiogroup + radio + aria-checked；只有选中项在 Tab 序列里', () => {
    render(<Chips />)
    expect(screen.getByRole('radiogroup', { name: '状态' })).toBe(screen.getByTestId('group'))
    const all = screen.getByRole('radio', { name: 'all' })
    expect(all).toHaveAttribute('aria-checked', 'true')
    expect(all).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('chip-done')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('chip-done')).toHaveAttribute('tabindex', '-1')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('方向键移动焦点并选中，首尾循环；Home / End 跳到两端', () => {
    render(<Chips />)
    fireEvent.keyDown(screen.getByTestId('chip-all'), { key: 'ArrowRight' })
    expect(screen.getByTestId('chip-needs-you')).toHaveFocus()
    expect(screen.getByTestId('chip-needs-you')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByTestId('chip-needs-you'), { key: 'End' })
    expect(screen.getByTestId('chip-done')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByTestId('chip-done'), { key: 'ArrowRight' })
    expect(screen.getByTestId('chip-all')).toHaveFocus()
    expect(screen.getByTestId('chip-all')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByTestId('chip-all'), { key: 'ArrowLeft' })
    expect(screen.getByTestId('chip-done')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByTestId('chip-done'), { key: 'Home' })
    expect(screen.getByTestId('chip-all')).toHaveAttribute('aria-checked', 'true')
  })

  it('其他键不处理；Home / End 跳到两端并选中', () => {
    render(<Chips />)
    fireEvent.keyDown(screen.getByTestId('chip-all'), { key: 'Enter' })
    expect(screen.getByTestId('chip-all')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByTestId('chip-all'), { key: 'End' })
    expect(screen.getByTestId('chip-done')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('chip-done')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('chip-done'), { key: 'Home' })
    expect(screen.getByTestId('chip-all')).toHaveAttribute('aria-checked', 'true')
  })

  it('点击区至少 40px（min-h-10），芯片不换行', () => {
    render(<Chips />)
    expect(classesOf(screen.getByTestId('chip-all'))).toEqual(expect.arrayContaining(['min-h-10', 'whitespace-nowrap']))
  })
})

describe('StatusPill（B4：语义点 + 文字）', () => {
  it('无底色、无药丸圆角；圆点与文字同色调，文字总在', () => {
    render(<StatusPill tone="pending" testId="pill">待复核</StatusPill>)
    const pill = screen.getByTestId('pill')
    const classes = classesOf(pill)
    expect(classes).not.toContain('rounded-full')
    expect(classes.some((name) => name.startsWith('bg-'))).toBe(false)
    expect(classes).toEqual(expect.arrayContaining(['text-amber-d', 'whitespace-nowrap']))
    expect(pill).toHaveAttribute('data-tone', 'pending')
    expect(pill).toHaveTextContent('待复核')
    expect(pill.querySelector('i[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('DetailEmpty（E7）', () => {
  it('只渲染标题，没有副标题', () => {
    render(<DetailEmpty title="选一个模板" testId="empty" />)
    const empty = screen.getByTestId('empty')
    expect(empty).toHaveTextContent('选一个模板')
    expect(empty.textContent).toBe('选一个模板')
  })
})

describe('RailColumn（A5 / H4 / J1）', () => {
  it('lead 插槽渲染在列表之前、同一滚动区；折叠钮 40px 且 ≤1280px 隐藏', () => {
    render(
      <I18nProvider>
        <RailColumn
          title="项目"
          collapsed={false}
          onToggle={() => undefined}
          testId="rail"
          lead={<RailCard mark={<span />} name="所有项目" selected={false} collapsed={false} onClick={() => undefined} testId="rail-all" />}
        >
          <ul><li data-testid="rail-first">a</li></ul>
        </RailColumn>
      </I18nProvider>,
    )
    const lead = screen.getByTestId('rail-lead')
    expect(lead).toContainElement(screen.getByTestId('rail-all'))
    expect(lead.compareDocumentPosition(screen.getByTestId('rail-first')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(classesOf(screen.getByTestId('rail-all'))).toContain('min-h-10')
    expect(classesOf(screen.getByTestId('rail-toggle'))).toEqual(expect.arrayContaining(['size-10', 'max-[1280px]:hidden', 'max-[900px]:grid']))
  })
})

describe('RailCard（E11 / D6）', () => {
  it('mark 接受语义图标；展开时副行带完整路径 title；不可用时图标与副行变红', () => {
    render(
      <RailCard
        mark={<svg data-testid="icon" />}
        name="tenon"
        meta="~/…/code/tenon"
        metaTitle="/Users/me/work/code/tenon"
        metaMono
        danger
        selected={false}
        collapsed={false}
        onClick={() => undefined}
        testId="card"
      />,
    )
    expect(screen.getByTestId('card-mark')).toContainElement(screen.getByTestId('icon'))
    const meta = screen.getByTestId('card-meta')
    expect(meta).toHaveAttribute('title', '/Users/me/work/code/tenon')
    expect(classesOf(meta)).toEqual(expect.arrayContaining(['font-mono', 'truncate', 'text-red-d']))
    expect(classesOf(screen.getByTestId('card-mark'))).toContain('text-red-d')
  })
})

describe('ThreeColumns 网格（J1）', () => {
  it('展开：左列 280px、中列 360–420px；≤1280px 左列折叠到 64px', () => {
    render(<ThreeColumns testId="grid" railCollapsed={false} rail={<aside />} list={<section />} detail={<section />} />)
    expect(classesOf(screen.getByTestId('grid'))).toEqual(expect.arrayContaining([
      'grid-cols-[280px_minmax(360px,420px)_minmax(0,1fr)]',
      'max-[1280px]:grid-cols-[64px_minmax(360px,420px)_minmax(0,1fr)]',
    ]))
  })

  it('折叠：左列 64px、中列宽度不变', () => {
    render(<ThreeColumns testId="grid" railCollapsed rail={<aside />} list={<section />} detail={<section />} />)
    expect(classesOf(screen.getByTestId('grid'))).toContain('grid-cols-[64px_minmax(360px,420px)_minmax(0,1fr)]')
  })
})

describe('ThreeColumnsSkeleton（A1②）', () => {
  it('status 区域 + 读屏文字；左列 8 条、中列 3 张卡；reduced-motion 下所有骨架静止', () => {
    render(<I18nProvider><ThreeColumnsSkeleton testId="sk" /></I18nProvider>)
    const root = screen.getByTestId('sk')
    expect(root).toHaveAttribute('role', 'status')
    expect(root).toHaveAttribute('aria-busy', 'true')
    expect(root).toHaveTextContent('加载中')
    const bones = root.querySelectorAll('span[aria-hidden="true"]')
    expect(bones.length).toBeGreaterThan(0)
    for (const bone of bones) expect(classesOf(bone)).toEqual(expect.arrayContaining(['animate-pulse', 'motion-reduce:animate-none']))
    expect(screen.getByTestId('sk-rail').querySelectorAll('.h-\\[52px\\]')).toHaveLength(8)
    expect(screen.getByTestId('sk-list').querySelectorAll('.h-28')).toHaveLength(3)
  })
})
