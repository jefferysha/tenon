import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'packages/dashboard-app/src/index.css'), 'utf8')
const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), 'packages/dashboard-app/src', relativePath), 'utf8')

describe('Dashboard 电脑端设计系统契约', () => {
  it('Tailwind 只扫描 Dashboard src，避免治理文档改变生产资源哈希', () => {
    expect(css).toMatch(/@import\s+"tailwindcss"\s+source\("\."\);/)
  })

  it('主动作使用 accent 语义，不复用 success green', () => {
    expect(css).toMatch(/--btn-bg:\s*var\(--accent\)/)
    expect(css).toMatch(/--btn-hover:\s*var\(--accent-d\)/)
    expect(css).toMatch(/--color-primary:\s*var\(--btn-bg\)/)
    expect(css).not.toMatch(/--color-primary:\s*var\(--green\)/)
  })

  it('排版与圆角刻度集中在 @theme static，并清空 Tailwind 默认档位', () => {
    const block = /@theme\s+static\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/--text-\*:\s*initial/)
    expect(block).toMatch(/--radius-\*:\s*initial/)
    // 7 级字号 + 4 级圆角就是全部档位；多一档就等于刻度重新散开。
    expect([...block.matchAll(/^\s*--text-([a-z]+):/gm)].map((match) => match[1])).toEqual([
      'micro', 'caption', 'body', 'base', 'title', 'section', 'page',
    ])
    expect([...block.matchAll(/^\s*--radius-([a-z]+):/gm)].map((match) => match[1])).toEqual(['xs', 'sm', 'md', 'lg'])
    // static 而非 inline：progress.css / workbench.css 要能直接 var() 引同一份刻度。
    expect(css).not.toMatch(/@theme\s+inline\s+static/)
  })

  it('reduced-motion 为 CSS transition、animation 和滚动提供全局终态兜底', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(css).toMatch(/transition-duration:\s*0s\s*!important/)
    expect(css).toMatch(/animation-duration:\s*0s\s*!important/)
    expect(css).toMatch(/scroll-behavior:\s*auto\s*!important/)
  })

  it('交互动效只声明实际变化的属性，不使用会意外动画布局的 transition-all', () => {
    const sourceFiles = [
      'components/ui/button.tsx',
      'components/ui/switch.tsx',
      'components/ui/tabs.tsx',
      'shell/TopBar.tsx',
      'shell/ThreeColumns.tsx',
    ]
    for (const relativePath of sourceFiles) {
      expect(readSource(relativePath), relativePath).not.toContain('transition-all')
    }
  })

  it.each([
    'components/ui/button.tsx',
    'components/ui/input.tsx',
    'components/ui/select.tsx',
    'components/ui/dialog.tsx',
    'components/ui/dropdown-menu.tsx',
    'components/ui/tabs.tsx',
    'components/ui/table.tsx',
    'components/ui/badge.tsx',
    'components/ui/tooltip.tsx',
  ])('%s 明确声明 reduced-motion 终态', (relativePath) => {
    expect(readSource(relativePath)).toMatch(/motion-reduce:/)
  })

  it('App 清理 toast tween，并让 error/status 使用不同 live-region 语义', () => {
    expect(readSource('shared/useFlash.ts')).toMatch(/return \(\) => tween\.kill\(\)/)
    expect(readSource('App.tsx')).toMatch(/role=\{flash\.kind === 'error' \? 'alert' : 'status'\}/)
  })
})
