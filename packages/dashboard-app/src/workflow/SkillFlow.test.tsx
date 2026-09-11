import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WbSkillRef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { addSkillAt, appendSerial, dropTargetFor, edgesOf, graphToSkills, layoutSkills, SkillFlow, skillsSignature, wouldCycle } from './SkillFlow'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const SKILLS: WbSkillRef[] = [
  { id: 'tenon-explore' },
  { id: 'brainstorming', depends_on: ['tenon-explore'] },
  { id: 'grill-with-docs', depends_on: ['tenon-explore'], kind: 'review', review_lane: 'spec' },
]

describe('SkillFlow · 纯函数', () => {
  it('layoutSkills：列 = 波次，行 = 波内序', () => {
    const layout = layoutSkills(SKILLS)
    expect(layout.map((node) => node.id)).toEqual(['tenon-explore', 'brainstorming', 'grill-with-docs'])
    expect(layout[0]!.x).toBeLessThan(layout[1]!.x)
    expect(layout[1]!.x).toBe(layout[2]!.x)
    expect(layout[1]!.y).toBeLessThan(layout[2]!.y)
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
    expect(skills[2]).toEqual({ id: 'grill-with-docs', kind: 'review', review_lane: 'spec', depends_on: ['tenon-explore'] })
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
    expect(screen.getByTestId('react-flow').getAttribute('data-edges')).toContain('start->tenon-explore')
    expect(screen.getByTestId('react-flow').getAttribute('data-edges')).toContain('brainstorming->end')
    expect(screen.getByTestId('react-flow').getAttribute('data-edges')).not.toContain('tenon-explore->end')
    expect(screen.getByTestId('flow-node-brainstorming')).toHaveTextContent('把想法聊成设计')
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
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'brainstorming' }, { id: 'grill-with-docs', kind: 'review', review_lane: 'spec' }])
  })
  it('空态文案：只读「没有技能」，可编辑「拖入技能」', () => {
    const { unmount } = render(<I18nProvider><SkillFlow skills={[]} registry={[]} editable={false} onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow-empty')).toHaveTextContent('没有技能')
    unmount()
    render(<I18nProvider><SkillFlow skills={[]} registry={[]} editable onOpen={() => undefined} /></I18nProvider>)
    expect(screen.getByTestId('skill-flow-empty')).toHaveTextContent('拖入技能')
  })
})
