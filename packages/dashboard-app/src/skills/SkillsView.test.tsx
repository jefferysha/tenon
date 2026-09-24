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
  it('renders seven column headers and one row per skill', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['技能', '来源', '引用', '提交', '许可证', '更新', '状态'])
    expect(screen.getAllByTestId(/^skills-row-/u)).toHaveLength(4)
    expect(screen.getByTestId('skills-updated')).toHaveTextContent('更新 2026-09-15 08:00')
  })

  it('shows a status word only for changed / failed rows and filters to failed rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    for (const row of FIXTURE.rows) {
      const status = screen.getByTestId(`skills-status-${row.id}`)
      if (row.status === 'changed' || row.status === 'failed') expect(status.textContent).toMatch(/^\S+$/u)
      else expect(status.textContent).toBe('')
      expect(status.getAttribute('title')).not.toMatch(/^skills\./u)
    }
    expect(screen.getByTestId('skills-status-hue')).toHaveTextContent('变化')
    expect(screen.getByTestId('skills-filter-failed')).toHaveTextContent('失败')
    await userEvent.click(screen.getByTestId('skills-filter-failed'))
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

  it('searches by skill or repo', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    await userEvent.type(screen.getByTestId('skills-search'), 'superpowers')
    expect(screen.getAllByTestId(/^skills-row-/u).map((row) => row.dataset.testid)).toEqual(['skills-row-brainstorming'])
    await userEvent.clear(screen.getByTestId('skills-search'))
    await userEvent.type(screen.getByTestId('skills-search'), 'HUE')
    expect(screen.getAllByTestId(/^skills-row-/u).map((row) => row.dataset.testid)).toEqual(['skills-row-hue'])
  })

  it('opens the skill detail drawer from a row, but not from a link inside it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const compare = await screen.findByTestId('skills-compare-hue')
    compare.addEventListener('click', (event) => event.preventDefault())
    await userEvent.click(compare)
    expect(screen.queryByTestId('skill-preview')).toBeNull()
    await userEvent.click(within(screen.getByTestId('skills-row-hue')).getAllByRole('cell')[3] as HTMLElement)
    expect(await screen.findByTestId('skill-preview')).toBeInTheDocument()
  })

  it('opens the drawer from the keyboard through the skill name button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const button = await screen.findByTestId('skills-open-brainstorming')
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByTestId('skill-preview')).toBeInTheDocument()
  })

  it('has no outer frame or zebra: only the header hairline and a hover background', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const row = await screen.findByTestId('skills-row-hue')
    expect(row.className).toContain('hover:bg-fill')
    expect(row.className).not.toContain('even:')
    expect(row.className).not.toContain('border-b')
    expect(screen.getByTestId('skills-table').className).not.toMatch(/(?:^|\s)border(?:\s|$)/u)
    for (const head of screen.getAllByRole('columnheader')) expect(head.className).toContain('border-b')
  })

  it('filters with single-select chips, not tabs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.queryByRole('tablist')).toBeNull()
    const group = screen.getByRole('radiogroup')
    expect(within(group).getAllByRole('radio').map((chip) => chip.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    await userEvent.click(screen.getByTestId('skills-filter-changed'))
    expect(screen.getByTestId('skills-filter-changed')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByTestId(/^skills-row-/u).map((row) => row.dataset.testid)).toEqual(['skills-row-hue'])
  })

  it('shows the accent color on links only on hover; commit hashes are text-3 mono; dates use tabular numbers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      const accent = link.className.split(/\s+/u).filter((cls) => cls.includes('accent'))
      expect(accent.every((cls) => cls.startsWith('hover:') || cls.startsWith('focus-visible:'))).toBe(true)
      expect(link.className).toContain('underline-offset-4')
    }
    const commit = screen.getByTestId('skills-compare-hue').closest('td')
    expect(commit?.className).toContain('font-mono')
    expect(commit?.className).toContain('text-text-3')
    const cells = within(screen.getByTestId('skills-row-hue')).getAllByRole('cell')
    expect(cells[5]?.className).toContain('tabular-nums')
    expect(screen.getByTestId('skills-updated').className).toContain('tabular-nums')
  })

  it('drops the status column when no visible row has anything to report', async () => {
    const quiet = { ...FIXTURE, rows: FIXTURE.rows.filter((row) => row.status !== 'changed' && row.status !== 'failed') }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(quiet), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-brainstorming')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['技能', '来源', '引用', '提交', '许可证', '更新'])
    expect(screen.queryByTestId('skills-status-brainstorming')).toBeNull()
  })

  it('gives the status column a fixed w-24 width when shown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    const cols = screen.getByRole('table').querySelectorAll('col')
    expect(cols).toHaveLength(7)
    expect(cols[6]?.className).toBe('w-24')
  })

  it('names bundled skills with the same source word as the rest of the dashboard (内建)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const row = await screen.findByTestId('skills-row-tenon')
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('内建')
  })

  it('expands a failed row into its reason and copyable fix commands', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const toggle = await screen.findByTestId('skills-expand-web-design-guidelines')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('skills-failure-web-design-guidelines')).toBeNull()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('skills-failure-reason-web-design-guidelines')).toHaveTextContent('缺少许可证 no license evidence')
    expect(screen.getByTestId('skills-fix-web-design-guidelines-0-text')).toHaveTextContent('tenon update --codex')
    expect(screen.getByTestId('skills-fix-web-design-guidelines-1-text')).toHaveTextContent('tenon update --claude')
    expect(screen.queryByTestId('skill-preview')).toBeNull()
    await userEvent.click(toggle)
    expect(screen.queryByTestId('skills-failure-web-design-guidelines')).toBeNull()
  })

  it('lists which workflows / tracks / stages use a skill', async () => {
    const step = (id: string, label: string, skills: string[]) => ({ id, label, gate: null, skills: skills.map((skill) => ({ id: skill })), inputs: [], outputs: [], guards: [], transitions: [] })
    const workflow = {
      name: 'default',
      steps: [step('explore', '调研', ['brainstorming']), step('build', '实现', ['hue', 'brainstorming'])],
      tracks: { ui: { label: '界面', steps: [step('design', '设计', ['hue'])] } },
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/skills/sources')) return new Response(JSON.stringify(FIXTURE), { status: 200 })
      if (url.startsWith('/api/workflows?')) return new Response(JSON.stringify({ names: ['default'] }), { status: 200 })
      if (url.startsWith('/api/workflows/default')) return new Response(JSON.stringify(workflow), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    renderView()
    await screen.findByTestId('skills-row-hue')
    await waitFor(() => expect(screen.getByTestId('skills-used-brainstorming')).toHaveTextContent('default · 调研+1'))
    expect(screen.getByTestId('skills-used-brainstorming')).toHaveAttribute('title', 'default · 调研\ndefault · 实现')
    expect(screen.getByTestId('skills-used-hue')).toHaveAttribute('title', 'default · 实现\ndefault · 界面 · 设计')
    expect(screen.getByTestId('skills-used-tenon')).toHaveTextContent('—')
  })
})
