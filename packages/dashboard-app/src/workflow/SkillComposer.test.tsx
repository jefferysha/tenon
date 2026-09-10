import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WbSkillEntry } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { SkillComposer } from './SkillComposer'

const REGISTRY: WbSkillEntry[] = [
  { name: 'tenon-open', installed: true, source: 'local-plugin', description: '立项驱动', tier: 'mandatory', available: true },
  { name: 'brainstorming', installed: true, source: 'external-marketplace', description: '把想法聊成设计', tier: 'mandatory', available: true, version: '6.3.0' },
  { name: 'ghost', installed: false, source: 'user', tier: 'optional', available: true },
]

afterEach(() => { vi.restoreAllMocks() })

describe('SkillComposer', () => {
  it('左侧本机技能库：可搜索、标来源、点名展开来源与说明；右侧画布按波次显示已排技能；保存回写波次', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <I18nProvider>
        <SkillComposer open stageLabel="立项" skills={[{ id: 'tenon-open' }]} registry={REGISTRY} onClose={() => undefined} onSave={onSave} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('skill-composer')).toBeInTheDocument()
    expect(screen.getByTestId('skill-node-tenon-open')).toBeInTheDocument()
    expect(screen.getByTestId('palette-source-brainstorming')).toHaveTextContent('市场')
    expect(screen.getByTestId('palette-tenon-open')).toHaveAttribute('data-placed', 'true')
    expect(screen.queryByTestId('palette-ghost')).toBeNull()
    await user.click(screen.getByTestId('palette-toggle-brainstorming'))
    expect(screen.getByTestId('palette-detail-brainstorming')).toHaveTextContent('把想法聊成设计')
    expect(screen.getByTestId('palette-detail-brainstorming')).toHaveTextContent('6.3.0')
    await user.type(screen.getByTestId('skill-palette-search'), 'brain')
    expect(screen.queryByTestId('palette-tenon-open')).toBeNull()
    expect(screen.getByTestId('palette-brainstorming')).toBeInTheDocument()
    await user.click(screen.getByTestId('skill-remove-tenon-open'))
    expect(screen.queryByTestId('skill-node-tenon-open')).toBeNull()
    await user.click(screen.getByTestId('skill-composer-save'))
    expect(onSave).toHaveBeenCalledWith([])
  })

  it('眼睛 → 抽屉里以 Markdown 展示 SKILL.md 与来源', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      name: 'brainstorming', source: 'external-marketplace', origin: 'superpowers@claude-plugins-official', path: 'brainstorming/SKILL.md', markdown: '---\nname: brainstorming\ndescription: x\n---\n\n# Brainstorming\n\nTurn ideas into designs.',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    render(
      <I18nProvider>
        <SkillComposer open stageLabel="调研" skills={[]} registry={REGISTRY} onClose={() => undefined} onSave={() => undefined} />
      </I18nProvider>,
    )
    await user.click(screen.getByTestId('palette-preview-brainstorming'))
    await waitFor(() => expect(screen.getByTestId('skill-preview-markdown')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Brainstorming' })).toBeInTheDocument()
    expect(screen.getByTestId('skill-preview-markdown')).not.toHaveTextContent('name: brainstorming')
    expect(screen.getByTestId('skill-preview-origin')).toHaveTextContent('superpowers@claude-plugins-official')
    expect(screen.getByTestId('skill-preview-origin')).toHaveTextContent('brainstorming/SKILL.md')
  })
})
