import { render, screen, waitFor, within } from '@testing-library/react'
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** files / file 两个接口的假服务端：任何技能都有 SKILL.md + references/notes.md。 */
function mockSkillApi(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    const files = /\/api\/skills\/([^/]+)\/files$/.exec(url)
    if (files) return json({ name: decodeURIComponent(files[1]!), source: 'external-marketplace', origin: 'superpowers@official', files: [{ path: 'SKILL.md', bytes: 120 }, { path: 'references/notes.md', bytes: 40 }] })
    const file = /\/api\/skills\/([^/]+)\/file\?path=(.+)$/.exec(url)
    if (file) {
      const path = decodeURIComponent(file[2]!)
      return json(path === 'SKILL.md'
        ? { path, text: '---\nname: brainstorming\ndescription: x\n---\n\n# Brainstorming\n\nTurn ideas into designs.' }
        : { path, text: '# Notes\n\nSecond file.' })
    }
    return json({ ok: false }, 404)
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('SkillComposer', () => {
  it('技能库：可搜索、来源图标、已排技能置灰；画布按波次显示；移除后保存回写', async () => {
    mockSkillApi()
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <I18nProvider>
        <SkillComposer open stageLabel="立项" skills={[{ id: 'tenon-open' }]} registry={REGISTRY} onClose={() => undefined} onSave={onSave} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('skill-composer')).toBeInTheDocument()
    expect(screen.getByTestId('skill-node-tenon-open')).toBeInTheDocument()
    expect(within(screen.getByTestId('palette-source-brainstorming')).getByRole('img', { name: '市场' })).toBeInTheDocument()
    expect(screen.getByTestId('palette-tenon-open')).toHaveAttribute('data-placed', 'true')
    expect(screen.queryByTestId('palette-ghost')).toBeNull()
    await user.type(screen.getByTestId('skill-palette-search'), 'brain')
    expect(screen.queryByTestId('palette-tenon-open')).toBeNull()
    expect(screen.getByTestId('palette-brainstorming')).toBeInTheDocument()
    await user.click(screen.getByTestId('skill-remove-tenon-open'))
    expect(screen.queryByTestId('skill-node-tenon-open')).toBeNull()
    await user.click(screen.getByTestId('skill-composer-save'))
    expect(onSave).toHaveBeenCalledWith([])
  })

  it('点技能名 → 右栏详情：来源、文件树、SKILL.md 以 Markdown 渲染（YAML 头单列）、可切到其它文件', async () => {
    mockSkillApi()
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <SkillComposer open stageLabel="调研" skills={[]} registry={REGISTRY} onClose={() => undefined} onSave={() => undefined} />
      </I18nProvider>,
    )
    expect(screen.getByTestId('skill-composer-detail')).toHaveTextContent('选一个技能')
    await user.click(screen.getByTestId('palette-open-brainstorming'))
    await waitFor(() => expect(screen.getByTestId('skill-detail-markdown')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Brainstorming' })).toBeInTheDocument()
    expect(screen.getByTestId('skill-detail-meta')).toHaveTextContent('brainstorming')
    expect(screen.getByTestId('skill-detail-markdown')).not.toHaveTextContent('name: brainstorming')
    expect(screen.getByTestId('skill-detail-origin')).toHaveTextContent('superpowers@official')
    expect(screen.getByTestId('skill-detail-files')).toHaveTextContent('references/notes.md')
    await user.click(screen.getByTestId('skill-file-references/notes.md'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument())
  })
})
