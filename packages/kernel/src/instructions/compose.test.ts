import { describe, expect, test } from 'vitest'
import { parseInstructionBlock, type InstructionBlock } from './block.js'
import type { InstructionCategory } from './categories.js'
import { NO_CATALOG, composeInstructions, type CatalogLookup, type ComposeSelection } from './compose.js'

function block(category: InstructionCategory, id: string, front: string[], body: string): InstructionBlock {
  const parsed = parseInstructionBlock(['---', `id: ${id}`, `category: ${category}`, `title: ${id}`, ...front, '---', body, ''].join('\n'), { category, id })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.block
}

function select(item: InstructionBlock, values: Record<string, string> = {}, catalog?: ComposeSelection['catalog']): ComposeSelection {
  return { ref: { source: 'builtin', category: item.category, id: item.id }, block: item, values, ...(catalog ? { catalog } : {}) }
}

const base = block('common', 'base', [], '## 目录约束\n\n{{directories}}\n\n- 不得在上述目录之外新增代码。')
const react = block('frontend', 'react', ['frameworks: [react]', 'directory: frontend/', 'directory_label: 前端', 'catalog: [component-lib]', 'variables:', '  - key: soft', '    default: 200'],
  '## 前端（React）\n\n- 组件 {{soft}} 行\n{{catalog.component-lib}}')
const vue = block('frontend', 'vue', ['frameworks: [vue]', 'directory: frontend/', 'directory_label: Vue 前端'], '## 前端（Vue）')
const zustand = block('state', 'zustand', ['frameworks: [react]', 'catalog_ref: zustand'], '### 状态管理（Zustand）\n\n- 按 feature 拆 store\n{{catalog.ref}}')
const pinia = block('state', 'pinia', ['frameworks: [vue]'], '### 状态管理（Pinia）')
const tailwind = block('styling', 'tailwind', ['frameworks: [react, vue]'], '### 样式（Tailwind）')
const java = block('backend', 'java', ['directory: backend/', 'directory_label: 后端', 'variables:', '  - key: app'], '## 后端（Java）\n\n```\n{{app}}-domain/\n```')
const go = block('backend', 'go', ['directory: backend/', 'directory_label: Go 后端'], '## 后端（Go）')
const api = block('api', 'rest', [], '## 接口约定\n\n- 前缀 `/api/v1`，项目 {{project.name}}')
const postgres = block('database', 'postgresql', ['directory: sql/', 'directory_label: 数据库脚本'], '## 数据库\n\n- 模板字面量 \\{{x}}')

describe('composeInstructions', () => {
  test('分类顺序固定；状态管理与样式紧跟匹配的前端块；目录表按拼合顺序', () => {
    const result = composeInstructions({
      projectName: 'shop',
      selections: [select(postgres), select(api), select(java, { app: 'shop' }), select(tailwind), select(zustand), select(react), select(base)],
      catalog: NO_CATALOG,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toBe([
      '# shop',
      '## 目录约束\n\n| 目录 | 内容 |\n| --- | --- |\n| `frontend/` | 前端 |\n| `backend/` | 后端 |\n| `sql/` | 数据库脚本 |\n\n- 不得在上述目录之外新增代码。',
      '## 前端（React）\n\n- 组件 200 行',
      '### 状态管理（Zustand）\n\n- 按 feature 拆 store',
      '### 样式（Tailwind）',
      '## 后端（Java）\n\n```\nshop-domain/\n```',
      '## 接口约定\n\n- 前缀 `/api/v1`，项目 shop',
      '## 数据库\n\n- 模板字面量 {{x}}',
    ].join('\n\n') + '\n')
    expect(result.directories).toEqual([
      { path: 'frontend/', label: '前端' }, { path: 'backend/', label: '后端' }, { path: 'sql/', label: '数据库脚本' },
    ])
  })

  test('目录按路径去重，先出现的标签生效；共享 frameworks 的样式只渲染在第一个匹配的前端块后', () => {
    const result = composeInstructions({
      projectName: 'p',
      selections: [select(react), select(vue), select(pinia), select(tailwind), select(java, { app: 'a' }), select(go)],
      catalog: NO_CATALOG,
    })
    expect(result.ok && result.directories).toEqual([{ path: 'frontend/', label: '前端' }, { path: 'backend/', label: '后端' }])
    const markdown = result.ok ? result.markdown : ''
    expect(markdown.indexOf('### 样式（Tailwind）')).toBeLessThan(markdown.indexOf('## 前端（Vue）'))
    expect(markdown.indexOf('### 状态管理（Pinia）')).toBeGreaterThan(markdown.indexOf('## 前端（Vue）'))
    expect(markdown.match(/### 样式/g)).toHaveLength(1)
  })

  test('状态管理块没有匹配的前端块 → framework-mismatch', () => {
    const result = composeInstructions({ projectName: 'p', selections: [select(react), select(pinia)], catalog: NO_CATALOG })
    expect(result.ok ? [] : result.errors.map((error) => [error.code, error.ref.id])).toEqual([['framework-mismatch', 'pinia']])
  })

  test('没有默认值的变量缺值 → missing-value；给出的值覆盖默认值', () => {
    const missing = composeInstructions({ projectName: 'p', selections: [select(java)], catalog: NO_CATALOG })
    expect(missing.ok ? [] : missing.errors).toEqual([{ code: 'missing-value', ref: { source: 'builtin', category: 'backend', id: 'java' }, detail: '缺少变量 app' }])
    const overridden = composeInstructions({ projectName: 'p', selections: [select(react, { soft: '180' })], catalog: NO_CATALOG })
    expect(overridden.ok && overridden.markdown).toContain('- 组件 180 行')
  })

  test('资源目录：NO_CATALOG 整行省略；有条目时逐条渲染许可证、安装、文档与署名', () => {
    const catalog: CatalogLookup = {
      get: (id) => id === 'shadcn-ui'
        ? { id, name: 'shadcn/ui', category: 'component-lib', frameworks: ['react'], license: { spdx: 'MIT', redistributable: true, attribution: false }, install: 'pnpm dlx shadcn@latest init', docs_url: 'https://ui.shadcn.com' }
        : id === 'zustand'
          ? { id, name: 'Zustand', category: 'state', frameworks: ['react'], license: { spdx: 'MIT', redistributable: true, attribution: true } }
          : null,
    }
    const none = composeInstructions({ projectName: 'p', selections: [select(react, {}, { 'component-lib': ['shadcn-ui'] })], catalog: NO_CATALOG })
    expect(none.ok && none.markdown).toBe('# p\n\n## 前端（React）\n\n- 组件 200 行\n')
    const some = composeInstructions({ projectName: 'p', selections: [select(react, {}, { 'component-lib': ['shadcn-ui', 'missing'] }), select(zustand)], catalog })
    expect(some.ok && some.markdown).toContain('- 组件 200 行\n- shadcn/ui（MIT）· 安装 `pnpm dlx shadcn@latest init` · 文档 https://ui.shadcn.com\n')
    expect(some.ok && some.markdown).toContain('- 按 feature 拆 store\n- Zustand（MIT）\n- 署名：Zustand 需要署名\n')
  })

  test('选择块未声明的资源目录分类 → catalog-category', () => {
    const result = composeInstructions({ projectName: 'p', selections: [select(react, {}, { icons: ['lucide'] })], catalog: NO_CATALOG })
    expect(result.ok ? [] : result.errors.map((error) => error.code)).toEqual(['catalog-category'])
  })

  test('没有块时只有项目标题；没有目录时目录占位符整行省略', () => {
    expect(composeInstructions({ projectName: 'p', selections: [], catalog: NO_CATALOG })).toEqual({ ok: true, markdown: '# p\n', directories: [] })
    const result = composeInstructions({ projectName: 'p', selections: [select(base)], catalog: NO_CATALOG })
    expect(result.ok && result.markdown).toBe('# p\n\n## 目录约束\n\n\n- 不得在上述目录之外新增代码。\n')
  })
})
