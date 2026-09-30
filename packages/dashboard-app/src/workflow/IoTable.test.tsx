import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WbIoSlot } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { IoTable, type IoRow } from './IoTable'

const doc = (id: string): WbIoSlot => ({ kind: 'document', id, role: 'produce', scope: 'change', producers: [], consumers: [] })
const row = (id: string, stage: string | undefined, skills: string[]): IoRow => ({ slot: doc(id), stage, skills, path: `${id}.md` })

function mount(rows: readonly IoRow[]): void {
  render(<I18nProvider><IoTable direction="inputs" rows={rows} empty="—" /></I18nProvider>)
}

describe('IoTable', () => {
  it('文件名是 500 字重的等宽 id，不再 600', () => {
    mount([row('proposal', '立项', ['openspec-propose'])])
    const cell = screen.getByTestId('slot-document-proposal').querySelector('[role="cell"]')
    expect(cell?.className).toContain('font-mono')
    expect(cell?.className).toContain('font-medium')
    expect(cell?.className).not.toContain('font-semibold')
  })

  it('与上一行相同的来源阶段 / 来源技能降为 text-3，第一处与变化处保持正常色', () => {
    mount([
      row('proposal', '立项', ['openspec-propose']),
      row('openspec-design', '立项', ['openspec-propose']),
      row('tasks', '立项', ['openspec-propose']),
      row('design', '调研', ['brainstorming']),
    ])
    const stage = (id: string): HTMLElement => screen.getByTestId(`slot-stage-${id}`)
    const skills = (id: string): HTMLElement => screen.getByTestId(`slot-skills-${id}`)
    expect(stage('proposal').className.split(/\s+/u)).toContain('text-text')
    expect(stage('proposal')).not.toHaveAttribute('data-repeat')
    expect(skills('proposal').className).toContain('text-text-2')
    for (const id of ['openspec-design', 'tasks']) {
      expect(stage(id).className).toContain('text-text-3')
      expect(stage(id)).toHaveAttribute('data-repeat', 'true')
      expect(skills(id).className).toContain('text-text-3')
      expect(skills(id)).toHaveAttribute('data-repeat', 'true')
      // 文字仍在（读屏与截图都看得到），只是降级。
      expect(stage(id)).toHaveTextContent('立项')
      expect(skills(id)).toHaveTextContent('openspec-propose')
    }
    expect(stage('design').className.split(/\s+/u)).toContain('text-text')
    expect(skills('design').className).toContain('text-text-2')
  })

  it('空值的破折号本来就是 text-3；空值连续出现不算重复', () => {
    mount([row('a', undefined, []), row('b', undefined, [])])
    expect(screen.getByTestId('slot-stage-b')).not.toHaveAttribute('data-repeat')
    expect(screen.getByTestId('slot-skills-b')).not.toHaveAttribute('data-repeat')
    expect(screen.getByTestId('slot-stage-b').className).toContain('text-text-3')
  })
})
