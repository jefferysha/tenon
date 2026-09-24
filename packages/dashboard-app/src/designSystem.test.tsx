import { existsSync, readFileSync } from 'node:fs'
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
    // static 而非 inline：页面级裸 CSS 要能直接 var() 引同一份刻度。
    expect(css).not.toMatch(/@theme\s+inline\s+static/)
  })

  it('React Flow 控件接到项目 token，暗色不再是白块，按钮点击区 40px', () => {
    const vars = /\.react-flow\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(vars).toMatch(/--xy-controls-button-background-color:\s*var\(--card\)/)
    expect(vars).toMatch(/--xy-controls-button-background-color-hover:\s*var\(--fill\)/)
    expect(vars).toMatch(/--xy-controls-button-color:\s*var\(--text-2\)/)
    expect(vars).toMatch(/--xy-controls-button-border-color:\s*var\(--border\)/)
    const button = /\.react-flow \.react-flow__controls-button\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(button).toMatch(/width:\s*40px/)
    expect(button).toMatch(/height:\s*40px/)
  })

  it('text-4 暴露为工具类颜色；默认控件高度 40px', () => {
    expect(css).toMatch(/--color-text-4:\s*var\(--text-4\)/)
    expect(css).toMatch(/--control-md:\s*40px/)
  })

  it('只有一个对话框实现：shared/Dialog 基于 Radix，不再保留 vendored ui/dialog', () => {
    expect(existsSync(join(process.cwd(), 'packages/dashboard-app/src/components/ui/dialog.tsx'))).toBe(false)
    expect(readSource('shared/Dialog.tsx')).toMatch(/from 'radix-ui'/)
  })

  it('reduced-motion 只留 ≤100ms 的淡入淡出与颜色，位移 / 缩放 / 旋转全部去掉', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/transition-duration:\s*100ms\s*!important/)
    expect(block).toMatch(/transition-property:\s*opacity, color, background-color, border-color[^;]*!important/)
    expect(block).not.toMatch(/transition-property:[^;]*transform/)
    expect(block).toMatch(/animation-duration:\s*0s\s*!important/)
    expect(block).toMatch(/\[class\*='animate-in'\],\s*\[class\*='animate-out'\]\s*\{\s*animation-duration:\s*100ms\s*!important/)
    for (const name of ['enter-translate-x', 'enter-translate-y', 'exit-translate-x', 'exit-translate-y']) {
      expect(block).toContain(`--tw-${name}: 0 !important`)
    }
    expect(block).toContain('--tw-enter-scale: 1 !important')
    expect(block).toContain('--tw-exit-scale: 1 !important')
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/)
  })

  it('圆角刻度：控件 8 / 列表与弹层 10 / 对话框与抽屉 14 / 行内 4', () => {
    const block = /@theme\s+static\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(css).toMatch(/--radius:\s*10px/)
    expect(block).toMatch(/--radius-xs:\s*4px/)
    expect(block).toMatch(/--radius-sm:\s*8px/)
    expect(block).toMatch(/--radius-md:\s*var\(--radius\)/)
    expect(block).toMatch(/--radius-lg:\s*14px/)
  })

  it('动效与字距刻度集中在 @theme static，生成 ease-out / ease-in-out / ease-exit 工具类', () => {
    const block = /@theme\s+static\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/--ease-out:\s*cubic-bezier\(\.22,1,\.36,1\)/)
    expect(block).toMatch(/--ease-in-out:\s*cubic-bezier\(\.65,0,\.35,1\)/)
    expect(block).toMatch(/--ease-exit:\s*cubic-bezier\(\.4,0,1,1\)/)
    for (const [name, value] of [['press', 80], ['fast', 140], ['base', 180], ['panel', 240], ['exit', 120], ['layout', 300]] as const) {
      expect(block).toMatch(new RegExp(`--dur-${name}:\\s*${value}ms`))
    }
    expect(block).toMatch(/--text-page--letter-spacing:\s*-0\.02em/)
    expect(block).toMatch(/--text-section--letter-spacing:\s*-0\.015em/)
    expect(block).toMatch(/--text-title--letter-spacing:\s*-0\.01em/)
    expect(css).toMatch(/--default-transition-duration:\s*var\(--dur-fast\)/)
  })

  it('三段主题都声明三级阴影与 tooltip token，并暴露为颜色工具类', () => {
    for (const selector of [/^:root \{/m, /:root:not\(\[data-theme="light"\]\) \{/, /:root\[data-theme="light"\] \{/, /:root\[data-theme="dark"\] \{/]) {
      const start = css.search(selector)
      expect(start).toBeGreaterThan(-1)
      const body = css.slice(start, css.indexOf('}', start))
      for (const token of ['--shadow:', '--shadow-2:', '--shadow-3:', '--tooltip-bg:', '--tooltip-fg:', '--tooltip-border:', '--surface-raised:']) {
        expect(body, `${selector} ${token}`).toContain(token)
      }
    }
    expect(css).toMatch(/--color-tooltip-bg:\s*var\(--tooltip-bg\)/)
    expect(css).toMatch(/--color-tooltip-fg:\s*var\(--tooltip-fg\)/)
  })

  it('Inter 只引入 latin 子集，中文走系统黑体', () => {
    expect(css).toContain("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")
    expect(css).not.toMatch(/inter-(?:cyrillic|greek|vietnamese|latin-ext)/)
    expect(css).toMatch(/--font:\s*"Inter Variable", "PingFang SC", "Microsoft YaHei UI"[^;]*"Noto Sans CJK SC"/)
  })

  it('基础层：选区用 accent-t，细滚动条，行级控件悬停有过渡', () => {
    const base = /@layer base \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(base).toMatch(/::selection\s*\{\s*background:\s*var\(--accent-t\)/)
    expect(base).toMatch(/scrollbar-width:\s*thin/)
    expect(base).toMatch(/scrollbar-color:\s*var\(--border-2\) transparent/)
    expect(base).toMatch(/button,\s*a,\s*\[role='option'\],\s*\[role='menuitem'\]\s*\{\s*transition-property:\s*background-color, color, border-color, box-shadow;\s*transition-duration:\s*var\(--dur-fast\);\s*transition-timing-function:\s*var\(--ease-out\)/)
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
    'components/ui/dropdown-menu.tsx',
    'components/ui/tabs.tsx',
    'components/ui/table.tsx',
    'components/ui/badge.tsx',
    'components/ui/tooltip.tsx',
  ])('%s 明确声明 reduced-motion 终态', (relativePath) => {
    expect(readSource(relativePath)).toMatch(/motion-reduce:/)
  })

  it('toast 是 rounded-md 面板，不是药丸', () => {
    const toast = /ref=\{flashRef\}\s*className=\{`([^`]*)/.exec(readSource('App.tsx'))?.[1] ?? ''
    expect(toast).toContain('rounded-md')
    expect(toast).not.toContain('rounded-full')
  })

  it('App 清理 toast tween，并让 error/status 使用不同 live-region 语义', () => {
    expect(readSource('shared/useFlash.ts')).toMatch(/return \(\) => tween\.kill\(\)/)
    expect(readSource('App.tsx')).toMatch(/role=\{flash\.kind === 'error' \? 'alert' : 'status'\}/)
  })
})
