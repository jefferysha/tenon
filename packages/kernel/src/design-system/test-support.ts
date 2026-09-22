/**
 * 用例夹具：在临时仓库里写一套「就绪」的设计体系，供立项前置条件为真的场景使用。
 * 只给测试用；生产代码里 DESIGN.md 由设计体系任务经 hue 产出。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESIGN_MD_PATH, DESIGN_MODEL_PATH, DESIGN_PREVIEWS, DESIGN_SCHEMA, DESIGN_SECTIONS } from './check.js'

// tokens.colors.light/dark 的 background/text1 是 hue 对比度门的输入；缺了它就只报 WARN、
// 整道检查静默跳过（见 check.ts DESIGN_MODEL_CONTRAST_PATHS），所以「就绪」夹具必须带上。
const MODEL = [
  'name: Ridge',
  'primitives:',
  '  gray: {}',
  'tokens:',
  '  colors:',
  '    light:',
  '      background: "#ffffff"',
  '      text1: "#111111"',
  '    dark:',
  '      background: "#111111"',
  '      text1: "#f5f5f5"',
  'components:',
  '  button: {}',
  '',
].join('\n')

export function readyDesignMd(icons = 'lucide'): string {
  return [
    '---', `schema: ${DESIGN_SCHEMA}`, `model: ${DESIGN_MODEL_PATH}`, `icons: ${icons}`, '---', '',
    '# Ridge Design System', '',
    ...DESIGN_SECTIONS.flatMap((section, index) => [
      `## ${index + 1}. ${section}`, '',
      section === 'Previews' ? DESIGN_PREVIEWS.map((path) => `- [${path}](${path})`).join('\n') : '正文。', '',
    ]),
  ].join('\n')
}

export function writeReadyDesignSystem(root: string, icons = 'lucide'): void {
  mkdirSync(join(root, 'design'), { recursive: true })
  writeFileSync(join(root, DESIGN_MD_PATH), readyDesignMd(icons), 'utf8')
  writeFileSync(join(root, DESIGN_MODEL_PATH), MODEL, 'utf8')
  for (const path of DESIGN_PREVIEWS) writeFileSync(join(root, path), '<html></html>', 'utf8')
}

export function removeDesignSystem(root: string): void {
  rmSync(join(root, DESIGN_MD_PATH), { force: true })
  rmSync(join(root, 'design'), { recursive: true, force: true })
}
