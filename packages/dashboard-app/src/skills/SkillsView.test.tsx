import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { SkillsView } from './SkillsView'

const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const FIXTURE = {
  updatedAt: '2026-09-15T08:00:00.000Z',
  lastRunAt: '2026-09-15T09:00:00.000Z',
  rows: [
    { id: 'tenon', origin: 'tenon', status: 'bundled' },
    {
      id: 'hue', origin: 'upstream', status: 'changed', repo: 'dominikmartn/hue', path: '.', commit: C2,
      previousCommit: C1, license: 'MIT', fetchedAt: '2026-09-15T08:00:00.000Z',
      sourceUrl: `https://github.com/dominikmartn/hue/tree/${C2}`,
      commitUrl: `https://github.com/dominikmartn/hue/commit/${C2}`,
      compareUrl: `https://github.com/dominikmartn/hue/compare/${C1}...${C2}`,
    },
    {
      id: 'brainstorming', origin: 'upstream', status: 'unchanged', repo: 'obra/superpowers', path: 'skills/brainstorming',
      commit: C1, previousCommit: null, license: 'MIT', fetchedAt: '2026-09-01T00:00:00.000Z',
      sourceUrl: `https://github.com/obra/superpowers/tree/${C1}/skills/brainstorming`,
      commitUrl: `https://github.com/obra/superpowers/commit/${C1}`,
    },
    {
      id: 'web-design-guidelines', origin: 'upstream', status: 'failed', repo: 'vercel-labs/agent-skills',
      path: 'skills/web-design-guidelines', reason: 'license-missing', detail: 'no license evidence',
    },
  ],
}

function renderView(): void {
  render(<I18nProvider><SkillsView /></I18nProvider>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SkillsView', () => {
  it('renders six column headers and one row per skill', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['技能', '来源', '提交', '许可证', '更新', '状态'])
    expect(screen.getAllByTestId(/^skills-row-/u)).toHaveLength(4)
    expect(screen.getByTestId('skills-updated')).toHaveTextContent('更新 2026-09-15 08:00')
  })

  it('filters to failed rows and keeps every status cell to one word', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    for (const row of FIXTURE.rows) {
      expect(screen.getByTestId(`skills-status-${row.id}`).textContent).toMatch(/^\S+$/u)
    }
    expect(screen.getByTestId('skills-filter-tab-failed')).toHaveTextContent('失败')
    await userEvent.click(screen.getByTestId('skills-filter-tab-failed'))
    expect(screen.getAllByTestId(/^skills-row-/u).map((row) => row.dataset.testid)).toEqual(['skills-row-web-design-guidelines'])
  })

  it('links a changed row with a previous commit to the compare view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const compare = await screen.findByTestId('skills-compare-hue')
    expect(compare).toHaveAttribute('href', FIXTURE.rows[1]?.compareUrl)
    expect(compare).toHaveTextContent('1111111→2222222')
    expect(within(screen.getByTestId('skills-row-brainstorming')).getByRole('link', { name: '1111111' }))
      .toHaveAttribute('href', `https://github.com/obra/superpowers/commit/${C1}`)
  })

  it('puts the localized failure reason on the failed status title and never wraps a cell', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const status = await screen.findByTestId('skills-status-web-design-guidelines')
    expect(status).toHaveTextContent('失败')
    expect(status.getAttribute('title')).toContain('缺少许可证')
    for (const cell of screen.getAllByRole('cell')) expect(cell.className).toContain('whitespace-nowrap')
    for (const cell of screen.getAllByRole('columnheader')) expect(cell.className).toContain('whitespace-nowrap')
  })

  it('shows one error line when the sources cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'skills/skills.lock.json: JSON 无效' }), { status: 500 }))
    renderView()
    const error = await screen.findByTestId('skills-load-error')
    expect(error).toHaveTextContent('技能来源读取失败')
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull())
  })
})
