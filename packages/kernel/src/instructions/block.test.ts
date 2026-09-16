import { describe, expect, test } from 'vitest'
import { parseInstructionBlock } from './block.js'

const VALID = [
  '---',
  'id: typescript-react',
  'category: frontend',
  'title: "TypeScript + React"',
  'frameworks: [react]',
  'directory: frontend/',
  'directory_label: 前端工程根目录',
  'catalog: [component-lib, icons]',
  'variables:',
  '  - key: component.soft',
  '    default: 200',
  '  - key: app',
  '---',
  '## 前端（TypeScript + React）',
  '',
  '- 组件 {{component.soft}} 行，工程 {{app}}，项目 {{project.name}}',
  '{{catalog.component-lib}}',
  '',
  '```vue',
  '# 围栏里的井号不是标题',
  '<p>\\{{ count }}</p>',
  '```',
  '',
].join('\n')

const EXPECTED = { category: 'frontend', id: 'typescript-react' } as const

function errorsOf(text: string, expected: Parameters<typeof parseInstructionBlock>[1] = EXPECTED) {
  const parsed = parseInstructionBlock(text, expected)
  return parsed.ok ? [] : parsed.errors
}

describe('parseInstructionBlock', () => {
  test('合法块：frontmatter 全字段与正文', () => {
    const parsed = parseInstructionBlock(VALID, EXPECTED)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.block).toEqual({
      id: 'typescript-react',
      category: 'frontend',
      title: 'TypeScript + React',
      frameworks: ['react'],
      directory: 'frontend/',
      directoryLabel: '前端工程根目录',
      catalog: ['component-lib', 'icons'],
      variables: [{ key: 'component.soft', default: '200' }, { key: 'app' }],
      body: VALID.split('\n').slice(13).join('\n').trimEnd(),
    })
  })

  test('state 块 catalog_ref 与 ### 标题', () => {
    const text = '---\nid: zustand\ncategory: state\ntitle: Zustand\nframeworks: [react]\ncatalog_ref: zustand\n---\n### 状态管理（Zustand）\n\n{{catalog.ref}}\n'
    const parsed = parseInstructionBlock(text, { category: 'state', id: 'zustand' })
    expect(parsed.ok && parsed.block.catalogRef).toBe('zustand')
  })

  test('id / category 与路径不一致', () => {
    expect(errorsOf(VALID, { category: 'frontend', id: 'other' }).map((error) => error.code)).toEqual(['id-mismatch'])
    expect(errorsOf(VALID, { category: 'backend', id: 'typescript-react' }).map((error) => error.code)).toContain('category-mismatch')
  })

  test('未知键与缺少 title', () => {
    expect(errorsOf(VALID.replace('title: "TypeScript + React"', 'name: x'))).toEqual([
      { code: 'unknown-key', line: 4, detail: '未知键：name' },
      { code: 'frontmatter', detail: '缺少 title' },
    ])
  })

  test('state 块必须声明 frameworks', () => {
    const text = '---\nid: pinia\ncategory: state\ntitle: Pinia\n---\n### 状态管理（Pinia）\n'
    expect(errorsOf(text, { category: 'state', id: 'pinia' }).map((error) => error.detail)).toEqual(['state 块必须声明 frameworks'])
  })

  test('未声明的占位符报行号；{{ 带空格也不算合法占位符', () => {
    const unknown = errorsOf(VALID.replace('项目 {{project.name}}', '项目 {{nope}}'))
    expect(unknown).toEqual([{ code: 'unknown-placeholder', line: 16, detail: '无法解析的占位符：{{nope}}' }])
    const spaced = errorsOf(VALID.replace('<p>\\{{ count }}</p>', '<p>{{ count }}</p>'))
    expect(spaced).toEqual([{ code: 'unknown-placeholder', line: 21, detail: '无法解析的占位符：{{ count }}' }])
  })

  test('没有声明 catalog 分类的资源占位符是错误', () => {
    expect(errorsOf(VALID.replace('{{catalog.component-lib}}', '{{catalog.design-md}}')).map((error) => error.code)).toEqual(['unknown-placeholder'])
  })

  test('正文不允许受管块标记行、一级标题；首行必须是分类级别标题', () => {
    expect(errorsOf(`${VALID}<!-- PIPELINE:CODEX:START -->\n`).map((error) => error.code)).toEqual(['managed-marker'])
    expect(errorsOf(`${VALID}# 一级标题\n`)).toEqual([{ code: 'heading', line: 23, detail: '块内不允许一级标题' }])
    expect(errorsOf(VALID.replace('## 前端', '### 前端')).map((error) => error.code)).toEqual(['heading'])
  })

  test('directory 只能是单层目录名加 /，且必须有 label', () => {
    expect(errorsOf(VALID.replace('directory: frontend/', 'directory: web/app/')).map((error) => error.code)).toEqual(['frontmatter'])
    expect(errorsOf(VALID.replace('directory_label: 前端工程根目录\n', '')).map((error) => error.detail)).toEqual(['设置 directory 时必须有 directory_label'])
  })

  test('超过 64 KiB', () => {
    expect(errorsOf(`${VALID}${'a'.repeat(64 * 1024)}`).map((error) => error.code)).toEqual(['too-large'])
  })
})
