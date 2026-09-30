import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { orchestrate } from '@tenon/kernel/workflow/orchestration'
import type { FlowStage } from '../api/workflowOrchestrationClient'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { OrchestrationFlow } from './OrchestrationFlow'
import { entryNodeId, layoutOrchestration, stageNodeId } from './orchestrationLayout'
import { planSignal } from './flowSignal'
import { draftOrchestration } from './draftOrchestration'
import { setTestZoom, viewportCalls } from './reactFlowTestDouble'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const entry = (kind: 'executor' | 'skill' | 'test' | 'reviewer', id: string, wave: number, dependsOn: string[] = [], extra: Partial<FlowStage['entries'][number]> = {}) =>
  ({ kind, id, label: id, wave, dependsOn, required: true, source: 'declared' as const, ...extra })

const STAGES: FlowStage[] = [
  { id: 'open', label: '立项', gate: null, entries: [entry('skill', 'openspec-propose', 0, [], { source: 'openspec' })] },
  {
    id: 'explore', label: '调研', gate: 'review', entries: [
      entry('skill', 'openspec-explore', 0),
      entry('skill', 'brainstorming', 1, ['openspec-explore']),
      entry('skill', 'grilling', 1, ['openspec-explore']),
      entry('skill', 'domain-modeling', 2, ['brainstorming', 'grilling']),
    ],
  },
  {
    id: 'verify', label: '验证', gate: 'review', entries: [
      entry('skill', 'browser-qa', 0),
      entry('test', 'playwright', 1),
      entry('reviewer', 'security', 2),
      entry('reviewer', 'e2e', 2),
      entry('reviewer', 'architecture', 3, ['security', 'e2e'], { required: false }),
    ],
  },
]
const RETURNS = [{ from: 'verify', to: 'explore', event: 'verify-fail' }]
const FLOWS = [{ slot: 'document' as const, id: 'proposal', from: 'open', producers: ['openspec-propose'], to: ['explore', 'verify'] }]

function renderFlow(props: Partial<Parameters<typeof OrchestrationFlow>[0]> = {}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <OrchestrationFlow mode="overview" stages={STAGES} returns={RETURNS} flows={FLOWS} ariaLabel="总览" {...props} />
      </TooltipProvider>
    </I18nProvider>,
  )
}

describe('layoutOrchestration · 纯布局', () => {
  it('列内按位次自上而下，同一位次的并行条目在列内纵向堆叠；阶段列从左到右', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const at = (stage: string, kind: 'skill' | 'test' | 'reviewer', id: string) => layout.entries.find((item) => item.id === entryNodeId(stage, { kind, id }))
    const explore = ['openspec-explore', 'brainstorming', 'grilling', 'domain-modeling'].map((id) => at('explore', 'skill', id))
    expect(explore[0]!.y).toBeLessThan(explore[1]!.y)
    // 并行的两个技能：同一列（x 相同）、先后堆叠，不横排。
    expect(explore[1]!.x).toBe(explore[2]!.x)
    expect(explore[1]!.y).toBeLessThan(explore[2]!.y)
    expect(explore[3]!.y).toBeGreaterThan(explore[2]!.y)
    const frames = layout.stages.map((stage) => stage.x)
    expect([...frames].sort((a, b) => a - b)).toEqual(frames)
    // 身份顺序：技能 → 测试 → 评审者。
    expect(at('verify', 'skill', 'browser-qa')!.y).toBeLessThan(at('verify', 'test', 'playwright')!.y)
    expect(at('verify', 'test', 'playwright')!.y).toBeLessThan(at('verify', 'reviewer', 'security')!.y)
  })

  it('列宽恒为一个条目宽：并行再多（验证的评审者）也不撑宽阶段框，条目不重叠', () => {
    const many: FlowStage = {
      id: 'verify', label: '验证', gate: 'review', entries: [
        entry('skill', 'browser-qa', 0), entry('test', 'playwright', 1), entry('test', 'code-size', 1),
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry('reviewer', id, 2)),
      ],
    }
    const layout = layoutOrchestration([STAGES[0]!, many], 'overview')
    expect(new Set(layout.stages.map((stage) => stage.width)).size).toBe(1)
    const inVerify = layout.entries.filter((item) => item.stage === 'verify')
    expect(new Set(inVerify.map((item) => item.x)).size).toBe(1)
    const sorted = [...inVerify].sort((a, b) => a.y - b.y)
    sorted.slice(1).forEach((item, index) => expect(item.y).toBeGreaterThanOrEqual(sorted[index]!.y + sorted[index]!.height))
    const frame = layout.stages.find((stage) => stage.id === stageNodeId('verify'))!
    expect(Math.max(...inVerify.map((item) => item.y + item.height))).toBeLessThan(frame.y + frame.height)
    expect(layout.height).toBe(frame.height)
  })

  it('主线：起点 → 各阶段列头 → 终点；一对一直连，一对多 / 多对一经列外轨道上的汇合点，不穿过条目', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const ids = layout.edges.map((edge) => edge.id)
    expect(ids).toContain(`start->${stageNodeId('open')}`)
    expect(ids).toContain(`${stageNodeId('open')}->${stageNodeId('explore')}`)
    expect(ids).toContain(`${stageNodeId('verify')}->end`)
    const skill = (id: string) => entryNodeId('explore', { kind: 'skill', id })
    // 调研：openspec-explore → (brainstorming ∥ grilling) → domain-modeling，经左轨扇出、右轨汇入。
    const fork = 'j:explore:skill:1:in'
    const join = 'j:explore:skill:2:out'
    expect(ids).toEqual(expect.arrayContaining([
      `${skill('openspec-explore')}->${fork}`, `${fork}->${skill('brainstorming')}`, `${fork}->${skill('grilling')}`,
      `${skill('brainstorming')}->${join}`, `${skill('grilling')}->${join}`, `${join}->${skill('domain-modeling')}`,
    ]))
    expect(ids).not.toContain(`${skill('openspec-explore')}->${skill('grilling')}`)
    const edgeOf = (id: string) => layout.edges.find((edge) => edge.id === id)
    expect(edgeOf(`${fork}->${skill('grilling')}`)).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'left', arrow: true })
    expect(edgeOf(`${skill('grilling')}->${join}`)).toMatchObject({ sourceHandle: 'right', targetHandle: 'top', arrow: false })
    // 汇合点都在列外：左轨在条目左缘之外，右轨在右缘之外。
    const column = layout.entries.filter((item) => item.stage === 'explore')
    const left = Math.min(...column.map((item) => item.x))
    const right = Math.max(...column.map((item) => item.x + item.width))
    const point = (id: string) => layout.junctions.find((item) => item.id === id)!
    expect(point(fork).x + 1).toBeLessThan(left)
    expect(point(join).x + 1).toBeGreaterThan(right)
    // 两组各多于一个时：右轨汇入 → 横穿空隙 → 左轨扇出。
    const fan = layoutOrchestration([{ id: 's', label: 's', gate: null, entries: [entry('skill', 'a', 0), entry('skill', 'b', 0, [], {}), entry('reviewer', 'r1', 1), entry('reviewer', 'r2', 1)] }], 'stage')
    expect(fan.junctions.map((item) => item.id)).toEqual(['j:s:skill:0:in', 'j:s:reviewer:0:out', 'j:s:reviewer:0:in', 'j:end:out'])
    expect(fan.edges.find((edge) => edge.id === 'j:s:reviewer:0:out->j:s:reviewer:0:in')).toMatchObject({ arrow: false })
  })

  it('扇出 / 汇入不交叉：汇合点不落在任何条目里，同一列的条目竖直方向不重叠', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    for (const junction of layout.junctions) {
      for (const box of layout.entries) {
        const inside = junction.x >= box.x && junction.x <= box.x + box.width && junction.y >= box.y && junction.y <= box.y + box.height
        expect(inside).toBe(false)
      }
    }
    for (const stage of STAGES) {
      const boxes = layout.entries.filter((item) => item.stage === stage.id).sort((a, b) => a.y - b.y)
      boxes.slice(1).forEach((item, index) => expect(item.y).toBeGreaterThanOrEqual(boxes[index]!.y + boxes[index]!.height))
    }
  })

  it('箭头：串行的每一跳不画，只在汇入条目的那一跳（轨道汇合点 → 条目）与终点各画一个', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const arrows = layout.edges.filter((edge) => edge.arrow).map((edge) => edge.id)
    expect(arrows).toContain(`${stageNodeId('verify')}->end`)
    // 主线的每一跳（起点 → 标题 → 标题）没有箭头。
    expect(layout.edges.find((edge) => edge.id === `start->${stageNodeId('open')}`)?.arrow).toBe(false)
    expect(layout.edges.find((edge) => edge.id === `${stageNodeId('open')}->${stageNodeId('explore')}`)?.arrow).toBe(false)
    // 一对一直连（调研的第一技能 → 头一个条目）没有箭头；汇入条目的边有。
    const direct = layout.edges.filter((edge) => !edge.target.startsWith('j:') && !edge.source.startsWith('j:') && edge.target.startsWith('e:'))
    expect(direct.length).toBeGreaterThan(0)
    for (const edge of direct) expect(edge.arrow, edge.id).toBe(false)
    for (const edge of layout.edges.filter((item) => item.source.startsWith('j:') && item.target.startsWith('e:'))) expect(edge.arrow, edge.id).toBe(true)
    // 每张画布恰好一个终点提示：阶段模式同理。
    const stage = layoutOrchestration([STAGES[2]!], 'stage')
    expect(stage.edges.filter((edge) => edge.target === 'end').every((edge) => edge.arrow)).toBe(true)
  })

  it('信号沿这些边从起点一路到终点，按真实执行顺序一列一列过：标题到达距离递增，终点最大；列内条目在自己标题之后到达；主线下一跳等上一列走完', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const center = (id: string) => {
      const box = [...layout.stages, ...layout.entries, ...layout.junctions.map((item) => ({ ...item, width: 2, height: 2 }))].find((item) => item.id === id)
      if (box !== undefined) return { x: box.x + ('width' in box ? box.width : 0) / 2, y: box.y + ('height' in box ? box.height : 0) / 2 }
      const port = id === 'start' ? layout.ports.start : layout.ports.end
      return { x: port.x + 6, y: port.y + 6 }
    }
    const edges = layout.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, length: Math.hypot(center(edge.target).x - center(edge.source).x, center(edge.target).y - center(edge.source).y), ...(edge.lead === undefined ? {} : { lead: edge.lead }), ...(edge.after === undefined ? {} : { after: edge.after }) }))
    const nodes = [{ id: 'start', transit: 12 }, { id: 'end', transit: 12 }, ...layout.stages.map((stage) => ({ id: stage.id, transit: stage.width })), ...layout.entries.map((entry) => ({ id: entry.id, transit: entry.height })), ...layout.junctions.map((item) => ({ id: item.id, transit: 0 }))]
    const plan = planSignal(edges, nodes)
    const heads = ['open', 'explore', 'verify'].map((id) => plan.arrival.get(stageNodeId(id))!)
    expect([...heads].sort((a, b) => a - b)).toEqual(heads)
    expect(plan.arrival.get('end')!).toBeGreaterThan(Math.max(...heads))
    for (const item of layout.entries) expect(plan.arrival.get(item.id)!, item.id).toBeGreaterThan(plan.arrival.get(stageNodeId(item.stage))!)
    // 进一列、走完这一列、再去下一列：下一个标题晚于上一列的所有条目（它们走完之后才出主线）。
    const nextHeader = (stage: string, next: string): void => {
      for (const item of layout.entries.filter((candidate) => candidate.stage === stage)) expect(plan.arrival.get(stageNodeId(next))!, `${stage}→${next} 晚于 ${item.id}`).toBeGreaterThan(plan.arrival.get(item.id)!)
    }
    nextHeader('open', 'explore')
    nextHeader('explore', 'verify')
    expect(plan.arrival.get('end')!).toBeGreaterThan(Math.max(...layout.entries.filter((item) => item.stage === 'verify').map((item) => plan.arrival.get(item.id)!)))
    expect(layout.edges.find((edge) => edge.id === `${stageNodeId('explore')}->${stageNodeId('verify')}`)?.after?.length).toBeGreaterThan(0)
    // 标题往下走的那一跳只算一个标题高度，主线那一跳才穿过整个标题的宽度。
    const down = layout.edges.filter((edge) => edge.source === stageNodeId('explore') && edge.target.startsWith('e:'))
    expect(down.length).toBeGreaterThan(0)
    expect(down.every((edge) => edge.lead === 40)).toBe(true)
    expect(layout.edges.find((edge) => edge.id === `${stageNodeId('explore')}->${stageNodeId('verify')}`)?.lead).toBeUndefined()
  })

  it('列带无边框、高度贴内容：只有一个条目的立项不再撑到最高一列那么高', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const heights = layout.stages.map((stage) => stage.height)
    expect(new Set(heights).size).toBe(3)
    expect(layout.stages[0]!.height).toBeLessThan(layout.stages[1]!.height)
    expect(layout.stages[0]!.height).toBeLessThan(layout.stages[2]!.height)
    expect(layout.height).toBe(Math.max(...heights))
  })

  it('节点尺寸：总览视觉 184×32，阶段画布 320×40；汇合点轨道离条目 12px', () => {
    const overview = layoutOrchestration(STAGES, 'overview')
    expect(overview.entries.every((item) => item.width === 184 && item.height === 32)).toBe(true)
    const stage = layoutOrchestration([STAGES[2]!], 'stage')
    expect(stage.entries.every((item) => item.width === 320 && item.height === 40)).toBe(true)
    const fork = overview.junctions.find((item) => item.id === 'j:explore:skill:1:in')!
    const entry = overview.entries.find((item) => item.id === entryNodeId('explore', { kind: 'skill', id: 'brainstorming' }))!
    expect(entry.x - (fork.x + 1)).toBe(12)
  })

  it('阶段模式：分组标题在节点上方、左对齐；起点在列顶、终点在列底；可编辑时有动作的空泳道留一个「＋」占位', () => {
    const stage = STAGES[2]!
    const layout = layoutOrchestration([stage], 'stage', { showEmpty: ['executor'] })
    expect(layout.lanes.map((lane) => [lane.kind, lane.count])).toEqual([['executor', 0], ['skill', 1], ['test', 1], ['reviewer', 3]])
    expect(layout.ghosts.map((ghost) => ghost.kind)).toEqual(['executor'])
    expect(layout.ports.start.y).toBeLessThan(Math.min(...layout.entries.map((item) => item.y)))
    expect(layout.ports.end.y).toBeGreaterThan(Math.max(...layout.entries.map((item) => item.y)))
    // 分组标题：x 与条目同为 0（左对齐），高 24，在自己第一个条目上方 8px；不再是左侧浮动的标签。
    for (const lane of layout.lanes) {
      expect(lane.x).toBe(0)
      expect(lane.height).toBe(24)
      const first = layout.entries.filter((item) => item.entry.kind === lane.kind).sort((a, b) => a.y - b.y)[0]
      if (first !== undefined) expect(first.y - (lane.y + lane.height)).toBe(8)
    }
    const empty = layoutOrchestration([stage], 'stage')
    expect(empty.lanes.map((lane) => lane.kind)).toEqual(['skill', 'test', 'reviewer'])
    expect(empty.ghosts).toEqual([])
    // 上下留白由取景补 24：布局自己贴着内容（起点顶在 0，终点底 = 高度）。
    expect(layout.ports.start.y).toBe(0)
    expect(layout.height).toBe(layout.ports.end.y + 12)
  })

  it('性能：7 阶段 × 30 节点，布局 + 首次渲染在 300ms 内', () => {
    const big: FlowStage[] = Array.from({ length: 7 }, (_, stageIndex) => ({
      id: `s${stageIndex}`,
      label: `阶段 ${stageIndex}`,
      gate: stageIndex % 2 === 0 ? 'review' : null,
      entries: Array.from({ length: 30 }, (_unused, index) => entry(index < 3 ? 'executor' : index < 20 ? 'skill' : index < 24 ? 'test' : 'reviewer', `n${index}`, Math.floor(index / 3))),
    }))
    const layoutStarted = performance.now()
    layoutOrchestration(big, 'overview')
    expect(performance.now() - layoutStarted).toBeLessThan(50)
    // jsdom 与并行测试的调度噪声远大于浏览器里的差异：预热一次，取三次里最快的一次。
    renderFlow({ stages: big, returns: [], flows: [] }).unmount()
    const samples = [0, 1, 2].map(() => {
      const started = performance.now()
      const view = renderFlow({ stages: big, returns: [], flows: [] })
      const elapsed = performance.now() - started
      expect(screen.getByTestId('orchestration-overview')).toHaveAttribute('data-nodes', '210')
      view.unmount()
      return elapsed
    })
    expect(Math.min(...samples)).toBeLessThan(300)
  })
})

describe('OrchestrationFlow · 总览', () => {
  it('每阶段一条列带：无边框的实色 4% 底，列头有序号、名称与门禁图标；回流是列头之间的虚线弧', () => {
    renderFlow()
    const canvas = screen.getByTestId('orchestration-overview')
    expect(canvas).toHaveAttribute('aria-label', '总览')
    expect(within(canvas).getByTestId('orch-stage-explore')).toHaveTextContent('2调研')
    const band = within(canvas).getByTestId('orch-frame-explore')
    expect(band.className).not.toContain('border')
    expect(band.style.background).toBe('var(--flow-band)')
    expect(within(band).getByTestId('orch-gate')).toHaveAttribute('data-gate', 'review')
    expect(within(within(canvas).getByTestId('orch-frame-open')).queryByTestId('orch-gate')).toBeNull()
    const edges = within(canvas).getByTestId('react-flow').getAttribute('data-edges') ?? ''
    expect(edges.split(',')).toContain('return:verify->explore')
    // 起点、终点是实心圆点。
    expect(within(canvas).getByTestId('orch-start-dot').className).toContain('bg-(--accent)')
    expect(within(canvas).getByTestId('orch-end-dot').className).toContain('bg-text-3')
    expect(within(canvas).getByTestId('orch-end').querySelector('[data-signal-ring]')).not.toBeNull()
    // 没有点阵背景。
    expect(within(canvas).queryByTestId('flow-background')).toBeNull()
  })

  it('可缩放范围：最小 0.5（再小连符号都糊了）、最大 1.5；阶段画布恒为 1:1', () => {
    renderFlow()
    const flow = within(screen.getByTestId('orchestration-overview')).getByTestId('react-flow')
    expect(flow).toHaveAttribute('data-min-zoom', '0.5')
    expect(flow).toHaveAttribute('data-max-zoom', '1.5')
    cleanup()
    renderFlow({ mode: 'stage', stages: [STAGES[2]!], returns: [], flows: [] })
    const stage = within(screen.getByTestId('orchestration-stage')).getByTestId('react-flow')
    expect([stage.getAttribute('data-min-zoom'), stage.getAttribute('data-max-zoom')]).toEqual(['1', '1'])
  })

  it('Signal 持续流动（空闲画布也流，与运行与否无关）：每条线带彗星层', () => {
    renderFlow()
    const canvas = screen.getByTestId('orchestration-overview')
    expect(canvas).toHaveAttribute('data-signal', 'ambient')
    const flow = within(canvas).getByTestId('react-flow')
    // 回流弧不是信号线：其余每条线都带四层彗星。
    const total = (flow.getAttribute('data-edges') ?? '').split(',').filter((id) => !id.startsWith('return:')).length
    expect(flow.getAttribute('data-edge-signals')).toBe(String(total))
  })

  it('来源与必需：OpenSpec 注入换契约图标；参考评审者虚线框', () => {
    renderFlow()
    expect(screen.getByTestId('orch-node-skill-openspec-propose')).toHaveAttribute('data-source', 'openspec')
    expect(within(screen.getByTestId('orch-node-skill-openspec-propose')).getByTestId('orch-source-openspec')).toBeTruthy()
    expect(screen.getByTestId('orch-node-reviewer-architecture').className).toContain('border-dashed')
    expect(screen.getByTestId('orch-open-reviewer-architecture')).toHaveAttribute('title', 'architecture · 参考')
  })

  it('节点：名称是 Inter 500 14px（不再 mono）、中间截断保尾 6 个字符；类别图标安静；默认状态不写字', () => {
    renderFlow()
    const node = screen.getByTestId('orch-node-skill-openspec-propose')
    const middle = node.querySelector('span[title="openspec-propose"]')!
    expect(middle.className).toContain('font-sans')
    expect(middle.className).toContain('font-medium')
    expect(middle.className).toContain('text-caption')
    expect(middle.className).not.toContain('font-mono')
    expect([...middle.children].map((part) => part.textContent)).toEqual(['openspec-p', 'ropose'])
    // 定义画布没有运行状态：不画状态符号，也没有状态字。
    expect(node.querySelector('[data-testid="flow-glyph"]')).toBeNull()
    expect(within(node).queryByTestId('orch-status')).toBeNull()
    // 热区：视觉 32px，点击区由伪元素补到 40px。
    expect(screen.getByTestId('orch-open-skill-openspec-propose').className).toContain('before:-inset-y-1')
  })

  it('悬停列头：读取它输出的阶段框高亮；缩得能读清时点列头进入该阶段', async () => {
    const onOpenStage = vi.fn()
    renderFlow({ onOpenStage })
    fireEvent.mouseEnter(screen.getByTestId('orch-stage-open'))
    expect(screen.getByTestId('orch-frame-explore')).toHaveAttribute('data-consumer', 'true')
    expect(screen.getByTestId('orch-frame-verify')).toHaveAttribute('data-consumer', 'true')
    expect(screen.getByTestId('orch-frame-open')).not.toHaveAttribute('data-consumer')
    fireEvent.mouseLeave(screen.getByTestId('orch-stage-open'))
    expect(screen.getByTestId('orch-frame-explore')).not.toHaveAttribute('data-consumer')
    await userEvent.click(screen.getByTestId('orch-stage-verify'))
    expect(onOpenStage).toHaveBeenCalledWith('verify')
  })

  describe('语义缩放与点列头放大', () => {
    afterEach(() => { setTestZoom(1); viewportCalls.length = 0 })

    it('< 0.7 只显示符号（名称不渲染）；1 显示名称；≥ 1.25 再显示元信息（运行中 / 失败 / 过期的状态字）', () => {
      const withStatus: FlowStage[] = [{ id: 'build', label: '实现', gate: null, entries: [{ ...entry('skill', 'alpha', 0), status: 'running' }, { ...entry('test', 'unit', 1), status: 'failed' }] }]
      setTestZoom(0.6)
      const view = renderFlow({ stages: withStatus, returns: [], flows: [], withStatus: true, current: 'build' })
      expect(document.querySelector('span[title="alpha"]')).toBeNull()
      expect(screen.getAllByTestId('flow-glyph').length).toBe(2)
      view.unmount()
      setTestZoom(1)
      const name = renderFlow({ stages: withStatus, returns: [], flows: [], withStatus: true, current: 'build' })
      expect(document.querySelector('span[title="alpha"]')).not.toBeNull()
      expect(screen.getAllByTestId('orch-status')[0]!.className).toContain('sr-only')
      name.unmount()
      setTestZoom(1.25)
      renderFlow({ stages: withStatus, returns: [], flows: [], withStatus: true, current: 'build' })
      expect(screen.getAllByTestId('orch-status')[0]!.className).not.toContain('sr-only')
    })

    it('缩得很小（只剩符号）时点列头 = 320ms 缓动放大到那一阶段，不进入；之后能读清了再点才进入', async () => {
      const onOpenStage = vi.fn()
      setTestZoom(0.6)
      renderFlow({ onOpenStage })
      await userEvent.click(screen.getByTestId('orch-stage-verify'))
      expect(onOpenStage).not.toHaveBeenCalled()
      const zoomed = viewportCalls.at(-1)!
      expect(zoomed.viewport.zoom).toBe(1)
      expect(zoomed.options?.duration).toBe(320)
      expect(typeof zoomed.options?.ease).toBe('function')
      cleanup()
      setTestZoom(1)
      renderFlow({ onOpenStage })
      await userEvent.click(screen.getByTestId('orch-stage-verify'))
      expect(onOpenStage).toHaveBeenCalledWith('verify')
    })
  })

  it('控件收为左下角一行；全屏：控件切换铺满视口，Esc 退出；缩放控件在', async () => {
    renderFlow()
    const canvas = screen.getByTestId('orchestration-overview')
    expect(within(canvas).getByTestId('flow-controls')).toHaveAttribute('data-show-zoom', 'true')
    expect(within(canvas).getByTestId('flow-controls')).toHaveAttribute('data-orientation', 'horizontal')
    expect(within(canvas).getByTestId('flow-controls')).toHaveAttribute('data-position', 'bottom-left')
    await userEvent.click(screen.getByTestId('orchestration-fullscreen'))
    expect(canvas).toHaveAttribute('data-expanded', 'true')
    expect(canvas.className).toContain('fixed')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(canvas).not.toHaveAttribute('data-expanded')
  })

  it('阶段画布没有控件：1:1 左对齐，高度 = 内容 + 上下各 24', () => {
    renderFlow({ mode: 'stage', stages: [STAGES[2]!], returns: [], flows: [] })
    const canvas = screen.getByTestId('orchestration-stage')
    expect(within(canvas).queryByTestId('flow-controls')).toBeNull()
    const layout = layoutOrchestration([STAGES[2]!], 'stage')
    expect(canvas.style.height).toBe(`${layout.height + 48}px`)
  })

  it('运行状态四态：状态符号（形状 + 颜色）——运行中 / 完成 / 等待 / 失败；当前阶段框高亮', () => {
    const withStatus: FlowStage[] = [{
      id: 'build', label: '实现', gate: null, entries: [
        { ...entry('skill', 'a', 0), status: 'done' },
        { ...entry('skill', 'b', 1), status: 'running' },
        { ...entry('test', 'unit', 2), status: 'failed' },
        { ...entry('reviewer', 'r', 3), status: 'waiting' },
      ],
    }]
    renderFlow({ stages: withStatus, returns: [], flows: [], withStatus: true, current: 'build' })
    expect(['skill-a', 'skill-b', 'test-unit', 'reviewer-r'].map((id) => screen.getByTestId(`orch-node-${id}`).getAttribute('data-status'))).toEqual(['done', 'running', 'failed', 'waiting'])
    expect(screen.getAllByTestId('orch-status').map((mark) => mark.textContent)).toEqual(['完成', '运行中', '失败', '等待'])
    expect(screen.getAllByTestId('flow-glyph').map((glyph) => glyph.getAttribute('data-glyph'))).toEqual(['done', 'running', 'failed', 'waiting'])
    // 运行节点：静态强调边框 + 3px 光环 + 旋转弧形符号（替代 animate-pulse 小圆点）。
    const running = screen.getByTestId('orch-node-skill-b')
    expect(running.className).toContain('border-(--accent)')
    expect(running.className).toContain('0_0_0_3px')
    expect(within(running).getByTestId('flow-arc').getAttribute('class')).toContain('animate-[flow-spin_1s_linear_infinite]')
    expect(within(running).getByTestId('flow-arc').getAttribute('class')).toContain('motion-reduce:animate-none')
    expect(screen.getByTestId('orchestration-overview').innerHTML).not.toContain('animate-pulse')
    expect(screen.getByTestId('orch-frame-build')).toHaveAttribute('data-current', 'true')
    // 有节点在跑：运行流。
    expect(screen.getByTestId('orchestration-overview')).toHaveAttribute('data-signal', 'running')
  })

  it('线三态：已完成 = 强调色实线，正接入运行节点 = 强调色，其余中性', () => {
    const withStatus: FlowStage[] = [{
      id: 'build', label: '实现', gate: null, entries: [
        { ...entry('skill', 'a', 0), status: 'done' },
        { ...entry('skill', 'b', 1, ['a']), status: 'running' },
        { ...entry('skill', 'c', 2, ['b']), status: 'waiting' },
      ],
    }]
    renderFlow({ stages: withStatus, returns: [], flows: [], mode: 'stage', withStatus: true, current: 'build' })
    const flow = screen.getByTestId('react-flow')
    const ids = (flow.getAttribute('data-edges') ?? '').split(',')
    const states = (flow.getAttribute('data-edge-states') ?? '').split(',')
    const skill = (id: string) => entryNodeId('build', { kind: 'skill', id })
    expect(states[ids.indexOf(`${skill('a')}->${skill('b')}`)]).toBe('live')
    expect(states[ids.indexOf(`${skill('b')}->${skill('c')}`)]).toBe('todo')
    expect(states[ids.indexOf(`start->${skill('a')}`)]).toBe('done')
  })

  it('评审门拦住（holding）：Signal 停住、门图标围琥珀环、通向门的线尽头一个琥珀短横；总览与阶段画布都是', () => {
    const withStatus: FlowStage[] = [
      { id: 'open', label: '立项', gate: 'auto', entries: [{ ...entry('skill', 'a', 0), status: 'done' }] },
      { id: 'spec', label: '规格', gate: 'review', entries: [{ ...entry('skill', 'b', 0), status: 'done' }] },
      { id: 'build', label: '实现', gate: 'auto', entries: [{ ...entry('skill', 'c', 0), status: 'waiting' }] },
    ]
    renderFlow({ stages: withStatus, returns: [], flows: [], withStatus: true, current: 'spec', holding: 'spec' })
    const canvas = screen.getByTestId('orchestration-overview')
    expect(canvas).toHaveAttribute('data-signal', 'still')
    expect(within(within(canvas).getByTestId('orch-frame-spec')).getByTestId('orch-gate')).toHaveAttribute('data-holding', 'true')
    expect(within(within(canvas).getByTestId('orch-frame-open')).getByTestId('orch-gate')).not.toHaveAttribute('data-holding')
    expect(within(canvas).getByTestId('react-flow')).toHaveAttribute('data-edge-holds', `${stageNodeId('spec')}->${stageNodeId('build')}`)
    // 停着一颗彗星：彗星层仍渲染（静态），不会有 ticker 去动它。
    expect(Number(within(canvas).getByTestId('react-flow').getAttribute('data-edge-signals'))).toBeGreaterThan(0)
    cleanup()
    renderFlow({ stages: [withStatus[1]!], returns: [], flows: [], mode: 'stage', withStatus: true, holding: 'spec' })
    expect(screen.getByTestId('orchestration-stage')).toHaveAttribute('data-signal', 'still')
    expect(screen.getByTestId('react-flow').getAttribute('data-edge-holds')).toContain('end')
  })

  it('系统要求减少动态效果：Signal 不流动、没有彗星层，只剩静态高亮', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }))
    renderFlow()
    expect(screen.getByTestId('orchestration-overview')).toHaveAttribute('data-signal', 'still')
    expect(screen.getByTestId('react-flow').getAttribute('data-edge-signals')).toBe('0')
    vi.unstubAllGlobals()
  })
})

describe('OrchestrationFlow · 策略要求运行的测试种类', () => {
  it('工作台：一个种类一个节点，状态词与测试页签同一套（通过 / 失败 / 过期 / 未运行）；名字是种类的界面词', () => {
    const kind = (id: string, testKind: 'unit' | 'typecheck' | 'benchmark' | 'e2e', status: 'done' | 'failed' | 'stale' | 'waiting') =>
      entry('test', `kind:${id}`, 1, [], { label: id, testKind, status })
    const stages: FlowStage[] = [{
      id: 'build', label: '实现', gate: null, entries: [
        kind('unit', 'unit', 'done'), kind('typecheck', 'typecheck', 'failed'), kind('benchmark', 'benchmark', 'stale'), kind('e2e', 'e2e', 'waiting'),
      ],
    }]
    renderFlow({ stages, returns: [], flows: [], mode: 'stage', withStatus: true, current: 'build' })
    expect(screen.getAllByTestId('orch-status').map((mark) => mark.textContent)).toEqual(['通过', '失败', '过期', '未运行'])
    expect(screen.getAllByTestId('orch-status').map((mark) => mark.getAttribute('data-status'))).toEqual(['done', 'failed', 'stale', 'waiting'])
    // 默认状态（通过 / 未运行）不写字，只有失败、过期出字。
    expect(screen.getAllByTestId('orch-status').map((mark) => mark.className.includes('sr-only'))).toEqual([true, false, false, true])
    expect(screen.getByTestId('orch-open-test-kind:typecheck').textContent).toContain('类型检查')
    expect(screen.getByTestId('orch-open-test-kind:typecheck')).toHaveAttribute('title', '类型检查 · typecheck')
    expect(screen.getByTestId('orch-node-test-kind:typecheck').className).toContain('border-red-b')
    expect(screen.getByTestId('orch-lane-test')).toHaveTextContent('测试4')
  })

  it('英文界面用种类的英文词', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    const stages: FlowStage[] = [{ id: 'build', label: 'Build', gate: null, entries: [entry('test', 'kind:e2e', 1, [], { label: 'e2e', testKind: 'e2e' })] }]
    renderFlow({ stages, returns: [], flows: [], mode: 'stage' })
    expect(screen.getByTestId('orch-open-test-kind:e2e').textContent).toContain('End-to-end')
    window.localStorage.removeItem('tenon-dashboard-lang')
  })
})

describe('OrchestrationFlow · 与 kernel 同一份编排', () => {
  it('草稿直接走 kernel orchestrate：未声明依赖串行、声明依赖成波', () => {
    const serial = orchestrate({ steps: [{ id: 's', label: 'S', gate: null, skills: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], transitions: [] }] })
    renderFlow({ stages: serial.stages, returns: [], flows: [], mode: 'stage' })
    expect(['a', 'b', 'c'].map((id) => screen.getByTestId(`orch-node-skill-${id}`).getAttribute('data-wave'))).toEqual(['0', '1', '2'])
  })

  it('草稿的 gate null 与服务端编译同口径：画成自动；review 不动', () => {
    const stage = (id: string, gate: 'review' | 'auto' | null) => ({ id, label: id, gate, skills: [], inputs: [], outputs: [], guards: [], transitions: [] })
    const drawn = draftOrchestration({ name: 'flow', steps: [stage('a', null), stage('b', 'auto'), stage('c', 'review')] }, undefined, {})
    expect(drawn.stages.map((item) => item.gate)).toEqual(['auto', 'auto', 'review'])
    renderFlow({ stages: drawn.stages, returns: [], flows: [], mode: 'overview' })
    expect(screen.getAllByTestId('orch-gate').map((mark) => mark.getAttribute('data-gate'))).toEqual(['auto', 'auto', 'review'])
  })
})
