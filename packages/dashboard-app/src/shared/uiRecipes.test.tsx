import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_ICON, BUTTON_SEGMENT, BUTTON_SOLID, INPUT, PILL, SELECT, TEXTAREA } from './uiRecipes'

const classes = (recipe: string): string[] => recipe.split(/\s+/u)

describe('列表选中态', () => {
  it('选中类串只在 uiRecipes 定义一次，其余文件只引用', () => {
    const root = join(process.cwd(), 'packages/dashboard-app/src')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) && readFileSync(path, 'utf8').includes('inset_2px_0_0_var(--sel-edge)')) hits.push(path.slice(root.length + 1))
      }
    }
    walk(root)
    expect(hits).toEqual(['shared/uiRecipes.ts'])
  })
})

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

describe('control shape and weight', () => {
  it.each([
    ['solid', BUTTON_SOLID],
    ['ghost', BUTTON_GHOST],
    ['danger', BUTTON_DANGER],
    ['icon', BUTTON_ICON],
    ['segment', BUTTON_SEGMENT],
    ['input', INPUT],
    ['select', SELECT],
    ['textarea', TEXTAREA],
    ['pill', PILL],
  ])('%s uses the 8px control radius and never a pill', (_name, recipe) => {
    expect(classes(recipe)).toContain('rounded-sm')
    expect(recipe).not.toMatch(/rounded-(?:md|lg|full)/u)
  })

  it('buttons use 600, never 700', () => {
    for (const recipe of [BUTTON_SOLID, BUTTON_GHOST, BUTTON_DANGER, BUTTON_SEGMENT, PILL]) {
      expect(classes(recipe)).toContain('font-semibold')
      expect(recipe).not.toContain('font-bold')
    }
  })

  it('row-level buttons darken on press', () => {
    expect(classes(BUTTON_GHOST)).toContain('enabled:active:bg-fill-2')
    expect(classes(BUTTON_ICON)).toContain('enabled:active:bg-fill-2')
  })

  it.each([
    ['input', INPUT],
    ['select', SELECT],
  ])('%s shares the card ground and a single accent focus ring without offset', (_name, recipe) => {
    const names = classes(recipe)
    for (const name of ['bg-card', 'border-border-2', 'focus-visible:border-(--accent)', 'focus-visible:ring-[3px]', 'focus-visible:ring-(--accent)/20']) {
      expect(names).toContain(name)
    }
    expect(recipe).not.toMatch(/ring-offset|bg-bg\b/u)
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

describe('药丸只留计数徽标、头像、状态点', () => {
  // rounded-full 只允许出现在定尺寸的圆（状态点 / 头像 / 阶段号：size-*）、计数徽标（min-w-5）与细进度条（h-1 / h-1.5）上；
  // 类别、许可、大小这类信息是纯文字，「无效」这类状态是 StatusPill 的点 + 词。
  it('生产 TSX（除 vendored components/ui）里的 rounded-full 都在允许形态上', () => {
    const offenders: string[] = []
    for (const file of sources(join(process.cwd(), 'packages/dashboard-app/src'))) {
      if (file.includes('/components/ui/')) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (!line.includes('rounded-full')) return
        if (/(^|[\s'"`])(size-\d|min-w-5|h-full|h-1(\.5)?[\s'"`])/u.test(line)) return
        offenders.push(`${file.split('/src/')[1]}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

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
