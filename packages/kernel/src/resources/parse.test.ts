import { describe, expect, test } from 'vitest'
import { ResourceParseError, parseResourceEntry } from './parse.js'
import { serializeResourceEntry } from './serialize.js'
import { RESOURCE_ENTRY_MAX_BYTES } from './types.js'

const CANONICAL = [
  'schema: tenon-resource/v1',
  'id: react-bits',
  'name: React Bits',
  'category: motion-components',
  'frameworks: [react]',
  'styling: [tailwind, css]',
  'use: 文字动画、背景与交互动效',
  'baseline: true',
  'license:',
  '  spdx: MIT AND LicenseRef-Commons-Clause',
  '  url: https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md',
  '  redistributable: false',
  '  attribution: false',
  '  commercial: freemium',
  '  notice: 不得出售或再分发组件本身',
  'install:',
  '  - npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-TW',
  'skills: []',
  'links:',
  '  home: https://reactbits.dev',
  '  source: https://github.com/DavidHDev/react-bits',
  '  registry: https://reactbits.dev/r',
  '  llms_txt: https://reactbits.dev/llms.txt',
  'verified_at: 2026-09-15',
  '',
].join('\n')

function error(text: string): ResourceParseError {
  try {
    parseResourceEntry(text)
  } catch (thrown) {
    if (thrown instanceof ResourceParseError) return thrown
    throw thrown
  }
  throw new Error('expected a parse error')
}

describe('parseResourceEntry', () => {
  test('canonical entry round-trips byte-identically', () => {
    const entry = parseResourceEntry(CANONICAL)
    expect(entry.id).toBe('react-bits')
    expect(entry.category).toBe('motion-components')
    expect(entry.frameworks).toEqual(['react'])
    expect(entry.styling).toEqual(['tailwind', 'css'])
    expect(entry.baseline).toBe(true)
    expect(entry.license.redistributable).toBe(false)
    expect(entry.install).toEqual(['npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-TW'])
    expect(entry.skills).toEqual([])
    expect(entry.links.llms_txt).toBe('https://reactbits.dev/llms.txt')
    expect(serializeResourceEntry(entry)).toBe(CANONICAL)
  })

  test('comments and blank lines are ignored but keep line numbers', () => {
    const text = CANONICAL.replace('id: react-bits', '# 说明\n\nid: react-bits')
    expect(parseResourceEntry(text).id).toBe('react-bits')
    expect(error(text.replace('category: motion-components', 'category: widgets')).line).toBe(6)
  })

  test('quoted scalar keeps a colon and round-trips', () => {
    const text = CANONICAL.replace('  notice: 不得出售或再分发组件本身', '  notice: "许可: 不得再分发"')
    const entry = parseResourceEntry(text)
    expect(entry.license.notice).toBe('许可: 不得再分发')
    expect(serializeResourceEntry(entry)).toContain('  notice: "许可: 不得再分发"')
  })

  test('inline install list is rejected with its line', () => {
    const broken = CANONICAL.replace('install:\n  - npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-TW', 'install: [npm]')
    const failure = error(broken)
    expect(failure.line).toBe(16)
    expect(failure.message).toContain('install 必须是 - 块列表或 []')
  })

  test('unknown top-level key reports its line', () => {
    const failure = error(CANONICAL.replace('baseline: true', 'popularity: 10'))
    expect(failure.line).toBe(8)
    expect(failure.message).toBe("第 8 行：出现未知字段 'popularity'")
  })

  test('unknown license key and duplicate key are rejected', () => {
    expect(error(CANONICAL.replace('  commercial: freemium', '  price: 10')).message).toContain("license 出现未知字段 'price'")
    expect(error(CANONICAL.replace('skills: []', 'skills: []\nskills: []')).message).toContain('重复声明 skills')
  })

  test('unknown enum values name the accepted set', () => {
    expect(error(CANONICAL.replace('frameworks: [react]', 'frameworks: [solid]')).message).toContain('frameworks 只接受：web, react')
    expect(error(CANONICAL.replace('styling: [tailwind, css]', 'styling: [bem]')).message).toContain('styling 只接受：tailwind, css')
    expect(error(CANONICAL.replace('  commercial: freemium', '  commercial: trial')).message)
      .toContain('license.commercial 只接受：free, freemium, paid')
  })

  test('missing block, wrong indent and bad boolean are rejected', () => {
    expect(error(CANONICAL.replace('license:\n', 'license: MIT\n')).message).toContain('license 必须是缩进块')
    expect(error(CANONICAL.replace('  spdx: MIT', '    spdx: MIT')).message).toContain('license 的子键必须缩进 2 空格')
    expect(error(CANONICAL.replace('baseline: true', 'baseline: yes')).message).toContain('baseline 只接受 true 或 false')
  })

  test('missing required field is reported', () => {
    expect(error(CANONICAL.replace('verified_at: 2026-09-15\n', '')).message).toContain('缺字段 verified_at')
    expect(error(CANONICAL.replace(/links:\n(?: {2}\S+: \S+\n)+/u, '')).message).toContain('缺字段 links')
  })

  test('oversize entry is rejected', () => {
    const padding = `# ${'x'.repeat(RESOURCE_ENTRY_MAX_BYTES)}\n`
    expect(error(`${padding}${CANONICAL}`).message).toContain(`条目超过 ${RESOURCE_ENTRY_MAX_BYTES} 字节`)
  })
})
