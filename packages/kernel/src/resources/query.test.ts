import { describe, expect, test } from 'vitest'
import { filterResources, licenseModes } from './query.js'
import { RESOURCE_SCHEMA, type ResourceCategory, type ResourceEntry, type ResourceFramework, type ResourceStyling } from './types.js'

interface Seed {
  id: string
  name?: string
  category: ResourceCategory
  frameworks?: readonly ResourceFramework[]
  styling?: readonly ResourceStyling[]
  use?: string
  redistributable?: boolean
  attribution?: boolean
}

function make(seed: Seed): { entry: ResourceEntry } {
  const redistributable = seed.redistributable ?? true
  return {
    entry: {
      schema: RESOURCE_SCHEMA,
      id: seed.id,
      name: seed.name ?? seed.id,
      category: seed.category,
      frameworks: seed.frameworks ?? [],
      styling: seed.styling ?? [],
      ...(seed.use === undefined ? {} : { use: seed.use }),
      baseline: false,
      license: {
        spdx: 'MIT',
        url: 'https://example.com/LICENSE',
        redistributable,
        attribution: seed.attribution ?? false,
        commercial: 'free',
        ...(redistributable && !(seed.attribution ?? false) ? {} : { notice: '声明' }),
      },
      install: [],
      skills: [],
      links: { home: 'https://example.com' },
      verified_at: '2026-09-15',
    },
  }
}

const CATALOG = [
  make({ id: 'lucide', name: 'Lucide', category: 'icons', frameworks: ['web', 'react', 'vue'] }),
  make({ id: 'sf-symbols', name: 'SF Symbols', category: 'icons', frameworks: ['swiftui'], redistributable: false }),
  make({ id: 'font-awesome-free', name: 'Font Awesome Free', category: 'icons', frameworks: ['web', 'react'], attribution: true }),
  make({ id: 'iconify', name: 'Iconify', category: 'icons' }),
  make({ id: 'shadcn-ui', name: 'shadcn/ui', category: 'component-lib', frameworks: ['react'], styling: ['tailwind'] }),
  make({ id: 'mui', name: 'MUI', category: 'component-lib', frameworks: ['react'], styling: ['css-in-js'] }),
  make({ id: 'zustand', name: 'Zustand', category: 'state', frameworks: ['react'], use: '小型全局状态' }),
]

const ids = (query: Parameters<typeof filterResources>[1]): string[] => filterResources(CATALOG, query).map((item) => item.entry.id)

describe('filterResources', () => {
  test('acceptance probe: react + tailwind + icons returns every framework-agnostic icon set', () => {
    expect(ids({ framework: 'react', styling: 'tailwind', category: 'icons' })).toEqual(['font-awesome-free', 'iconify', 'lucide'])
  })

  test('empty frameworks and styling match any value', () => {
    expect(ids({ framework: 'swiftui', category: 'icons' })).toEqual(['iconify', 'sf-symbols'])
    expect(ids({ styling: 'css-in-js', category: 'component-lib' })).toEqual(['mui'])
  })

  test('license facets split redistributable, link-only and attribution', () => {
    expect(ids({ license: 'link-only' })).toEqual(['sf-symbols'])
    expect(ids({ license: 'attribution' })).toEqual(['font-awesome-free'])
    expect(ids({ license: 'redistributable', category: 'icons' })).toEqual(['font-awesome-free', 'iconify', 'lucide'])
  })

  test('text search covers id, name and use', () => {
    expect(ids({ text: 'SHADCN' })).toEqual(['shadcn-ui'])
    expect(ids({ text: 'Font Awesome' })).toEqual(['font-awesome-free'])
    expect(ids({ text: '全局状态' })).toEqual(['zustand'])
  })

  test('order is category table then name', () => {
    expect(ids({})).toEqual(['mui', 'shadcn-ui', 'font-awesome-free', 'iconify', 'lucide', 'sf-symbols', 'zustand'])
  })
})

describe('licenseModes', () => {
  test('redistributable and link-only are exclusive; attribution is additive', () => {
    expect(licenseModes(CATALOG[0]?.entry as ResourceEntry)).toEqual(['redistributable'])
    expect(licenseModes(CATALOG[1]?.entry as ResourceEntry)).toEqual(['link-only'])
    expect(licenseModes(CATALOG[2]?.entry as ResourceEntry)).toEqual(['redistributable', 'attribution'])
  })
})
