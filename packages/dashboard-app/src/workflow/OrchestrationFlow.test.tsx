import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { orchestrate } from '@tenon/kernel/workflow/orchestration'
import type { FlowStage } from '../api/workflowOrchestrationClient'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { OrchestrationFlow } from './OrchestrationFlow'
import { entryNodeId, layoutOrchestration, stageNodeId } from './orchestrationLayout'
import { pulsePlan } from './flowPulse'

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
  it('列内按位次自上而下，同一位次横排；阶段列从左到右', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const at = (stage: string, kind: 'skill' | 'test' | 'reviewer', id: string) => layout.entries.find((item) => item.id === entryNodeId(stage, { kind, id }))
    const explore = ['openspec-explore', 'brainstorming', 'grilling', 'domain-modeling'].map((id) => at('explore', 'skill', id))
    expect(explore[0]!.y).toBeLessThan(explore[1]!.y)
    expect(explore[1]!.y).toBe(explore[2]!.y)
    expect(explore[1]!.x).toBeLessThan(explore[2]!.x)
    expect(explore[3]!.y).toBeGreaterThan(explore[1]!.y)
    const frames = layout.stages.map((stage) => stage.x)
    expect([...frames].sort((a, b) => a - b)).toEqual(frames)
    // 身份顺序：技能 → 测试 → 评审者。
    expect(at('verify', 'skill', 'browser-qa')!.y).toBeLessThan(at('verify', 'test', 'playwright')!.y)
    expect(at('verify', 'test', 'playwright')!.y).toBeLessThan(at('verify', 'reviewer', 'security')!.y)
  })

  it('主线：起点 → 各阶段列头 → 终点；列内同身份照前置连线；两组各多于一个时经汇合点', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const ids = layout.edges.map((edge) => edge.id)
    expect(ids).toContain(`start->${stageNodeId('open')}`)
    expect(ids).toContain(`${stageNodeId('open')}->${stageNodeId('explore')}`)
    expect(ids).toContain(`${stageNodeId('verify')}->end`)
    expect(ids).toContain(`${entryNodeId('explore', { kind: 'skill', id: 'openspec-explore' })}->${entryNodeId('explore', { kind: 'skill', id: 'grilling' })}`)
    expect(layout.junctions.map((point) => point.id)).toEqual([])
    const fan = layoutOrchestration([{ id: 's', label: 's', gate: null, entries: [entry('skill', 'a', 0), entry('skill', 'b', 0, [], {}), entry('reviewer', 'r1', 1), entry('reviewer', 'r2', 1)] }], 'stage')
    expect(fan.junctions.map((point) => point.id)).toEqual(['j:s:reviewer'])
  })

  it('脉冲段序：进一列、走完这一列，再去下一列（下一段主线在上一列之后）', () => {
    const layout = layoutOrchestration(STAGES, 'overview')
    const order = (id: string) => layout.edges.find((edge) => edge.id === id)?.order ?? Number.NaN
    const intoExplore = order(`${stageNodeId('open')}->${stageNodeId('explore')}`)
    const insideExplore = layout.edges.filter((edge) => edge.target.startsWith('e:explore:')).map((edge) => edge.order)
    const intoVerify = order(`${stageNodeId('explore')}->${stageNodeId('verify')}`)
    expect(Math.min(...insideExplore)).toBeGreaterThan(intoExplore)
    expect(Math.max(...insideExplore)).toBeLessThan(intoVerify)
    expect(order(`${stageNodeId('verify')}->end`)).toBeGreaterThan(intoVerify)
    // 同段序同时出发：扇出的两条边一起走。
    const plan = pulsePlan(layout.edges.map((edge) => ({ order: edge.order, length: 100 })))
    expect(plan.every((step, index) => index === 0 || step.start >= 0)).toBe(true)
  })

  it('阶段模式：泳道标签在左、起点在列顶、终点在列底；可编辑时空泳道也留一行', () => {
    const stage = STAGES[2]!
    const layout = layoutOrchestration([stage], 'stage', { showEmpty: true })
    expect(layout.lanes.map((lane) => [lane.kind, lane.count])).toEqual([['executor', 0], ['skill', 1], ['test', 1], ['reviewer', 3]])
    expect(layout.ports.start.y).toBeLessThan(Math.min(...layout.entries.map((item) => item.y)))
    expect(layout.ports.end.y).toBeGreaterThan(Math.max(...layout.entries.map((item) => item.y)))
    expect(layoutOrchestration([stage], 'stage').lanes.map((lane) => lane.kind)).toEqual(['skill', 'test', 'reviewer'])
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
  it('每阶段一列：单线框分组，列头有序号、名称与门禁图标；回流是列头之间的虚线弧', () => {
    renderFlow()
    const canvas = screen.getByTestId('orchestration-overview')
    expect(canvas).toHaveAttribute('aria-label', '总览')
    expect(within(canvas).getByTestId('orch-stage-explore')).toHaveTextContent('2调研')
    expect(within(within(canvas).getByTestId('orch-frame-explore')).getByTestId('orch-gate')).toHaveAttribute('data-gate', 'review')
    expect(within(within(canvas).getByTestId('orch-frame-open')).queryByTestId('orch-gate')).toBeNull()
    const edges = within(canvas).getByTestId('react-flow').getAttribute('data-edges') ?? ''
    expect(edges.split(',')).toContain('return:verify->explore')
    // 起点、终点是实心圆点。
    expect(within(canvas).getByTestId('orch-start').querySelector('span')?.className).toContain('bg-(--accent)')
    expect(within(canvas).getByTestId('orch-end').querySelector('[data-pulse-dot]')?.className).toContain('bg-text-3')
    // 没有点阵背景。
    expect(within(canvas).queryByTestId('flow-background')).toBeNull()
  })

  it('脉冲持续循环（空闲画布也循环，与运行与否无关）', () => {
    renderFlow()
    expect(screen.getByTestId('orchestration-overview')).toHaveAttribute('data-pulse', 'loop')
  })

  it('来源与必需：OpenSpec 注入换契约图标；参考评审者虚线框', () => {
    renderFlow()
    expect(screen.getByTestId('orch-node-skill-openspec-propose')).toHaveAttribute('data-source', 'openspec')
    expect(within(screen.getByTestId('orch-node-skill-openspec-propose')).getByTestId('orch-source-openspec')).toBeTruthy()
    expect(screen.getByTestId('orch-node-reviewer-architecture').className).toContain('border-dashed')
    expect(screen.getByTestId('orch-open-reviewer-architecture')).toHaveAttribute('title', 'architecture · 参考')
  })

  it('悬停列头：读取它输出的阶段框高亮；点列头进入该阶段', async () => {
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

  it('全屏：控件切换铺满视口，Esc 退出；缩放控件在', async () => {
    renderFlow()
    const canvas = screen.getByTestId('orchestration-overview')
    expect(within(canvas).getByTestId('flow-controls')).toHaveAttribute('data-show-zoom', 'true')
    await userEvent.click(screen.getByTestId('orchestration-fullscreen'))
    expect(canvas).toHaveAttribute('data-expanded', 'true')
    expect(canvas.className).toContain('fixed')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(canvas).not.toHaveAttribute('data-expanded')
  })

  it('运行状态四态：运行中 / 完成 / 等待 / 失败；当前阶段框高亮', () => {
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
    expect(screen.getByTestId('orch-frame-build')).toHaveAttribute('data-current', 'true')
  })
})

describe('OrchestrationFlow · 与 kernel 同一份编排', () => {
  it('草稿直接走 kernel orchestrate：未声明依赖串行、声明依赖成波', () => {
    const serial = orchestrate({ steps: [{ id: 's', label: 'S', gate: null, skills: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], transitions: [] }] })
    renderFlow({ stages: serial.stages, returns: [], flows: [], mode: 'stage' })
    expect(['a', 'b', 'c'].map((id) => screen.getByTestId(`orch-node-skill-${id}`).getAttribute('data-wave'))).toEqual(['0', '1', '2'])
  })
})
