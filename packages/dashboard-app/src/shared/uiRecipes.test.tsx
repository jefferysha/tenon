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
