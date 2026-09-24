import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const cssPath = existsSync('src/index.css') ? 'src/index.css' : 'packages/dashboard-app/src/index.css'
const css = readFileSync(cssPath, 'utf8')

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!match?.[1]) throw new Error(`missing CSS block: ${selector}`)
  return match[1]
}

function hexToken(source: string, name: string): string {
  const match = source.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6}|var\\(--([a-z0-9-]+)\\))`, 'i'))
  if (!match?.[1]) throw new Error(`missing color token: --${name}`)
  return match[2] ? hexToken(source, match[2]) : match[1]
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('theme semantic foreground contrast', () => {
  const light = block(':root')
  const systemDark = block(':root:not([data-theme="light"])')
  const explicitLight = block(':root[data-theme="light"]')
  const dark = block(':root[data-theme="dark"]')

  it.each([
    ['default light primary', hexToken(light, 'btn-fg'), hexToken(light, 'btn-bg')],
    ['system dark primary', hexToken(systemDark, 'btn-fg'), hexToken(systemDark, 'btn-bg')],
    ['explicit light primary', hexToken(explicitLight, 'btn-fg'), hexToken(explicitLight, 'btn-bg')],
    ['explicit dark primary', hexToken(dark, 'btn-fg'), hexToken(dark, 'btn-bg')],
    ['light success on card', hexToken(light, 'green-d'), hexToken(light, 'card')],
    ['system dark success on card', hexToken(systemDark, 'green-d'), hexToken(systemDark, 'card')],
    ['explicit light success on card', hexToken(explicitLight, 'green-d'), hexToken(explicitLight, 'card')],
    ['light success on code', hexToken(light, 'green-d'), hexToken(light, 'code-bg')],
    ['explicit dark success on card', hexToken(dark, 'green-d'), hexToken(dark, 'card')],
  ])('%s stays at WCAG AA for normal text', (_label, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })

  const themes = [
    ['default light', light],
    ['system dark', systemDark],
    ['explicit light', explicitLight],
    ['explicit dark', dark],
  ] as const

  // text-2 / text-3 carry readable copy on every neutral ground; text-4 is decoration only.
  it.each(themes.flatMap(([label, source]) =>
    (['text-2', 'text-3'] as const).flatMap((fg) =>
      (['card', 'bg', 'fill', 'surface-detail'] as const).map((bg) => [`${label} ${fg} on ${bg}`, source, fg, bg] as const))))(
    '%s stays at WCAG AA for normal text',
    (_label, source, fg, bg) => {
      expect(contrast(hexToken(source, fg), hexToken(source, bg))).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(themes)('%s keeps text-4 as a quieter decorative step below text-3', (_label, source) => {
    const card = hexToken(source, 'card')
    expect(contrast(hexToken(source, 'text-4'), card)).toBeLessThan(contrast(hexToken(source, 'text-3'), card))
  })

  // Disabled buttons swap to fill-2 ground + text-3 (uiRecipes) instead of fading the whole control.
  it.each(themes)('%s disabled button label stays legible (≥ 3:1)', (_label, source) => {
    expect(contrast(hexToken(source, 'text-3'), hexToken(source, 'fill-2'))).toBeGreaterThanOrEqual(3)
  })

  it('uses the shared ease-out token for Tailwind transitions', () => {
    expect(css).toContain('--default-transition-timing-function: var(--ease-out);')
  })
})
