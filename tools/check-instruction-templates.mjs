#!/usr/bin/env node
/**
 * 内建指令模板块门禁（templates/instructions/builtin）。
 *
 * - 清单：每个分类目录下的文件集合必须与 INVENTORY 完全一致（缺文件、多文件都算失败）；
 * - 语法：每个文件用构建后的 kernel `parseInstructionBlock` 解析，任何错误都算失败；
 * - 结构：语言块（前端 / 后端 / 移动端 / 系统）的 `###` 小节依次为 技术栈 · 分层结构 · 编码规范 · 文件长度 · 测试要求，
 *   通用、接口约定、数据库块的小节同样固定，保证任意组合拼出来的文件结构一致。
 *
 * 依赖 `npm run build:packages` 产出的 packages/kernel/dist。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const BUILTIN_DIR = 'templates/instructions/builtin'

export const INVENTORY = {
  common: ['base'],
  frontend: ['typescript-angular', 'typescript-react', 'typescript-vue3'],
  state: ['angular-signals', 'jotai', 'ngrx-signals', 'pinia', 'redux-toolkit', 'tanstack-query', 'zustand'],
  styling: ['css-modules', 'scss', 'tailwind'],
}

const LANGUAGE_SECTIONS = ['### 技术栈', '### 分层结构', '### 编码规范', '### 文件长度', '### 测试要求']

/** 每个分类要求的小节标题（按出现顺序，只数围栏代码之外的行）。 */
export const SECTION_HEADINGS = {
  common: { level: '## ', headings: ['## 最终回复格式', '## 目录约束'] },
  frontend: { level: '### ', headings: LANGUAGE_SECTIONS },
  backend: { level: '### ', headings: LANGUAGE_SECTIONS },
  mobile: { level: '### ', headings: LANGUAGE_SECTIONS },
  system: { level: '### ', headings: LANGUAGE_SECTIONS },
  api: { level: '### ', headings: ['### 前缀与版本', '### 统一响应', '### 分页', '### 错误码'] },
  database: { level: '### ', headings: ['### 脚本', '### 表结构', '### 约束'] },
}

/** 围栏代码之外、以给定前缀开头的标题行（前缀后面不是 `#`）。 */
export function headingsOf(text, prefix) {
  const found = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced && line.startsWith(prefix)) found.push(line.trim())
  }
  return found
}

function sectionTitle(line) {
  return line.replace(/（.*$/u, '').trim()
}

export function checkInstructionTemplates({ root = DEFAULT_ROOT, kernel, inventory = INVENTORY }) {
  const failures = []
  const base = join(root, BUILTIN_DIR)
  const onDisk = existsSync(base)
    ? readdirSync(base).filter((name) => !name.startsWith('.') && statSync(join(base, name)).isDirectory())
    : []
  for (const category of onDisk) {
    if (!(category in inventory)) failures.push(`${BUILTIN_DIR}/${category}: 不在清单中的分类目录`)
  }
  const blocks = []
  for (const [category, ids] of Object.entries(inventory)) {
    const dir = join(base, category)
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith('.')) : []
    for (const name of files) {
      if (!name.endsWith('.md') || !ids.includes(name.slice(0, -3))) failures.push(`${BUILTIN_DIR}/${category}/${name}: 不在清单中`)
    }
    for (const id of ids) {
      const rel = `${BUILTIN_DIR}/${category}/${id}.md`
      if (!files.includes(`${id}.md`)) {
        failures.push(`${rel}: 缺失`)
        continue
      }
      const text = readFileSync(join(root, rel), 'utf8')
      const parsed = kernel.parseInstructionBlock(text, { category, id })
      if (!parsed.ok) {
        for (const error of parsed.errors) failures.push(`${rel}:${error.line ?? ''} ${error.code} ${error.detail}`)
        continue
      }
      blocks.push({ category, id, block: parsed.block })
      const rule = SECTION_HEADINGS[category]
      if (!rule) continue
      const headings = headingsOf(parsed.block.body, rule.level)
      const actual = category === 'common' ? headings : headings.map(sectionTitle)
      if (actual.join('|') !== rule.headings.join('|')) {
        failures.push(`${rel}: 小节应为 ${rule.headings.join(' · ')}，实际 ${actual.join(' · ') || '无'}`)
      }
    }
  }
  return { failures, blocks }
}

async function main() {
  const distEntry = join(DEFAULT_ROOT, 'packages/kernel/dist/index.js')
  if (!existsSync(distEntry)) {
    console.error('[instruction-templates] 缺少 packages/kernel/dist；先运行 npm run build:packages')
    process.exitCode = 1
    return
  }
  const kernel = await import(pathToFileURL(distEntry).href)
  const { failures, blocks } = checkInstructionTemplates({ kernel })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[instruction-templates] ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`[instruction-templates] PASS: ${blocks.length} 个内建模板块`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
