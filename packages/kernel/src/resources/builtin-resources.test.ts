import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseResourceEntry } from './parse.js'
import { serializeResourceEntry } from './serialize.js'
import { validateResourceEntry } from './validate.js'
import type { ResourceEntry } from './types.js'

const BUILTIN = fileURLToPath(new URL('../../../../templates/resources/builtin', import.meta.url))
const SOURCES = fileURLToPath(new URL('../../../../skills/sources.yaml', import.meta.url))

const files = readdirSync(BUILTIN).sort()
const entries = new Map<string, ResourceEntry>(
  files.filter((name) => name.endsWith('.yaml'))
    .map((name) => [name, parseResourceEntry(readFileSync(join(BUILTIN, name), 'utf8'))]),
)
const byId = (id: string): ResourceEntry => {
  const entry = entries.get(`${id}.yaml`)
  if (!entry) throw new Error(`missing builtin resource ${id}`)
  return entry
}

describe('builtin resource catalog', () => {
  test('the payload directory holds catalog files only', () => {
    expect(files.filter((name) => !name.endsWith('.yaml'))).toEqual([])
    expect(files.length).toBeGreaterThan(80)
  })

  test('every entry parses, validates and round-trips byte-identically', () => {
    for (const name of files) {
      const text = readFileSync(join(BUILTIN, name), 'utf8')
      const entry = entries.get(name) as ResourceEntry
      expect([name, validateResourceEntry(entry, name)]).toEqual([name, []])
      expect([name, serializeResourceEntry(entry)]).toEqual([name, text])
    }
  })

  test('the resources the frontend block and the design system depend on are present', () => {
    for (const id of ['gsap', 'react-bits', 'shadcn-ui', 'lucide', 'zustand', 'tailwindcss']) {
      expect(byId(id).id).toBe(id)
    }
    const index = [...entries.values()].filter((entry) => entry.category === 'design-md' && !entry.id.startsWith('design-md-'))
    expect(index.length).toBeGreaterThanOrEqual(2)
  })

  test('gsap declares all eight upstream skills and stays link-only and baseline', () => {
    expect([...byId('gsap').skills]).toEqual([
      'gsap-core', 'gsap-timeline', 'gsap-scrolltrigger', 'gsap-plugins',
      'gsap-utils', 'gsap-react', 'gsap-performance', 'gsap-frameworks',
    ])
    for (const id of ['gsap', 'react-bits']) {
      expect([id, byId(id).license.redistributable, byId(id).baseline]).toEqual([id, false, true])
    }
  })

  test('every declared skill id is an installed upstream skill', () => {
    const sources = readFileSync(SOURCES, 'utf8')
    const installed = new Set([...sources.matchAll(/^ {2}([a-z0-9-]+):/gmu)].map((match) => match[1]))
    for (const entry of entries.values()) {
      for (const skill of entry.skills) expect([entry.id, skill, installed.has(skill)]).toEqual([entry.id, skill, true])
    }
  })

  test('brand DESIGN.md entries ship link-only', () => {
    const brands = [...entries.values()].filter((entry) => entry.id.startsWith('design-md-'))
    expect(brands.length).toBeGreaterThanOrEqual(70)
    for (const entry of brands) {
      expect([entry.id, entry.category, entry.license.redistributable]).toEqual([entry.id, 'design-md', false])
      expect(entry.links.design_md).toMatch(/^https:\/\/raw\.githubusercontent\.com\//u)
    }
  })

  test('hue icon kits all resolve to an icons entry', () => {
    const icons = [...entries.values()].filter((entry) => entry.category === 'icons').map((entry) => entry.id)
    for (const kit of ['phosphor', 'lucide', 'tabler-icons', 'iconoir', 'material-symbols', 'heroicons']) {
      expect([kit, icons.includes(kit)]).toEqual([kit, true])
    }
  })

  test('the R2 entries v0 templates, coss ui and Skiper UI are present; v0 and Skiper are link-only', () => {
    expect([byId('v0-templates').category, byId('coss-ui').category, byId('skiper-ui').category])
      .toEqual(['template', 'motion-components', 'motion-components'])
    for (const id of ['v0-templates', 'skiper-ui']) {
      const entry = byId(id)
      expect([id, entry.license.redistributable, entry.install]).toEqual([id, false, []])
      expect(entry.license.notice).toMatch(/仅浏览与链接/u)
    }
    expect(byId('v0-templates').links.home).toBe('https://v0.app/templates')
    expect(byId('coss-ui').links.home).toBe('https://coss.com/ui')
    expect(byId('skiper-ui').links.home).toBe('https://skiper-ui.com')
  })

  test('link-only entries carry a notice and never an install of their source', () => {
    for (const entry of entries.values()) {
      if (entry.license.redistributable && !entry.license.attribution) continue
      expect([entry.id, (entry.license.notice ?? '') !== '']).toEqual([entry.id, true])
    }
  })
})
