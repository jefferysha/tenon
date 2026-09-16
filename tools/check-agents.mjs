#!/usr/bin/env node
/**
 * 内建 agent 门禁（templates/agents）。
 *
 * - 清单：目录下的 `.md` 文件集合必须与 INVENTORY 完全一致（缺文件、多文件都算失败）；
 * - 语法：每个文件用构建后的 kernel `parseAgentFile` 解析，任何错误都算失败；
 * - 技能：声明的每个 skill id 必须在 `skills/sources.yaml` 里有一行——上游技能字节在干净检出里
 *   不存在（`skills/<id>/` 是 gitignore 的），所以对账的是 checked-in 的来源清单而不是盘上的字节。
 *
 * 依赖 `npm run build:packages` 产出的 packages/kernel/dist。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const BUILTIN_DIR = 'templates/agents'
export const SOURCES_FILE = 'skills/sources.yaml'

export const INVENTORY = [
  'architecture', 'backend-quality', 'builder', 'code-size', 'e2e', 'frontend-quality',
  'researcher', 'security', 'spec-consistency',
]

/** `skills/sources.yaml` 的 `skills:` 映射键；flow 形态一行一个 id。 */
export function skillSourceIds(text) {
  const ids = []
  for (const line of text.split('\n')) {
    const match = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):/.exec(line)
    if (match) ids.push(match[1])
  }
  return ids
}

export function checkAgents({ root = DEFAULT_ROOT, kernel, inventory = INVENTORY }) {
  const failures = []
  const base = join(root, BUILTIN_DIR)
  const files = existsSync(base) ? readdirSync(base).filter((name) => !name.startsWith('.')).sort() : []
  for (const name of files) {
    if (!name.endsWith('.md') || !inventory.includes(name.slice(0, -3))) failures.push(`${BUILTIN_DIR}/${name}: 不在清单中`)
  }
  const sourcesPath = join(root, SOURCES_FILE)
  const known = existsSync(sourcesPath) ? new Set(skillSourceIds(readFileSync(sourcesPath, 'utf8'))) : new Set()
  if (known.size === 0) failures.push(`${SOURCES_FILE}: 读不到任何 skill 来源`)
  const definitions = []
  for (const name of inventory) {
    const rel = `${BUILTIN_DIR}/${name}.md`
    if (!files.includes(`${name}.md`)) {
      failures.push(`${rel}: 缺失`)
      continue
    }
    let definition
    try {
      definition = kernel.parseAgentFile(readFileSync(join(root, rel), 'utf8'), name)
    } catch (error) {
      failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    definitions.push(definition)
    for (const skill of definition.skills) {
      if (!known.has(skill)) failures.push(`${rel}: skill '${skill}' 不在 ${SOURCES_FILE}`)
    }
  }
  return { failures, definitions }
}

async function main() {
  const distEntry = join(DEFAULT_ROOT, 'packages/kernel/dist/index.js')
  if (!existsSync(distEntry)) {
    console.error('[agents] 缺少 packages/kernel/dist；先运行 npm run build:packages')
    process.exitCode = 1
    return
  }
  const kernel = await import(pathToFileURL(distEntry).href)
  const { failures, definitions } = checkAgents({ kernel })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[agents] ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`[agents] PASS: ${definitions.length} 个内建 agent`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
