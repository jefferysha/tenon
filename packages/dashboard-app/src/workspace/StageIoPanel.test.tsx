import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WbStepIoFile } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { StageIoPanel, type StageIoPanelProps } from './StageIoPanel'

afterEach(() => {
  cleanup()
  localStorage.removeItem('tenon-dashboard-lang')
})

const labelOf = (id: string): string => ({ explore: '调研', spec: '规格' })[id] ?? id
const DESIGN = 'docs/superpowers/specs/2026-10-12-demo-design.md'

function renderPanel(props: Partial<StageIoPanelProps> & Pick<StageIoPanelProps, 'direction' | 'items'>) {
  return render(
    <I18nProvider>
      <StageIoPanel activePath={null} definitionState="ready" labelOf={labelOf} onOpen={() => undefined} {...props} />
    </I18nProvider>,
  )
}

const cells = (testId: string): HTMLElement[] => within(screen.getByTestId(testId)).getAllByRole('cell')

describe('StageIoPanel · 输出表', () => {
  const outputs: WbStepIoFile[] = [
    { path: DESIGN, change: 'added', skill: 'brainstorming' },
    { path: 'src/demo.ts', change: 'modified', skill: null },
    { path: 'docs/old.md', change: 'deleted', skill: 'cleanup' },
  ]

  it('带表头的等分表 文件 · 变化 · 来源技能；变化是新增 / 修改 / 删除，推断不出来源技能写「未知」', () => {
    renderPanel({ direction: 'outputs', items: outputs })
    const table = within(screen.getByTestId('stage-outputs')).getByRole('table')
    const head = screen.getByTestId('stage-outputs-head')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['文件', '变化', '来源技能'])
    expect(head.className).toContain('grid-cols-3')
    expect(cells(`stage-output-${DESIGN}`).map((cell) => cell.textContent)).toEqual(['2026-10-12-demo-design.mddocs/superpowers/specs/', '新增', 'brainstorming'])
    expect(cells('stage-output-src/demo.ts').map((cell) => cell.textContent)).toEqual(['demo.tssrc/', '修改', '未知'])
    expect(cells('stage-output-docs/old.md').map((cell) => cell.textContent)).toEqual(['old.mddocs/', '删除', 'cleanup'])
  })

  it('旧任务的输出没有变化类型：该格写「—」', () => {
    renderPanel({ direction: 'outputs', items: [{ path: 'openspec/changes/demo/proposal.md', skill: 'openspec-propose' }] })
    expect(cells('stage-output-openspec/changes/demo/proposal.md').map((cell) => cell.textContent)).toEqual(['proposal.mdopenspec/changes/demo/', '—', 'openspec-propose'])
  })

  it('任何格都不换行：单元格截断并带 title，行与表头 nowrap，没有 flex-wrap', () => {
    renderPanel({ direction: 'outputs', items: outputs })
    const row = screen.getByTestId(`stage-output-${DESIGN}`)
    // 行间一条细分隔线，不是一张张卡片。
    expect(row).toHaveAttribute('role', 'row')
    expect(row.className).toContain('border-b')
    expect(row.className).not.toMatch(/(^|\s)rounded-md(\s|$)/u)
    expect(row.className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('stage-outputs-head').className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('stage-outputs').innerHTML).not.toContain('flex-wrap')
    for (const cell of within(row).getAllByRole('cell')) {
      expect(cell.className).toMatch(/truncate|min-w-0/u)
    }
    expect(row).toHaveAttribute('title', DESIGN)
    expect(cells('stage-output-src/demo.ts')[2]).toHaveAttribute('title', '未知')
  })

  it('点整行打开抽屉；删除的文件已不在盘上，不可点；当前打开的行高亮', async () => {
    const onOpen = vi.fn()
    renderPanel({ direction: 'outputs', items: outputs, onOpen, activePath: 'src/demo.ts' })
    await userEvent.click(cells(`stage-output-${DESIGN}`)[1] as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith(DESIGN)
    await userEvent.click(screen.getByTestId('stage-output-open-src/demo.ts'))
    expect(onOpen).toHaveBeenLastCalledWith('src/demo.ts')
    await userEvent.click(screen.getByTestId('stage-output-docs/old.md'))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('stage-output-open-docs/old.md')).toBeNull()
    expect(screen.getByTestId('stage-output-open-src/demo.ts')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId(`stage-output-${DESIGN}`).className).not.toContain('bg-sel-bg')
    expect(screen.getByTestId('stage-output-src/demo.ts').className).toContain('bg-sel-bg')
  })

  it('空态只一个短语：本步还没有产出', () => {
    renderPanel({ direction: 'outputs', items: [] })
    expect(screen.getByRole('status')).toHaveTextContent(/^本步还没有产出$/u)
  })
})

describe('StageIoPanel · 输入表', () => {
  const inputs: WbStepIoFile[] = [
    { path: DESIGN, skill: 'brainstorming', fromStep: 'explore', read: true },
    { path: 'docs/notes.md', skill: null, fromStep: 'explore', read: false },
    { path: 'docs/other.md', skill: 'x', fromStep: 'gone-step', read: false },
  ]

  it('带表头的等分表 文件 · 来源阶段 · 来源技能 · 已读；来源阶段写名称（没有名称写 id），已读 / 未读', () => {
    renderPanel({ direction: 'inputs', items: inputs })
    const table = within(screen.getByTestId('stage-inputs')).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['文件', '来源阶段', '来源技能', '已读'])
    expect(screen.getByTestId('stage-inputs-head').className).toContain('grid-cols-4')
    expect(cells(`stage-input-${DESIGN}`).map((cell) => cell.textContent)).toEqual(['2026-10-12-demo-design.mddocs/superpowers/specs/', '调研', 'brainstorming', '已读'])
    expect(cells('stage-input-docs/notes.md').map((cell) => cell.textContent)).toEqual(['notes.mddocs/', '调研', '未知', '未读'])
    expect(cells('stage-input-docs/other.md')[1]?.textContent).toBe('gone-step')
    expect(screen.getByTestId(`stage-input-${DESIGN}`)).toHaveAttribute('data-read', 'true')
    expect(screen.getByTestId('stage-input-docs/notes.md')).toHaveAttribute('data-read', 'false')
  })

  it('来源阶段与来源技能是纯文字：不用方框芯片、药丸', () => {
    renderPanel({ direction: 'inputs', items: inputs })
    // 格子里就是文字本身，没有套任何子元素（芯片 / 药丸 / 圆点）。
    for (const cell of [cells(`stage-input-${DESIGN}`)[1], cells(`stage-input-${DESIGN}`)[2]] as HTMLElement[]) {
      expect(cell.children).toHaveLength(0)
      expect(cell.className).not.toMatch(/border|bg-/u)
    }
  })

  it('旧任务的输入也有来源阶段与已读状态；没有来源阶段写「—」', () => {
    renderPanel({ direction: 'inputs', items: [{ path: 'docs/adr/demo.md', skill: 'brainstorming', read: false }] })
    expect(cells('stage-input-docs/adr/demo.md').map((cell) => cell.textContent)).toEqual(['demo.mddocs/adr/', '—', 'brainstorming', '未读'])
  })

  it('空态只一个短语：本步没有输入', () => {
    renderPanel({ direction: 'inputs', items: [] })
    expect(screen.getByRole('status')).toHaveTextContent(/^本步没有输入$/u)
  })
})

describe('StageIoPanel · 英文与加载态', () => {
  it('英文成对：表头、变化、未知、已读与空态', () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const view = renderPanel({ direction: 'outputs', items: [{ path: 'a.ts', change: 'modified', skill: null }] })
    expect(within(screen.getByTestId('stage-outputs')).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['File', 'Change', 'Source skill'])
    expect(cells('stage-output-a.ts').map((cell) => cell.textContent)).toEqual(['a.ts', 'Modified', 'Unknown'])
    view.unmount()
    renderPanel({ direction: 'inputs', items: [{ path: 'a.md', skill: 'x', fromStep: 'explore', read: false }] })
    expect(within(screen.getByTestId('stage-inputs')).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['File', 'Source stage', 'Source skill', 'Read'])
    expect(cells('stage-input-a.md').map((cell) => cell.textContent)).toEqual(['a.md', '调研', 'x', 'Unread'])
    cleanup()
    renderPanel({ direction: 'inputs', items: [] })
    expect(screen.getByRole('status')).toHaveTextContent('No inputs for this step')
    cleanup()
    renderPanel({ direction: 'outputs', items: [] })
    expect(screen.getByRole('status')).toHaveTextContent('No outputs for this step yet')
  })

  it('读取中与读取失败只显示一行，不画表', () => {
    renderPanel({ direction: 'outputs', items: [], definitionState: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
    expect(screen.queryByRole('table')).toBeNull()
    cleanup()
    renderPanel({ direction: 'outputs', items: [], definitionState: 'error' })
    expect(screen.getByRole('alert')).toHaveTextContent('工作流定义读取失败')
    expect(screen.queryByRole('table')).toBeNull()
  })
})
