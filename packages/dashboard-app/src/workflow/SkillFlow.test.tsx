import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WbSkillRef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { useReactFlow } from './reactFlowTestDouble'
import { addSkillAt, appendSerial, canvasHeight, CONTROLS_BAND, CONTROLS_CLASS, dropTargetFor, edgesOf, editViewport, graphToSkills, isColumnLink, lanesOf, layoutSkills, readOnlyViewport, REFIT_MS, RESIZE_THROTTLE_MS, SkillFlow, skillsSignature, wouldCycle } from './SkillFlow'
import { signalModeOf } from './flowSignal'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const SKILLS: WbSkillRef[] = [
  { id: 'tenon-explore' },
  { id: 'brainstorming', depends_on: ['tenon-explore'] },
  { id: 'grill-with-docs', depends_on: ['tenon-explore'] },
]

describe('SkillFlow · 纯函数', () => {
  it('layoutSkills：列 = 波次，行 = 波内序；各列围绕同一条中线居中', () => {
    const layout = layoutSkills(SKILLS)
    expect(layout.map((node) => node.id)).toEqual(['tenon-explore', 'brainstorming', 'grill-with-docs'])
    expect(layout[0]!.x).toBeLessThan(layout[1]!.x)
    expect(layout[1]!.x).toBe(layout[2]!.x)
    expect(layout[1]!.y).toBeLessThan(layout[2]!.y)
    expect(layout[0]!.y).toBe((layout[1]!.y + layout[2]!.y) / 2)
  })
  it('isColumnLink：下一波每个节点恰好依赖上一波全部节点才成立', () => {
    expect(isColumnLink(['a'], ['b', 'c'], edgesOf([{ id: 'a' }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['a'] }]))).toBe(true)
    expect(isColumnLink(['a', 'x'], ['b'], edgesOf([{ id: 'a' }, { id: 'x' }, { id: 'b', depends_on: ['a'] }]))).toBe(false)
    expect(isColumnLink([], ['b'], [])).toBe(false)
  })
  it('edgesOf：只保留两端都在阶段内的 depends_on', () => {
    expect(edgesOf([...SKILLS, { id: 'x', depends_on: ['ghost'] }]).map((edge) => edge.id)).toEqual(['tenon-explore->brainstorming', 'tenon-explore->grill-with-docs'])
  })
  it('wouldCycle：自环与反向边成环，正向不成环', () => {
    const edges = edgesOf(SKILLS)
    expect(wouldCycle(edges, 'a', 'a')).toBe(true)
    expect(wouldCycle(edges, 'brainstorming', 'tenon-explore')).toBe(true)
    expect(wouldCycle(edges, 'brainstorming', 'grill-with-docs')).toBe(false)
  })
  it('graphToSkills：depends_on = 入边起点，其它字段带回，顺序按波次拍平', () => {
    const skills = graphToSkills(['grill-with-docs', 'brainstorming', 'tenon-explore', 'handoff'], [...edgesOf(SKILLS), { source: 'brainstorming', target: 'handoff' }], SKILLS)
    expect(skills.map((skill) => skill.id)).toEqual(['tenon-explore', 'brainstorming', 'grill-with-docs', 'handoff'])
    expect(skills[2]).toEqual({ id: 'grill-with-docs', depends_on: ['tenon-explore'] })
    expect(skills[3]).toEqual({ id: 'handoff', depends_on: ['brainstorming'] })
    expect(skills[0]!.depends_on).toBeUndefined()
  })
})

describe('SkillFlow · 落点语义', () => {
  it('dropTargetFor：列附近 = 并入该波；末列右侧 = 新一步；首列左侧 = 新首步；无列 = 新一步', () => {
    const columns = [96, 396]
    expect(dropTargetFor(150, columns)).toEqual({ kind: 'join', wave: 0 })
    expect(dropTargetFor(420, columns)).toEqual({ kind: 'join', wave: 1 })
    expect(dropTargetFor(800, columns)).toEqual({ kind: 'after' })
    expect(dropTargetFor(10, columns)).toEqual({ kind: 'before' })
    expect(dropTargetFor(10, [])).toEqual({ kind: 'after' })
  })
  it('addSkillAt：after 依赖末波；before 被首波依赖；join 依赖上一波并被下一波依赖；重复 id 不变', () => {
    const base = [{ id: 'a' }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['a'] }]
    expect(appendSerial(base, 'd')).toEqual([...base, { id: 'd', depends_on: ['b', 'c'] }])
    expect(addSkillAt(base, 'z', { kind: 'before' })).toEqual([{ id: 'z' }, { id: 'a', depends_on: ['z'] }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['a'] }])
    expect(addSkillAt(base, 'p', { kind: 'join', wave: 0 })).toEqual([{ id: 'a' }, { id: 'p' }, { id: 'b', depends_on: ['a', 'p'] }, { id: 'c', depends_on: ['a', 'p'] }])
    expect(addSkillAt(base, 'q', { kind: 'join', wave: 1 })).toEqual([{ id: 'a' }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['a'] }, { id: 'q', depends_on: ['a'] }])
    expect(appendSerial([], 'solo')).toEqual([{ id: 'solo' }])
    expect(addSkillAt(base, 'a', { kind: 'after' })).toEqual(base)
  })
})

describe('SkillFlow · 组件', () => {
  it('skillsSignature：只看 id 与 depends_on，顺序无关的依赖列表签名相同', () => {
    expect(skillsSignature([{ id: 'a', depends_on: ['x', 'y'] }])).toBe(skillsSignature([{ id: 'a', depends_on: ['y', 'x'] }]))
    expect(skillsSignature([{ id: 'a' }])).not.toBe(skillsSignature([{ id: 'a', depends_on: ['b'] }]))
  })
  it('只读：每个技能一个节点，边 = depends_on；起点 / 终点与波次标签是画出来的；点节点名打开详情；没有 × ', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[{ name: 'brainstorming', installed: true, source: 'external-marketplace', description: '把想法聊成设计' }]} editable={false} onOpen={onOpen} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-nodes', '3')
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-edges', '2')
    expect(screen.getByTestId('flow-start')).toHaveTextContent('起点')
    expect(screen.getByTestId('flow-end')).toHaveTextContent('终点')
    expect(screen.getAllByTestId('flow-wave-label').map((label) => label.textContent)).toEqual(['第 1 步', '第 2 步 · 并行 2'])
    const rendered = screen.getByTestId('react-flow').getAttribute('data-edges') ?? ''
    expect(rendered).toContain('start->tenon-explore')
    expect(rendered).toContain('brainstorming->end')
    expect(rendered).not.toContain('tenon-explore->end')
    expect(rendered).toContain('tenon-explore->j0')
    expect(rendered).toContain('j0->brainstorming')
    expect(rendered).not.toContain('tenon-explore->brainstorming,')
    expect(screen.getByTestId('flow-junction')).toBeInTheDocument()
    // 节点只显示名称；描述不占节点，只作为可访问描述（H7）。
    const open = screen.getByTestId('flow-open-brainstorming')
    expect(open).toHaveAccessibleName('brainstorming')
    expect(open).toHaveAccessibleDescription('把想法聊成设计')
    expect(open).not.toHaveTextContent('把想法聊成设计')
    expect(screen.getByTestId('flow-desc-brainstorming')).toHaveClass('sr-only')
    expect(screen.queryByTestId('flow-remove-brainstorming')).toBeNull()
    await user.click(screen.getByTestId('flow-open-brainstorming'))
    expect(onOpen).toHaveBeenCalledWith('brainstorming')
  })
  it('可编辑：× 移除节点并连带删边，onChange 收到新技能数组', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable onChange={onChange} onOpen={() => undefined} /></I18nProvider>)
    await user.click(screen.getByTestId('flow-remove-tenon-explore'))
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-nodes', '2')
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-edges', '0')
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'brainstorming' }, { id: 'grill-with-docs' }])
  })
  // 回归：首次挂载时 nodes 还是空的，写回 effect 看到空图与传入技能不同就 onChange([])；
  // 父组件持有状态时技能被清空，接着布局又写回，来回循环。首次布局完成前不得写回。
  it('可编辑 + 有状态父组件：挂载不回写空图，不清空、不循环', () => {
    const onChange = vi.fn()
    function Parent(): JSX.Element {
      const [skills, setSkills] = useState<WbSkillRef[]>(SKILLS)
      return (
        <I18nProvider>
          <SkillFlow skills={skills} registry={[]} editable onChange={(next) => { onChange(next); setSkills(next) }} onOpen={() => undefined} />
        </I18nProvider>
      )
    }
    render(<Parent />)
    expect(onChange).not.toHaveBeenCalledWith([])
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(1)
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-nodes', '3')
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-edges', '2')
  })
  it('空态文案：只读「无」，可编辑「拖入技能」', () => {
    const { unmount } = render(<I18nProvider><SkillFlow skills={[]} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow-empty')).toHaveTextContent('无')
    unmount()
    render(<I18nProvider><SkillFlow skills={[]} registry={[]} editable onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow-empty')).toHaveTextContent('拖入技能')
  })
  it('画布控件的 aria-label 跟随界面语言，而不是 React Flow 自带的英文', () => {
    const { unmount } = render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    const zh = JSON.parse(screen.getByTestId('react-flow').getAttribute('data-aria-labels') ?? '{}') as Record<string, string>
    expect(zh['controls.zoomIn.ariaLabel']).toBe('放大')
    expect(zh['controls.zoomOut.ariaLabel']).toBe('缩小')
    expect(zh['controls.fitView.ariaLabel']).toBe('适应画布')
    unmount()
    localStorage.setItem('tenon-dashboard-lang', 'en')
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    const en = JSON.parse(screen.getByTestId('react-flow').getAttribute('data-aria-labels') ?? '{}') as Record<string, string>
    expect(en['controls.zoomIn.ariaLabel']).toBe('Zoom in')
    localStorage.removeItem('tenon-dashboard-lang')
  })
})

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduce : !reduce,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

describe('SkillFlow · 节点与点阵外观', () => {
  it('波次标签用无衬线 + 等宽数字；节点名常规字体 Inter 500（不再 mono）；节点细描边走 --flow-node-border；连接点是 1px 句柄 + 悬停才出现的 6px 圆点', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    const label = screen.getAllByTestId('flow-wave-label')[0]!
    expect(label.className).toContain('font-sans')
    expect(label.className).toContain('tabular-nums')
    expect(label.className).not.toContain('font-mono')
    const name = screen.getByTestId('flow-name-brainstorming')
    expect(name.className).toContain('font-sans')
    expect(name.className).toContain('font-medium')
    expect(name.className).not.toContain('font-mono')
    expect(name.className).not.toContain('font-semibold')
    const node = screen.getByTestId('flow-node-brainstorming')
    expect(node.className).toContain('border-(--flow-node-border)')
    expect(node.className).not.toContain('border-border-2')
    expect(node.className).toContain('group')
    expect(node).toHaveAttribute('data-flow-node', 'brainstorming')
    expect(node).toHaveAttribute('data-transit', '260')
    // 到达反馈：边框 + 光晕层、顶端端口点，都是预渲染的 opacity 层。
    expect(node.querySelector('[data-signal-flash]')).not.toBeNull()
    expect(node.querySelector('[data-signal-port]')).not.toBeNull()
  })

  it('长名按段缩写（首段…末段，见 fitName.test）：整名在 title，样式兜底在末尾截断，不拆块', () => {
    render(<I18nProvider><SkillFlow skills={[{ id: 'test-driven-development' }]} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    const name = screen.getByTestId('flow-name-test-driven-development').querySelector('[title="test-driven-development"]')!
    expect(name.children).toHaveLength(0)
    expect(name.textContent).toBe('test-driven-development')
    expect(name).toHaveClass('truncate', 'whitespace-nowrap', 'min-w-0', 'flex-1')
  })

  it('点阵淡：颜色取 --border、间距 18', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('flow-background')).toHaveAttribute('data-gap', '18')
    expect(screen.getByTestId('flow-background')).toHaveAttribute('data-color', 'var(--border)')
  })

  it('串行的每一跳不画箭头：箭头只在汇入下一步的边与终点；所有线都是 signal 类型，未运行时都是 todo', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    const flow = screen.getByTestId('react-flow')
    const ids = (flow.getAttribute('data-edges') ?? '').split(',')
    const arrows = (flow.getAttribute('data-edge-arrows') ?? '').split(',')
    const arrowOf = (id: string): string | undefined => arrows[ids.indexOf(id)]
    expect(arrowOf('start->tenon-explore')).toBe('0')
    expect(arrowOf('tenon-explore->j0')).toBe('0')
    expect(arrowOf('j0->brainstorming')).toBe('1')
    expect(arrowOf('j0->grill-with-docs')).toBe('1')
    expect(arrowOf('grill-with-docs->end')).toBe('1')
    expect(new Set((flow.getAttribute('data-edge-states') ?? '').split(','))).toEqual(new Set(['todo']))
  })

  it('线三态：接入已完成的节点 = done，接入运行中的节点 = live', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} statusOf={(id) => (id === 'tenon-explore' ? { state: 'done', label: '完成' } : id === 'brainstorming' ? { state: 'running', label: '运行中' } : null)} /></I18nProvider>)
    const flow = screen.getByTestId('react-flow')
    const ids = (flow.getAttribute('data-edges') ?? '').split(',')
    const states = (flow.getAttribute('data-edge-states') ?? '').split(',')
    const stateOf = (id: string): string | undefined => states[ids.indexOf(id)]
    expect(stateOf('start->tenon-explore')).toBe('done')
    expect(stateOf('tenon-explore->j0')).toBe('done')
    expect(stateOf('j0->brainstorming')).toBe('live')
    expect(stateOf('j0->grill-with-docs')).toBe('todo')
  })

  it('起终点实心：起点强调色、终点灰；起点放光环、终点收光环', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('flow-end-dot')).toHaveClass('rounded-full', 'bg-text-3')
    expect(screen.getByTestId('flow-start-dot')).toHaveClass('rounded-full', 'bg-(--accent)')
    expect(screen.getByTestId('flow-end').querySelector('[data-signal-ring]')).not.toBeNull()
    expect(screen.getByTestId('flow-start').querySelector('[data-signal-ring]')).not.toBeNull()
  })
})

describe('SkillFlow · 画布尺寸与取景', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('canvasHeight：max(160, 行数 × 行距 + 64)；按最高一波的行数与每个节点的行数增高', () => {
    expect(canvasHeight(0)).toBe(160)
    expect(canvasHeight(1)).toBe(160)
    expect(canvasHeight(2)).toBe(2 * 64 + 64)
    expect(canvasHeight(3)).toBe(3 * 64 + 64)
    expect(canvasHeight(3, 3)).toBeGreaterThan(canvasHeight(3))
    expect(canvasHeight(4)).toBeGreaterThan(canvasHeight(3))
    expect(lanesOf(SKILLS)).toBe(2)
    expect(lanesOf([])).toBe(0)
  })

  it('layoutSkills：行距跟随节点行数，节点不重叠', () => {
    const one = layoutSkills(SKILLS)
    const three = layoutSkills(SKILLS, 3)
    expect(one[2]!.y - one[1]!.y).toBe(64)
    expect(three[2]!.y - three[1]!.y).toBe(104)
  })

  it('editViewport：放得下就缩放居中；缩到下限仍放不下就靠左对齐，不两头裁', () => {
    const range = { min: 0.75, max: 1 }
    // 窄内容：缩放 1，居中。
    expect(editViewport({ x: 0, y: 0, width: 200, height: 100 }, { width: 640, height: 400 }, range, 24)).toEqual({ x: 220, y: 150, zoom: 1 })
    // 三列串行（宽 1000）：640 宽画布里 fit 需 0.59 < 0.75 → 取 0.75、靠左留 24，首列可见。
    const wide = editViewport({ x: 40, y: 0, width: 1000, height: 100 }, { width: 640, height: 400 }, range, 24)
    expect(wide.zoom).toBe(0.75)
    expect(wide.x + 40 * 0.75).toBe(24)
  })

  it('readOnlyViewport：缩放恒为 1；内容窄则居中，宽则从起点对齐（留 24）', () => {
    expect(readOnlyViewport({ x: 10, y: 20, width: 400, height: 100 }, { width: 800, height: 300 })).toEqual({ x: 190, y: 80, zoom: 1 })
    expect(readOnlyViewport({ x: 10, y: 20, width: 1200, height: 100 }, { width: 800, height: 300 })).toEqual({ x: 14, y: 80, zoom: 1 })
  })

  it('只读画布：缩放上下限都是 1，高度由内容定，控件只留适应画布且走 token 外观', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    const flow = screen.getByTestId('react-flow')
    expect(flow).toHaveAttribute('data-min-zoom', '1')
    expect(flow).toHaveAttribute('data-max-zoom', '1')
    // 底部留出「适应」按钮的带高：按钮不压节点。
    expect(screen.getByTestId('skill-flow').style.height).toBe(`${canvasHeight(2) + CONTROLS_BAND}px`)
    const controls = screen.getByTestId('flow-controls')
    expect(controls).toHaveAttribute('data-show-zoom', 'false')
    for (const token of ['!bg-card', '!border-border', '[&>button]:!size-10']) expect(controls.className).toContain(token)
    expect(CONTROLS_CLASS).not.toMatch(/#[0-9a-f]{3,6}/iu)
  })

  it('可编辑画布：允许 0.75–1.5 缩放，高度交给容器，控件带缩放按钮', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable onChange={() => undefined} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-min-zoom', '0.75')
    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-max-zoom', '1.5')
    expect(screen.getByTestId('skill-flow').style.height).toBe('')
    expect(screen.getByTestId('flow-controls')).toHaveAttribute('data-show-zoom', 'true')
  })

  it('尺寸变化：ResizeObserver 节流后按 1:1 重新取景；减少动态效果时 duration 为 0', () => {
    vi.useFakeTimers()
    stubMatchMedia(true)
    // 节点名称（FitName）也各有一个观察者：只取观察画布容器的那个。
    const observed: Array<{ readonly callback: () => void; readonly element: Element }> = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: () => void
      constructor(callback: () => void) { this.callback = callback }
      observe(element: Element): void { observed.push({ callback: this.callback, element }) }
      disconnect(): void {}
    })
    const setViewport = vi.spyOn(useReactFlow(), 'setViewport')
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    act(() => { vi.advanceTimersByTime(100) })
    setViewport.mockClear()
    const resize = observed.find((item) => item.element.getAttribute('data-testid') === 'skill-flow')!.callback
    act(() => { resize() })
    act(() => { vi.advanceTimersByTime(RESIZE_THROTTLE_MS) })
    expect(setViewport).not.toHaveBeenCalled()
    act(() => { resize(); resize(); resize() })
    act(() => { vi.advanceTimersByTime(RESIZE_THROTTLE_MS) })
    expect(setViewport).toHaveBeenCalledTimes(1)
    expect(setViewport.mock.calls[0]![0]).toMatchObject({ zoom: 1 })
    expect(setViewport.mock.calls[0]![1]).toEqual({ duration: 0 })
  })

  it('可编辑画布的重新取景走 editViewport：缩放在 [0.75, 1]，不调用会居中裁切的 fitView', () => {
    vi.useFakeTimers()
    stubMatchMedia(false)
    const flow = useReactFlow()
    const fitView = vi.spyOn(flow, 'fitView')
    const setViewport = vi.spyOn(flow, 'setViewport')
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable onChange={() => undefined} onOpen={() => undefined} /></I18nProvider>)
    act(() => { vi.advanceTimersByTime(100) })
    expect(fitView).not.toHaveBeenCalled()
    const [viewport, options] = setViewport.mock.calls.at(-1) ?? []
    expect(viewport?.zoom).toBeGreaterThanOrEqual(0.75)
    expect(viewport?.zoom).toBeLessThanOrEqual(1)
    expect(options).toEqual({ duration: 0 })
  })

  it('切换阶段（挂载后的第一次取景）瞬时；之后编辑技能再取景用 200ms', () => {
    vi.useFakeTimers()
    stubMatchMedia(false)
    const setViewport = vi.spyOn(useReactFlow(), 'setViewport')
    const { rerender } = render(<I18nProvider><SkillFlow key="explore" skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    act(() => { vi.advanceTimersByTime(100) })
    expect(setViewport).toHaveBeenCalledTimes(1)
    expect(setViewport.mock.calls[0]![1]).toEqual({ duration: 0 })
    rerender(<I18nProvider><SkillFlow key="explore" skills={[...SKILLS, { id: 'handoff', depends_on: ['brainstorming'] }]} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    act(() => { vi.advanceTimersByTime(100) })
    expect(setViewport.mock.calls.at(-1)![1]).toEqual({ duration: REFIT_MS })
    setViewport.mockClear()
    rerender(<I18nProvider><SkillFlow key="spec" skills={[{ id: 'tenon-spec' }]} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    act(() => { vi.advanceTimersByTime(100) })
    expect(setViewport.mock.calls.map((call) => call[1])).toEqual([{ duration: 0 }])
  })
})

describe('SkillFlow · Signal 只在该动时动', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  // 用户规则：信号持续从起点流到终点；空闲画布也在流（慢速环境流），不能只在运行 / 编辑后才动。
  it('signalModeOf：看不见就停；阻塞或减少动态效果只留静态；在跑用运行流，否则环境流', () => {
    expect(signalModeOf({ visible: true, running: false, blocked: false })).toBe('ambient')
    expect(signalModeOf({ visible: true, running: true, blocked: false })).toBe('running')
    expect(signalModeOf({ visible: false, running: true, blocked: false })).toBe('off')
    expect(signalModeOf({ visible: true, running: false, blocked: false, reduced: true })).toBe('still')
  })

  it('只读、未运行的画布也在流（环境流）；每条线带彗星层', () => {
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-signal', 'ambient')
    expect(Number(screen.getByTestId('react-flow').getAttribute('data-edge-signals'))).toBeGreaterThan(0)
  })

  it('有技能在运行 = 运行流；画布离开视口时停', () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(callback) } observe(): void {} disconnect(): void {} })
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} statusOf={() => ({ state: 'running', label: '进行中' })} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-signal', 'running')
    act(() => { observers[observers.length - 1]!([{ isIntersecting: false }]) })
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-signal', 'off')
    expect(screen.getByTestId('react-flow').getAttribute('data-edge-signals')).toBe('0')
  })

  it('系统要求减少动态效果：不流动，不渲染彗星层，只剩静态高亮', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }))
    render(<I18nProvider><SkillFlow skills={SKILLS} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow')).toHaveAttribute('data-signal', 'still')
    expect(screen.getByTestId('react-flow').getAttribute('data-edge-signals')).toBe('0')
  })
})
