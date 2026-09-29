import { describe, expect, it } from 'vitest'
import type { TemplateSummary } from '../api/instructionsDecoders'
import type { ResourceEntry } from '../api/resourceTypes'
import { availableResources, catalogFor, effectivePicks, frontendFrameworks } from './designResources'

const license = { spdx: 'MIT', url: 'https://x/LICENSE', redistributable: true, attribution: false, commercial: 'free' } as const
function entry(id: string, name: string, category: ResourceEntry['category'], frameworks: ResourceEntry['frameworks'], links: ResourceEntry['links'] = {}): ResourceEntry {
  return { schema: 'tenon-resource/v1', id, name, category, frameworks, styling: [], baseline: false, license, install: [], skills: [], links, verified_at: '2026-09-16' }
}

const ENTRIES = [
  entry('shadcn-ui', 'shadcn/ui', 'component-lib', ['react', 'next']),
  entry('element-plus', 'Element Plus', 'component-lib', ['vue']),
  entry('any-kit', 'Any Kit', 'component-lib', []),
  entry('lucide', 'Lucide', 'icons', []),
  entry('design-md-claude', 'Claude', 'design-md', [], { design_md: 'https://x/DESIGN.md' }),
  entry('design-md-http', 'Plain', 'design-md', [], { design_md: 'http://x/DESIGN.md' }),
  entry('gsap', 'GSAP', 'animation', []),
]

const summary = (category: TemplateSummary['category'], id: string, frameworks: string[]): TemplateSummary =>
  ({ source: 'builtin', category, id, title: id, frameworks, digest: `sha256:${id}`, errors: [] })

describe('资源步骤的纯逻辑', () => {
  it('frontendFrameworks：只取已加入的前端模板的框架（去重）', () => {
    const templates = [summary('frontend', 'react', ['react']), summary('frontend', 'next', ['react', 'next']), summary('state', 'pinia', ['vue'])]
    expect(frontendFrameworks(templates, [
      { source: 'builtin', category: 'frontend', id: 'react' },
      { source: 'builtin', category: 'frontend', id: 'next' },
      { source: 'builtin', category: 'state', id: 'pinia' },
    ])).toEqual(['react', 'next'])
    expect(frontendFrameworks(templates, [])).toEqual([])
  })

  it('availableResources：组件库 / 图标需要前端框架且相交（空 frameworks = 任意），按名称排序；DESIGN.md 只要 https 起步链接', () => {
    expect(availableResources(ENTRIES, 'component-lib', ['react']).map((item) => item.id)).toEqual(['any-kit', 'shadcn-ui'])
    expect(availableResources(ENTRIES, 'component-lib', [])).toEqual([])
    expect(availableResources(ENTRIES, 'icons', ['vue']).map((item) => item.id)).toEqual(['lucide'])
    expect(availableResources(ENTRIES, 'design-md', []).map((item) => item.id)).toEqual(['design-md-claude'])
  })

  it('effectivePicks：换了前端框架后不再相交的选择失效，其余保留', () => {
    const picks = { 'component-lib': 'shadcn-ui', icons: 'lucide', 'design-md': 'design-md-claude' }
    expect(effectivePicks(picks, ENTRIES, ['react'])).toEqual(picks)
    expect(effectivePicks(picks, ENTRIES, ['vue'])).toEqual({ icons: 'lucide', 'design-md': 'design-md-claude' })
    expect(effectivePicks(picks, ENTRIES, [])).toEqual({ 'design-md': 'design-md-claude' })
    expect(effectivePicks({ 'component-lib': 'ghost' }, ENTRIES, ['react'])).toEqual({})
  })

  it('catalogFor：只交给块声明过的分类；没有交集为 undefined', () => {
    const picks = { 'component-lib': 'shadcn-ui', icons: 'lucide', 'design-md': 'design-md-claude' }
    expect(catalogFor(picks, ['component-lib', 'icons', 'design-md'])).toEqual({ 'component-lib': ['shadcn-ui'], icons: ['lucide'], 'design-md': ['design-md-claude'] })
    expect(catalogFor(picks, ['icons'])).toEqual({ icons: ['lucide'] })
    expect(catalogFor(picks, [])).toBeUndefined()
    expect(catalogFor({}, ['icons'])).toBeUndefined()
  })
})
