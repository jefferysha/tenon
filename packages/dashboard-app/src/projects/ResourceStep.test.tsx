import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ResourceEntry } from '../api/resourceTypes'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DesignCategory, ResourcePicks } from './designResources'
import { ResourceStep } from './ResourceStep'

const MIT = { spdx: 'MIT', url: 'https://example.test/LICENSE', redistributable: true, attribution: false, commercial: 'free' } as const

function entry(id: string, name: string, category: ResourceEntry['category'], frameworks: ResourceEntry['frameworks'], extra: Partial<ResourceEntry> = {}): ResourceEntry {
  return { schema: 'tenon-resource/v1', id, name, category, frameworks, styling: [], baseline: false, license: MIT, install: [], skills: [], links: {}, verified_at: '2026-09-16', ...extra }
}

const ENTRIES: ResourceEntry[] = [
  entry('shadcn-ui', 'shadcn/ui', 'component-lib', ['react', 'next'], {
    use: '可复制的组件源码',
    install: ['npx shadcn@latest init'],
    links: { home: 'https://ui.shadcn.test', docs: 'https://ui.shadcn.test/docs' },
    license: { ...MIT, url: 'https://ui.shadcn.test/license' },
  }),
  entry('element-plus', 'Element Plus', 'component-lib', ['vue'], { links: { docs: 'https://element-plus.test' } }),
  entry('any-kit', 'Any Kit', 'component-lib', [], {
    license: { ...MIT, spdx: 'LicenseRef-Kit', redistributable: false, attribution: true, notice: '需署名' },
    links: { source: 'http://any-kit.test/plain' },
  }),
  entry('lucide', 'Lucide', 'icons', []),
  entry('phosphor', 'Phosphor', 'icons', ['react']),
  entry('vue-icons', 'Vue Icons', 'icons', ['vue']),
  entry('design-md-claude', 'Claude', 'design-md', [], { links: { home: 'https://claude.test', design_md: 'https://claude.test/DESIGN.md' } }),
  entry('design-md-plain', 'Plain', 'design-md', [], { links: { design_md: 'http://plain.test/DESIGN.md' } }),
]

interface HarnessProps {
  entries?: readonly ResourceEntry[]
  frameworks?: readonly string[]
  loading?: boolean
  failed?: boolean
  initial?: ResourcePicks
  onRetry?: () => void
  onPick?: (category: DesignCategory, id: string | undefined) => void
}

function Harness({ entries = ENTRIES, frameworks = ['react'], loading = false, failed = false, initial = {}, onRetry = vi.fn(), onPick }: HarnessProps): JSX.Element {
  const [picks, setPicks] = useState<ResourcePicks>(initial)
  return (
    <ResourceStep
      entries={entries}
      loading={loading}
      failed={failed}
      onRetry={onRetry}
      frameworks={frameworks}
      picks={picks}
      onPick={(category, id) => {
        onPick?.(category, id)
        setPicks((current) => {
          const next = { ...current }
          if (id === undefined) delete next[category]
          else next[category] = id
          return next
        })
      }}
    />
  )
}

function renderStep(props: HarnessProps = {}): void {
  render(<I18nProvider><TooltipProvider><div className="h-96"><Harness {...props} /></div></TooltipProvider></I18nProvider>)
}

const rowIds = (): string[] => within(screen.getByTestId('np-res-rows')).getAllByRole('button').map((row) => row.getAttribute('data-testid')?.replace('np-res-', '') ?? '')

describe('资源步骤：左列 · 右侧预览（与模板步骤同构）', () => {
  it('进入即预览第一行，右侧不留空框；换页签回到该页签的第一行', async () => {
    const user = userEvent.setup()
    renderStep()
    expect(rowIds()).toEqual(['any-kit', 'shadcn-ui'])
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Any Kit')
    expect(screen.getByTestId('np-res-any-kit')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('np-res-shadcn-ui')).toHaveAttribute('aria-current', 'false')
    await user.click(screen.getByTestId('np-res-shadcn-ui'))
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('shadcn/ui')
    await user.click(screen.getByTestId('np-res-tab-icons'))
    expect(rowIds()).toEqual(['lucide', 'phosphor'])
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Lucide')
    await user.click(screen.getByTestId('np-res-tab-design-md'))
    expect(rowIds()).toEqual(['design-md-claude'])
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Claude')
  })

  it('按上一步前端模板的框架过滤：React 只列 React 可用（含不限框架）的库；换成 Vue 就换一批', () => {
    const { unmount } = render(<I18nProvider><TooltipProvider><div className="h-96"><Harness frameworks={['react']} /></div></TooltipProvider></I18nProvider>)
    expect(rowIds()).toEqual(['any-kit', 'shadcn-ui'])
    unmount()
    renderStep({ frameworks: ['vue'] })
    expect(rowIds()).toEqual(['any-kit', 'element-plus'])
  })

  it('「全部」列出该类所有条目（相容的在前，其余置灰）；不相容的能预览但不能加入，原因在 Tooltip；关掉后预览回到第一行', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    renderStep({ onPick })
    const all = screen.getByTestId('np-res-all')
    expect(all).not.toBeChecked()
    expect(screen.getByLabelText('全部')).toBe(all)
    await user.click(all)
    expect(rowIds()).toEqual(['any-kit', 'shadcn-ui', 'element-plus'])
    expect(screen.getByTestId('np-res-element-plus').className).toContain('text-text-3')
    expect(screen.getByTestId('np-res-shadcn-ui').className).not.toContain('text-text-3')
    await user.click(screen.getByTestId('np-res-element-plus'))
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Element Plus')
    const toggle = screen.getByTestId('np-res-toggle')
    expect(toggle).toBeDisabled()
    expect(toggle.parentElement).toHaveAttribute('title', '先加入匹配的前端模板')
    await user.click(toggle)
    expect(onPick).not.toHaveBeenCalled()
    await user.click(all)
    expect(rowIds()).toEqual(['any-kit', 'shadcn-ui'])
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Any Kit')
  })

  it('「全部」只在组件库 / 图标页签出现（DESIGN.md 没有框架之分）', async () => {
    const user = userEvent.setup()
    renderStep()
    expect(screen.getByTestId('np-res-all')).toBeInTheDocument()
    await user.click(screen.getByTestId('np-res-tab-icons'))
    expect(screen.getByTestId('np-res-all')).toBeInTheDocument()
    await user.click(screen.getByTestId('np-res-tab-design-md'))
    expect(screen.queryByTestId('np-res-all')).toBeNull()
  })

  it('预览：说明 · 框架 · 许可（链接 + 模式）· 其它链接 · 将写入指令文件的行', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByTestId('np-res-shadcn-ui'))
    expect(screen.getByTestId('np-res-use')).toHaveTextContent('可复制的组件源码')
    expect(screen.getByTestId('np-res-frameworks')).toHaveTextContent('react next')
    const license = screen.getByTestId('np-res-license-link')
    expect(license).toHaveTextContent('MIT')
    expect(license).toHaveAttribute('href', 'https://ui.shadcn.test/license')
    expect(license).toHaveAttribute('target', '_blank')
    expect(screen.getByTestId('np-res-license')).toHaveTextContent('可再分发')
    expect(within(screen.getByTestId('np-res-link-home')).getByRole('link')).toHaveAttribute('href', 'https://ui.shadcn.test')
    expect(within(screen.getByTestId('np-res-link-docs')).getByRole('link')).toHaveAttribute('href', 'https://ui.shadcn.test/docs')
    const writes = screen.getByTestId('np-res-writes')
    expect(writes).toHaveTextContent('将写入')
    expect(writes).toHaveTextContent('指令文件')
    expect(screen.getByTestId('np-res-writes-text')).toHaveTextContent('- shadcn/ui（MIT）· 安装 `npx shadcn@latest init` · 文档 https://ui.shadcn.test/docs')
  })

  it('不可再分发 / 需署名的条目：许可行写明模式，将写入多出各自的约束行；非 https 的链接只显示文字', () => {
    renderStep()
    expect(screen.getByTestId('np-res-license')).toHaveTextContent('仅链接 · 需署名')
    expect(screen.getByTestId('np-res-frameworks')).toHaveTextContent('任意')
    const text = screen.getByTestId('np-res-writes-text')
    expect(text).toHaveTextContent('- Any Kit（LicenseRef-Kit）· 文档 http://any-kit.test/plain')
    expect(text).toHaveTextContent('- 仅链接：Any Kit')
    expect(text).toHaveTextContent('- 署名：Any Kit 需要署名')
    expect(within(screen.getByTestId('np-res-link-source')).queryByRole('link')).toBeNull()
    expect(screen.getByTestId('np-res-license-link')).toHaveAttribute('href', 'https://example.test/LICENSE')
  })

  it('DESIGN.md：将写入是项目根的 DESIGN.md 与它的来源链接，不显示框架行；只列有 https 起步链接的条目', async () => {
    const user = userEvent.setup()
    renderStep({ frameworks: [] })
    expect(screen.getByTestId('np-res-tab-design-md')).toHaveAttribute('aria-selected', 'true')
    expect(rowIds()).toEqual(['design-md-claude'])
    expect(screen.queryByTestId('np-res-frameworks')).toBeNull()
    const writes = screen.getByTestId('np-res-writes')
    expect(writes).toHaveTextContent('DESIGN.md')
    expect(screen.getByTestId('np-res-writes-text')).toHaveTextContent('https://claude.test/DESIGN.md')
    expect(screen.queryByTestId('np-res-link-design_md')).toBeNull()
    expect(within(screen.getByTestId('np-res-link-home')).getByRole('link')).toHaveAttribute('href', 'https://claude.test')
    await user.click(screen.getByTestId('np-res-toggle'))
    expect(screen.getByTestId('np-res-toggle')).toHaveTextContent('移除')
  })

  it('加入 / 移除在预览头部：加入后行带勾、按钮变「移除」；每类最多一个，加入另一个即替换；移除后回到未选', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    renderStep({ onPick })
    const toggle = screen.getByTestId('np-res-toggle')
    expect(toggle).toHaveTextContent('加入')
    expect(toggle).toBeEnabled()
    await user.click(toggle)
    expect(onPick).toHaveBeenLastCalledWith('component-lib', 'any-kit')
    expect(screen.getByTestId('np-res-toggle')).toHaveTextContent('移除')
    expect(screen.getByTestId('np-res-any-kit')).toHaveAttribute('aria-label', 'Any Kit · 已加入')
    await user.click(screen.getByTestId('np-res-shadcn-ui'))
    expect(screen.getByTestId('np-res-toggle')).toHaveTextContent('加入')
    await user.click(screen.getByTestId('np-res-toggle'))
    expect(onPick).toHaveBeenLastCalledWith('component-lib', 'shadcn-ui')
    expect(screen.getByTestId('np-res-shadcn-ui')).toHaveAttribute('aria-label', 'shadcn/ui · 已加入')
    expect(screen.getByTestId('np-res-any-kit')).toHaveAttribute('aria-label', 'Any Kit')
    await user.click(screen.getByTestId('np-res-toggle'))
    expect(onPick).toHaveBeenLastCalledWith('component-lib', undefined)
    expect(screen.getByTestId('np-res-shadcn-ui')).toHaveAttribute('aria-label', 'shadcn/ui')
    expect(screen.getByTestId('np-res-toggle')).toHaveTextContent('加入')
  })

  it('已加入的条目：切走再切回仍是「移除」；键盘 Tab 到行、Enter 预览，Tab 到按钮、Enter 加入', async () => {
    const user = userEvent.setup()
    renderStep({ initial: { 'component-lib': 'shadcn-ui' } })
    expect(screen.getByTestId('np-res-shadcn-ui')).toHaveAttribute('aria-label', 'shadcn/ui · 已加入')
    await user.click(screen.getByTestId('np-res-tab-icons'))
    await user.click(screen.getByTestId('np-res-tab-component-lib'))
    await user.click(screen.getByTestId('np-res-shadcn-ui'))
    expect(screen.getByTestId('np-res-toggle')).toHaveTextContent('移除')
    await user.click(screen.getByTestId('np-res-tab-icons'))
    screen.getByTestId('np-res-phosphor').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Phosphor')
    screen.getByTestId('np-res-toggle').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('np-res-phosphor')).toHaveAttribute('aria-label', 'Phosphor · 已加入')
  })

  it('没加入前端模板：组件库 / 图标页签禁用（说明在 Tooltip），默认落在 DESIGN.md', async () => {
    const user = userEvent.setup()
    renderStep({ frameworks: [] })
    expect(screen.getByTestId('np-res-tab-component-lib')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('np-res-tab-icons')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('np-res-tab-design-md')).toHaveAttribute('aria-selected', 'true')
    await user.hover(screen.getByTestId('np-res-tab-icons'))
    expect((await screen.findAllByText('先加入匹配的前端模板')).length).toBeGreaterThan(0)
  })

  it('目录读取失败：错误与重试；载入中：转圈；该类没有可选条目：空态（可切「全部」浏览）', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const { unmount } = render(<I18nProvider><TooltipProvider><div className="h-96"><Harness failed onRetry={onRetry} /></div></TooltipProvider></I18nProvider>)
    expect(screen.getByTestId('np-res-error')).toHaveTextContent('资源目录读取失败')
    expect(screen.queryByTestId('np-res-preview')).toBeNull()
    await user.click(screen.getByTestId('np-res-error-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    unmount()
    const loading = render(<I18nProvider><TooltipProvider><div className="h-96"><Harness loading /></div></TooltipProvider></I18nProvider>)
    expect(screen.getByLabelText('加载中…')).toBeInTheDocument()
    expect(screen.queryByTestId('np-res-preview')).toBeNull()
    loading.unmount()
    renderStep({ entries: ENTRIES.filter((item) => item.id !== 'lucide' && item.id !== 'phosphor'), frameworks: ['react'] })
    await user.click(screen.getByTestId('np-res-tab-icons'))
    expect(screen.getByTestId('np-res-empty')).toHaveTextContent('没有资源')
    expect(screen.queryByTestId('np-res-preview')).toBeNull()
    await user.click(screen.getByTestId('np-res-all'))
    expect(rowIds()).toEqual(['vue-icons'])
    expect(screen.getByTestId('np-res-preview-name')).toHaveTextContent('Vue Icons')
  })

  it('任何地方不换行：行、预览标题、链接、写入块都是单行 + 截断 / 横向滚动，全名在 title', async () => {
    const user = userEvent.setup()
    const long = 'a-really-long-component-library-name-that-must-truncate-instead-of-wrapping'
    renderStep({ entries: [entry('long', long, 'component-lib', ['react'], { links: { docs: 'https://example.test/a/very/long/path/that/keeps/going/and/going' }, install: ['npx some-very-long-installer@latest add everything --yes'] })] })
    const row = screen.getByTestId('np-res-long')
    expect(row.className).toContain('whitespace-nowrap')
    expect(row.querySelector('span')?.className).toContain('truncate')
    expect(row).toHaveAttribute('title', long)
    expect(screen.getByTestId('np-res-preview-name').className).toContain('truncate')
    expect(screen.getByTestId('np-res-preview-name')).toHaveAttribute('title', long)
    expect(within(screen.getByTestId('np-res-link-docs')).getByRole('link').className).toContain('truncate')
    expect(screen.getByTestId('np-res-writes-text').className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('np-res-writes-text').className).toContain('overflow-x-auto')
    expect(screen.getByTestId('np-res-toggle').className).toContain('whitespace-nowrap')
    await user.click(screen.getByTestId('np-res-tab-design-md'))
    expect(screen.getByTestId('np-res-empty')).toBeInTheDocument()
  })
})
