import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n'
import { StageSkills } from './StageSkills'

describe('StageSkills', () => {
  it('按波次分列，三态各自成标签', () => {
    render(
      <I18nProvider>
        <StageSkills runs={{
          stepId: 'verify',
          skills: [
            { id: 'tenon-verify', status: 'done', wave: 0 },
            { id: 'browser-qa', status: 'running', wave: 1 },
            { id: 'e2e-testing', status: 'idle', wave: 1 },
          ],
        }}
        />
      </I18nProvider>,
    )
    expect(screen.getByTestId('stage-skills')).toHaveAccessibleName('技能：1/3 已完成')
    expect(screen.getAllByTestId(/^stage-skill-wave-/)).toHaveLength(2)
    expect(screen.getByTestId('stage-skill-wave-1').querySelectorAll('[data-testid^="stage-skill-"][data-status]')).toHaveLength(2)
    expect(screen.getByTestId('stage-skill-tenon-verify')).toHaveTextContent('已完成')
    expect(screen.getByTestId('stage-skill-browser-qa')).toHaveTextContent('运行中')
    expect(screen.getByTestId('stage-skill-e2e-testing')).toHaveTextContent('未开始')
  })

  it('无技能或旧服务端无字段 → 不渲染', () => {
    const { container } = render(<I18nProvider><StageSkills runs={undefined} /></I18nProvider>)
    expect(container).toBeEmptyDOMElement()
  })
})
