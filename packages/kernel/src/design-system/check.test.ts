import { describe, expect, test } from 'vitest'
import { DESIGN_PREVIEWS, checkDesignSystem, type DesignFileReader } from './check.js'

const ICONS = new Set(['lucide', 'phosphor'])

const MODEL = ['name: Ridge', 'primitives:', '  gray: {}', 'tokens:', '  light: {}', 'components:', '  button: {}', ''].join('\n')

function designMd(over: { schema?: string; model?: string; icons?: string; sections?: readonly string[]; previews?: readonly string[]; extra?: string } = {}): string {
  const sections = over.sections ?? [
    'Philosophy', 'Craft Rules', 'Anti-Patterns', 'Tokens', 'Iconography', 'Hero Stage',
    'Components', 'Voice', 'Platform Mapping', 'Previews',
  ]
  const previews = over.previews ?? DESIGN_PREVIEWS
  return [
    '---',
    `schema: ${over.schema ?? 'tenon-design/v1'}`,
    `model: ${over.model ?? 'design/design-model.yaml'}`,
    `icons: ${over.icons ?? 'lucide'}`,
    '---',
    '',
    '# Ridge Design System',
    '',
    ...sections.flatMap((section, index) => [
      `## ${index + 1}. ${section}`,
      '',
      section === 'Previews' ? previews.map((path) => `- [${path}](${path})`).join('\n') : '正文。',
      '',
    ]),
    over.extra ?? '',
  ].join('\n')
}

function reader(files: Record<string, string | undefined>): DesignFileReader {
  const present: Record<string, string> = { ...Object.fromEntries(DESIGN_PREVIEWS.map((path) => [path, '<html></html>'])) }
  for (const [path, text] of Object.entries(files)) {
    if (text === undefined) delete present[path]
    else present[path] = text
  }
  return { read: (path) => present[path] ?? null }
}

const ready = (): DesignFileReader => reader({ 'DESIGN.md': designMd(), 'design/design-model.yaml': MODEL })

describe('checkDesignSystem', () => {
  test('完整的设计体系是 ready', () => {
    expect(checkDesignSystem(ready(), ICONS)).toEqual({ status: 'ready', problems: [] })
  })

  test('没有 DESIGN.md 是 missing', () => {
    expect(checkDesignSystem(reader({}), ICONS)).toEqual({ status: 'missing', problems: ['缺少 DESIGN.md'] })
  })

  test('没有 schema 标记的品牌文件是 seed', () => {
    const check = checkDesignSystem(reader({ 'DESIGN.md': '# Claude\n\ncolors: …\n' }), ICONS)
    expect(check.status).toBe('seed')
    expect(check.problems).toEqual(['DESIGN.md 缺少 schema: tenon-design/v1'])
  })

  test('model 指向别处或模型文件缺失', () => {
    expect(checkDesignSystem(reader({ 'DESIGN.md': designMd({ model: 'design/other.yaml' }), 'design/design-model.yaml': MODEL }), ICONS).problems)
      .toContain('model 必须是 design/design-model.yaml')
    expect(checkDesignSystem(reader({ 'DESIGN.md': designMd() }), ICONS).problems)
      .toContain('缺少 design/design-model.yaml')
  })

  test('模型缺顶层键逐个报出来', () => {
    const problems = checkDesignSystem(reader({ 'DESIGN.md': designMd(), 'design/design-model.yaml': 'name: Ridge\n' }), ICONS).problems
    expect(problems).toContain('design-model.yaml 缺少顶层键 primitives')
    expect(problems).toContain('design-model.yaml 缺少顶层键 tokens')
    expect(problems).toContain('design-model.yaml 缺少顶层键 components')
  })

  test('icons 必须是资源目录里的图标', () => {
    const check = checkDesignSystem(reader({ 'DESIGN.md': designMd({ icons: 'my-icons' }), 'design/design-model.yaml': MODEL }), ICONS)
    expect(check.problems).toContain('icons 必须是资源目录中的图标：my-icons')
  })

  test('缺章节与章节顺序错误', () => {
    const missing = checkDesignSystem(reader({
      'DESIGN.md': designMd({ sections: ['Philosophy', 'Craft Rules', 'Anti-Patterns', 'Tokens', 'Iconography', 'Hero Stage', 'Components', 'Voice', 'Previews'] }),
      'design/design-model.yaml': MODEL,
    }), ICONS)
    expect(missing.problems).toContain('缺少章节 ## 9. Platform Mapping')
    const swapped = checkDesignSystem(reader({
      'DESIGN.md': designMd({ sections: ['Craft Rules', 'Philosophy', 'Anti-Patterns', 'Tokens', 'Iconography', 'Hero Stage', 'Components', 'Voice', 'Platform Mapping', 'Previews'] }),
      'design/design-model.yaml': MODEL,
    }), ICONS)
    expect(swapped.problems).toContain('章节顺序错误：Craft Rules')
  })

  test('预览缺文件或没链接', () => {
    const noFile = checkDesignSystem(reader({ 'DESIGN.md': designMd(), 'design/design-model.yaml': MODEL, 'design/app-screen.html': undefined }), ICONS)
    expect(noFile.problems).toContain('缺少预览 design/app-screen.html')
    const noLink = checkDesignSystem(reader({
      'DESIGN.md': designMd({ previews: DESIGN_PREVIEWS.slice(0, 3) }),
      'design/design-model.yaml': MODEL,
    }), ICONS)
    expect(noLink.problems).toContain('Previews 未链接 design/app-screen.html')
  })

  test('占位内容与 em-dash 是硬伤', () => {
    // 占位词由字符码拼出：写成字面量会让本文件自己撞上注释诚实度门禁。
    const marker = String.fromCharCode(84, 79, 68, 79)
    const placeholders = checkDesignSystem(reader({ 'DESIGN.md': designMd({ extra: `${marker}: 补颜色\n` }), 'design/design-model.yaml': MODEL }), ICONS)
    expect(placeholders.problems).toContain(`DESIGN.md 含占位内容 ${marker}`)
    const dash = checkDesignSystem(reader({ 'DESIGN.md': designMd({ extra: '这里—有破折号\n' }), 'design/design-model.yaml': MODEL }), ICONS)
    expect(dash.problems).toContain('DESIGN.md 含 em-dash（hue 硬性规则）')
    expect(dash.status).toBe('incomplete')
  })
})
