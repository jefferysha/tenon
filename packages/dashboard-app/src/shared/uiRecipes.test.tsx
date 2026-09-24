import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_ICON, BUTTON_SEGMENT, BUTTON_SOLID } from './uiRecipes'

const classes = (recipe: string): string[] => recipe.split(/\s+/u)

describe('button recipes', () => {
  it.each([
    ['solid', BUTTON_SOLID],
    ['ghost', BUTTON_GHOST],
    ['danger', BUTTON_DANGER],
    ['segment', BUTTON_SEGMENT],
  ])('%s keeps a 40px minimum hit area', (_name, recipe) => {
    const heights = classes(recipe).filter((name) => /^min-h-\d+$/u.test(name))
    expect(heights).toEqual(['min-h-10'])
  })

  it('icon button is 40px square', () => {
    expect(classes(BUTTON_ICON)).toContain('size-10')
  })

  it.each([
    ['solid', BUTTON_SOLID, ['disabled:bg-fill-2', 'disabled:text-text-3']],
    ['ghost', BUTTON_GHOST, ['disabled:bg-fill', 'disabled:text-text-3']],
    ['danger', BUTTON_DANGER, ['disabled:bg-fill', 'disabled:text-text-3', 'disabled:border-border']],
    ['icon', BUTTON_ICON, ['disabled:text-text-4']],
  ])('%s disabled state swaps colours instead of fading the whole control', (_name, recipe, expected) => {
    for (const name of expected) expect(classes(recipe)).toContain(name)
    expect(recipe).not.toMatch(/disabled:opacity-/u)
  })

  it.each([
    ['solid', BUTTON_SOLID],
    ['ghost', BUTTON_GHOST],
    ['danger', BUTTON_DANGER],
    ['icon', BUTTON_ICON],
  ])('%s hover feedback only applies while enabled', (_name, recipe) => {
    expect(classes(recipe).filter((name) => name.startsWith('hover:'))).toEqual([])
    expect(classes(recipe).some((name) => name.startsWith('enabled:hover:'))).toBe(true)
  })
})

/** 源码里所有生产 .tsx（测试除外）。 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : []
  })
}

const RECIPE_CLASS = /className=\{([^}]*\$\{BUTTON_[A-Z]+\}[^}]*|cn\(BUTTON_[A-Z]+[^)]*\))\}/gu
const BARE_HOVER = /(^|[\s'"`])hover:/u

describe('recipe overrides', () => {
  // 配方的 hover 挂在 enabled: 上；覆写若写裸 hover:，禁用按钮悬停仍会变色，且与配方的 enabled:hover: 打架。
  it('a className built on a BUTTON_* recipe overrides hover with enabled:hover:', () => {
    const offenders: string[] = []
    const files = sources(join(process.cwd(), 'packages/dashboard-app/src'))
    expect(files.length).toBeGreaterThan(50)
    let recipeClasses = 0
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(RECIPE_CLASS)) {
        recipeClasses += 1
        if (BARE_HOVER.test(match[1] ?? '')) offenders.push(`${file}: ${match[1] ?? ''}`)
      }
    }
    expect(recipeClasses).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })
})
