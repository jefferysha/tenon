/**
 * `tenon resources list/show` e2e —— 真 kernel + 真 payload（仓库里的 templates/resources/builtin）。
 * 覆盖：筛选组合的 id 集合 / --json schema / show 的许可与技能行 / 未知枚举与未知 id exit 1。
 */
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'

describe('tenon resources —— 只读目录', () => {
  let h: Harness
  beforeEach(async () => { h = await freshHarness() })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  test('list --framework react --styling tailwind --category icons：图标全命中（图标不限样式）', async () => {
    expect(await h.run(['resources', 'list', '--framework', 'react', '--styling', 'tailwind', '--category', 'icons', '--json'])).toBe(0)
    const parsed = JSON.parse(h.out.join('\n')) as { entries: { id: string; category: string }[]; errors: unknown[] }
    expect(parsed.errors).toEqual([])
    expect(parsed.entries.map((entry) => entry.id).sort()).toEqual([
      'font-awesome-free', 'heroicons', 'iconify', 'iconoir', 'lucide',
      'material-symbols', 'phosphor', 'radix-icons', 'tabler-icons',
    ])
    expect(parsed.entries.every((entry) => entry.category === 'icons')).toBe(true)
  })

  test('list 文本模式：固定列，一行一条', async () => {
    expect(await h.run(['resources', 'list', '--query', 'zustand'])).toBe(0)
    expect(h.out).toHaveLength(1)
    expect(h.out[0]).toMatch(/^zustand\s+状态管理\s+MIT · 可再分发 · 免费\s+Zustand$/u)
    expect(h.err).toEqual([])
  })

  test('list --license link-only 只留不可再分发的条目', async () => {
    expect(await h.run(['resources', 'list', '--license', 'link-only', '--category', 'animation', '--json'])).toBe(0)
    const parsed = JSON.parse(h.out.join('\n')) as { entries: { id: string }[] }
    expect(parsed.entries.map((entry) => entry.id)).toEqual(['gsap'])
  })

  test('show gsap：仅链接 + 八个技能 + 安装命令', async () => {
    expect(await h.run(['resources', 'show', 'gsap'])).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain('仅链接')
    expect(text).toContain('技能：gsap-core, gsap-timeline, gsap-scrolltrigger, gsap-plugins, gsap-utils, gsap-react, gsap-performance, gsap-frameworks')
    expect(text).toContain('安装：pnpm add gsap @gsap/react')
    expect(text).toContain('来源：内置')
  })

  test('show --json 带 source 与许可模式', async () => {
    expect(await h.run(['resources', 'show', 'react-bits', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      id: 'react-bits', source: 'builtin', baseline: true, modes: ['link-only'],
    })
  })

  test('未知枚举值与未知 id → exit 1', async () => {
    expect(await h.run(['resources', 'list', '--framework', 'solid'])).toBe(1)
    expect(h.err.join('\n')).toContain('--framework 只接受：web, react')
    expect(await h.run(['resources', 'show', 'ghost'])).toBe(1)
    expect(h.err.join('\n')).toContain('未知资源：ghost')
  })

  test('bare resources（无子命令）→ usage exit 1', async () => {
    expect(await h.run(['resources'])).toBe(1)
    expect(h.err.join('\n')).toContain('用法：tenon resources')
  })
})
