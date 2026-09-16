import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { composeInstructions } from '../instructions/compose.js'
import { parseInstructionBlock } from '../instructions/block.js'
import { parseResourceEntry } from './parse.js'
import { resourceCatalogLookup, resourceSummary } from './frontend-selection.js'
import type { ResourceEntry } from './types.js'

const BUILTIN = fileURLToPath(new URL('../../../../templates/resources/builtin', import.meta.url))
const TEMPLATES = fileURLToPath(new URL('../../../../templates/instructions/builtin', import.meta.url))

const entries: ResourceEntry[] = readdirSync(BUILTIN)
  .filter((name) => name.endsWith('.yaml'))
  .map((name) => parseResourceEntry(readFileSync(join(BUILTIN, name), 'utf8')))
const byId = (id: string): ResourceEntry => {
  const entry = entries.find((item) => item.id === id)
  if (!entry) throw new Error(`missing ${id}`)
  return entry
}

function block(category: 'frontend' | 'state' | 'styling', id: string) {
  const parsed = parseInstructionBlock(readFileSync(join(TEMPLATES, category, `${id}.md`), 'utf8'), { category, id })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.block
}

describe('resourceSummary', () => {
  test('许可事实与安装命令原样传给指令块', () => {
    expect(resourceSummary(byId('shadcn-ui'))).toMatchObject({
      id: 'shadcn-ui',
      category: 'component-lib',
      license: { spdx: 'MIT', redistributable: true, attribution: false },
      install: 'pnpm dlx shadcn@latest init',
      docs_url: 'https://ui.shadcn.com/docs',
    })
    expect(resourceSummary(byId('gsap')).license.redistributable).toBe(false)
  })

  test('未收录的 id 查不到', () => {
    expect(resourceCatalogLookup(entries).get('nothing')).toBeNull()
  })
})

describe('前端块写入所选资源', () => {
  test('shadcn-ui + lucide + 一个品牌 DESIGN.md：安装命令与仅链接约束都在正文里', () => {
    const result = composeInstructions({
      projectName: 'shop',
      selections: [{
        ref: { source: 'builtin', category: 'frontend', id: 'typescript-react' },
        block: block('frontend', 'typescript-react'),
        values: {},
        catalog: { 'component-lib': ['shadcn-ui'], icons: ['lucide'], 'design-md': ['design-md-claude'] },
      }],
      catalog: resourceCatalogLookup(entries),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain('- shadcn/ui（MIT）· 安装 `pnpm dlx shadcn@latest init` · 文档 https://ui.shadcn.com/docs')
    expect(result.markdown).toContain('- Lucide（ISC）· 安装 `pnpm add lucide-react` · 文档 https://lucide.dev')
    expect(result.markdown).toContain('- 仅链接：Claude 按安装命令在本项目使用，不再分发其源码')
    expect(result.markdown).toContain('`DESIGN.md`')
    expect(result.markdown).not.toMatch(/\{\{/u)
  })

  test('需署名的条目额外写一行署名约束', () => {
    const result = composeInstructions({
      projectName: 'shop',
      selections: [{
        ref: { source: 'builtin', category: 'frontend', id: 'typescript-react' },
        block: block('frontend', 'typescript-react'),
        values: {},
        catalog: { icons: ['font-awesome-free'] },
      }],
      catalog: resourceCatalogLookup(entries),
    })
    expect(result.ok && result.markdown).toContain('- 署名：Font Awesome Free 需要署名')
  })

  test('条目分类与块声明的分类不一致 → catalog-category', () => {
    const result = composeInstructions({
      projectName: 'shop',
      selections: [{
        ref: { source: 'builtin', category: 'frontend', id: 'typescript-react' },
        block: block('frontend', 'typescript-react'),
        values: {},
        catalog: { icons: ['shadcn-ui'] },
      }],
      catalog: resourceCatalogLookup(entries),
    })
    expect(result.ok ? [] : result.errors.map((error) => error.detail)).toEqual(['shadcn-ui 属于 component-lib，不是 icons'])
  })
})
