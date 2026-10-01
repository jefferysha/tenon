import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { SkillsView } from './SkillsView'
import { workflowsToScan } from './useSkillReferences'

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
  render(<I18nProvider><TooltipProvider delayDuration={0}><SkillsView /></TooltipProvider></I18nProvider>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SkillsView', () => {
  it('renders the column headers (no 来源 column: the source is the group title; no 引用 until there is data) and one row per skill', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['技能', '提交', '许可证', '更新', '状态'])
    expect(screen.getAllByTestId(/^skills-row-/u)).toHaveLength(4)
    expect(screen.getByTestId('skills-updated')).toHaveTextContent('更新 2026-09-15 08:00')
  })

  it('has a page title and a left rail like the sibling pages: rail = status filters with counts, list = H1 + search + table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.getByRole('heading', { level: 1, name: '技能' })).toBeInTheDocument()
    const rail = screen.getByTestId('skills-rail')
    expect(within(rail).getByText('状态')).toBeInTheDocument()
    expect(['all', 'changed', 'failed'].map((id) => screen.getByTestId(`skills-filter-${id}`).textContent)).toEqual(['全部4', '变化1', '失败1'])
    expect(screen.getByTestId('skills-filter-all')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('skills-view')).toHaveAttribute('data-detail-collapsed', 'true')
    expect(screen.getByTestId('skills')).toContainElement(screen.getByTestId('skills-search'))
    expect(screen.getByTestId('skills')).toContainElement(screen.getByTestId('skills-table'))
    // 页头不再有那一排芯片。
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('groups skills by source under a sticky subtitle instead of repeating the source on every row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    const groups = screen.getByTestId('skills-table').querySelectorAll('tbody')
    expect([...groups].map((group) => group.getAttribute('data-testid'))).toEqual([
      'skills-group-builtin', 'skills-group-dominikmartn/hue', 'skills-group-obra/superpowers', 'skills-group-vercel-labs/agent-skills',
    ])
    const head = screen.getByTestId('skills-group-head-obra/superpowers')
    expect(head).toHaveTextContent('obra/superpowers')
    expect(head).toHaveTextContent('1')
    expect(head.className).toContain('sticky')
    expect(head.className).toContain('top-9')
    expect(head.className).toContain('bg-card')
    expect(screen.getByTestId('skills-group-head-builtin')).toHaveTextContent('内建')
    // 表头在最上层、小标题贴在它下面：两层都是 36px。
    const header = screen.getAllByRole('columnheader')[0] as HTMLElement
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-0')
    expect(header.className).toContain('h-9')
    expect(head.className).toContain('h-9')
    // 行里不再重复来源仓库名。
    expect(within(screen.getByTestId('skills-row-brainstorming')).queryByText('obra/superpowers')).toBeNull()
    expect(within(screen.getByTestId('skills-group-obra/superpowers')).getAllByTestId(/^skills-row-/u)).toHaveLength(1)
  })

  it('groups only what the filter leaves: a group with no visible rows disappears', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    await userEvent.click(screen.getByTestId('skills-filter-failed'))
    expect([...screen.getByTestId('skills-table').querySelectorAll('tbody')].map((group) => group.getAttribute('data-testid'))).toEqual(['skills-group-vercel-labs/agent-skills'])
  })

  it('shows the update time short (09-15), the full stamp on hover; a different year keeps its year', async () => {
    const body = {
      ...FIXTURE,
      rows: [
        { ...FIXTURE.rows[2], fetchedAt: '2026-09-21T22:02:00.000Z' },
        { ...FIXTURE.rows[1], fetchedAt: '2025-12-30T01:00:00.000Z' },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    const updated = (id: string): HTMLElement => within(screen.getByTestId(`skills-row-${id}`)).getAllByRole('cell')[3] as HTMLElement
    expect(updated('brainstorming')).toHaveTextContent(/^09-21$/u)
    expect(updated('brainstorming')).toHaveAttribute('title', '2026-09-21 22:02')
    expect(updated('hue')).toHaveTextContent(/^2025-12-30$/u)
    expect(updated('brainstorming').className).toContain('tabular-nums')
  })

  it('hides the 引用 column while no skill has a reference, and shows it as soon as one does', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).not.toContain('引用')
    expect(screen.queryByTestId('skills-used-hue')).toBeNull()
    expect(screen.getByRole('table').querySelectorAll('col')).toHaveLength(5)
  })

  it('skill names are the regular face (Inter 500), mono is kept for commit hashes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const name = await screen.findByTestId('skills-open-brainstorming')
    expect(name.className).toContain('font-medium')
    expect(name.className).not.toContain('font-mono')
    expect(screen.getByTestId('skills-compare-hue').closest('td')?.className).toContain('font-mono')
  })

  it('hover paints the whole row (background on tr, contiguous cell borders), never per cell', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const row = await screen.findByTestId('skills-row-hue')
    expect(row.className).toContain('hover:bg-fill')
    for (const cell of within(row).getAllByRole('cell')) expect(cell.className).not.toContain('hover:')
    const table = screen.getByRole('table')
    expect(table.className).toContain('border-separate')
    expect(table.className).toContain('border-spacing-0')
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
    await userEvent.click(within(screen.getByTestId('skills-row-hue')).getAllByRole('cell')[2] as HTMLElement)
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

  it('filters from the rail with single-select cards (aria-current), not tabs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    expect(screen.queryByRole('tablist')).toBeNull()
    const cards = ['all', 'changed', 'failed'].map((id) => screen.getByTestId(`skills-filter-${id}`))
    expect(cards.map((card) => card.getAttribute('aria-current'))).toEqual(['true', null, null])
    await userEvent.click(screen.getByTestId('skills-filter-changed'))
    expect(cards.map((card) => card.getAttribute('aria-current'))).toEqual([null, 'true', null])
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
    expect(cells[3]?.className).toContain('tabular-nums')
    expect(screen.getByTestId('skills-updated').className).toContain('tabular-nums')
  })

  it('drops the status column when no visible row has anything to report', async () => {
    const quiet = { ...FIXTURE, rows: FIXTURE.rows.filter((row) => row.status !== 'changed' && row.status !== 'failed') }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(quiet), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-brainstorming')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['技能', '提交', '许可证', '更新'])
    expect(screen.queryByTestId('skills-status-brainstorming')).toBeNull()
  })

  it('gives the status column a fixed w-24 width when shown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    await screen.findByTestId('skills-row-hue')
    const cols = screen.getByRole('table').querySelectorAll('col')
    expect(cols).toHaveLength(5)
    expect(cols[4]?.className).toBe('w-24')
  })

  it('names bundled skills with the same source word as the rest of the dashboard (内建)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }))
    renderView()
    const row = await screen.findByTestId('skills-row-tenon')
    // 内建是「内建」组的小标题，行内不再重复。
    expect(screen.getByTestId('skills-group-builtin')).toContainElement(row)
    expect(screen.getByTestId('skills-group-head-builtin')).toHaveTextContent('内建')
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

  it('says why a failed row failed: no installed release payload / not in the lock, one truncated line with the full text on hover', async () => {
    const body = {
      updatedAt: null, lastRunAt: null,
      rows: [
        { id: 'hue', origin: 'upstream', status: 'failed', repo: 'dominikmartn/hue', path: '.', reason: 'lock-missing' },
        { id: 'shadcn', origin: 'upstream', status: 'failed', repo: 'shadcn-ui/ui', path: 'skills/shadcn', reason: 'not-locked' },
        { id: 'brainstorming', origin: 'upstream', status: 'failed', repo: 'obra/superpowers', path: 'skills/brainstorming', reason: 'unreachable', detail: 'getaddrinfo ENOTFOUND api.github.com' },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    renderView()
    for (const id of ['hue', 'shadcn', 'brainstorming']) await userEvent.click(await screen.findByTestId(`skills-expand-${id}`))
    const payload = screen.getByTestId('skills-failure-reason-hue')
    expect(payload).toHaveTextContent('没有已安装的发布包（从源码运行）')
    expect(payload).toHaveAttribute('title', '没有已安装的发布包（从源码运行）')
    expect(payload.className).toContain('truncate')
    expect(payload.className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('skills-failure-reason-shadcn')).toHaveTextContent('skills.lock.json 里没有该技能')
    expect(screen.getByTestId('skills-failure-reason-brainstorming')).toHaveAttribute('title', '无法访问 getaddrinfo ENOTFOUND api.github.com')
    expect(screen.getByTestId('skills-fix-hue-0-text')).toHaveTextContent('tenon update --codex')
    expect(screen.getByTestId('skills-fix-hue-1-text')).toHaveTextContent('tenon update --claude')
  })

  it('lists which workflows use a skill at which stage, read from the orchestration: declared, OpenSpec-injected and manifest-overlay alike; the same stage on several tracks is one place', async () => {
    const entry = (id: string, source: 'declared' | 'openspec' | 'manifest' = 'declared') =>
      ({ kind: 'skill', id, label: id, wave: 0, dependsOn: [], required: true, source })
    const stage = (id: string, label: string, entries: unknown[]) => ({ id, label, gate: null, entries })
    const orchestration = (workflow: string, track: string | null, stages: unknown[]) => ({ workflow, track, stages, returns: [], flows: [], overlay: {} })
    // 定义只用来知道有哪些轨道（id / label）；引用来自每条轨道的编排，而不是定义里的 step.skills。
    const definitions: Record<string, unknown> = {
      default: { name: 'default', steps: [], tracks: { ui: { label: '界面', steps: [] }, backend: { steps: [] } } },
      simple: { name: 'simple', steps: [] },
      team: { name: 'team', steps: [] },
    }
    const branches: Record<string, unknown> = {
      'default/ui': orchestration('default', 'ui', [
        stage('explore', '调研', [entry('superpowers:brainstorming')]),
        stage('design', '设计', [entry('hue'), entry('openspec-propose', 'openspec')]),
      ]),
      'default/backend': orchestration('default', 'backend', [
        stage('explore', '调研', [entry('brainstorming|opsx:explore', 'manifest')]),
        stage('build', '实现', [entry('hue')]),
      ]),
      'simple/': orchestration('simple', null, [stage('verify', '验证', [entry('verification-before-completion')])]),
      'team/': orchestration('team', null, [stage('plan', 'plan', [entry('brainstorming')])]),
    }
    const withMore = { ...FIXTURE, rows: [...FIXTURE.rows, { ...FIXTURE.rows[2], id: 'openspec-propose' }, { ...FIXTURE.rows[2], id: 'verification-before-completion' }] }
    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.startsWith('/api/skills/sources')) return new Response(JSON.stringify(withMore), { status: 200 })
      // 与真实服务端一致：列表只有自定义与模板工作流，不含 default 与内建的 simple。
      if (url.startsWith('/api/workflows?')) return new Response(JSON.stringify({ names: ['team'], default: { source: 'builtin' } }), { status: 200 })
      const orchestrationOf = /^\/api\/workflows\/([^/?]+)\/orchestration\?(.*)$/u.exec(url)
      if (orchestrationOf !== null) {
        const track = new URLSearchParams(orchestrationOf[2]).get('track') ?? ''
        const body = branches[`${orchestrationOf[1]}/${track}`]
        return body === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
      }
      const definition = /^\/api\/workflows\/([^/?]+)\?/u.exec(url)?.[1]
      if (definition !== undefined && definitions[definition] !== undefined) return new Response(JSON.stringify(definitions[definition]), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    renderView()
    await screen.findByTestId('skills-row-hue')
    // default 不在工作流列表里，照样被计入；界面 / backend 两条轨道的「调研」合成一处，再加 team 的 plan。
    await waitFor(() => expect(screen.getByTestId('skills-used-brainstorming')).toHaveTextContent('default · 调研+1'))
    // 有了引用数据，被隐藏的 引用 列出现。
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toContain('引用')
    expect(screen.getByTestId('skills-used-hue')).toHaveTextContent('default · 设计+1')
    expect(screen.getByTestId('skills-used-openspec-propose')).toHaveTextContent('default · 设计')
    expect(screen.getByTestId('skills-used-openspec-propose')).not.toHaveTextContent('+')
    // 内建的 simple 也读：没有轨道的工作流只写「工作流 · 阶段」。
    expect(screen.getByTestId('skills-used-verification-before-completion')).toHaveTextContent(/^simple · 验证$/u)
    expect(screen.getByTestId('skills-used-tenon')).toHaveTextContent('—')
    expect(requested.some((url) => url.startsWith('/api/workflows/default?'))).toBe(true)
    expect(requested.some((url) => url.startsWith('/api/workflows/simple?'))).toBe(true)
    expect(requested.some((url) => url.includes('/default/orchestration?') && url.includes('track=ui'))).toBe(true)
    expect(requested.some((url) => url.includes('/default/orchestration?') && url.includes('track=backend'))).toBe(true)
    // 悬停 Tooltip 列出全部引用，一行一处：工作流 · 阶段 · 轨道。
    await userEvent.hover(within(screen.getByTestId('skills-used-brainstorming')).getByText(/default · 调研/u))
    const lines = (await screen.findAllByTestId('skills-used-list-brainstorming'))[0] as HTMLElement
    expect([...lines.querySelectorAll('li')].map((line) => line.textContent)).toEqual(['default · 调研 · 界面 / backend', 'team · plan'])
    for (const line of lines.querySelectorAll('li')) expect(line.className).toContain('whitespace-nowrap')
  })

  it('reads the built-in workflows the index does not list: default first, then the plugin-owned ones, then the custom names, each once', () => {
    expect(workflowsToScan([])).toEqual(['default', 'simple'])
    expect(workflowsToScan(['team', 'design-system', 'simple'])).toEqual(['default', 'simple', 'team', 'design-system'])
  })

  it('a branch that cannot be read only costs its own references', async () => {
    const withBrainstorming = { name: 'default', steps: [], tracks: { ui: { label: '界面', steps: [] } } }
    const ok = { workflow: 'default', track: 'ui', overlay: {}, returns: [], flows: [], stages: [{ id: 'explore', label: '调研', gate: null, entries: [{ kind: 'skill', id: 'brainstorming', label: 'brainstorming', wave: 0, dependsOn: [], required: true, source: 'declared' }] }] }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/skills/sources')) return new Response(JSON.stringify(FIXTURE), { status: 200 })
      if (url.startsWith('/api/workflows?')) return new Response(JSON.stringify({ names: ['team'], default: { source: 'builtin' } }), { status: 200 })
      if (url.includes('/default/orchestration?')) return new Response(JSON.stringify(ok), { status: 200 })
      if (url.startsWith('/api/workflows/default?')) return new Response(JSON.stringify(withBrainstorming), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 })
    })
    renderView()
    await screen.findByTestId('skills-row-hue')
    await waitFor(() => expect(screen.getByTestId('skills-used-brainstorming')).toHaveTextContent(/^default · 调研$/u))
  })
})
