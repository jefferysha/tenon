#!/usr/bin/env node
/**
 * 官方 agent 门禁（templates/agents）。
 *
 * - 清单：目录下的 `.md` 文件集合必须与 INVENTORY 完全一致（缺文件、多文件都算失败）；
 * - 语法：每个文件用构建后的 kernel `parseAgentFile` 解析，任何错误都算失败；官方 agent 必须显式写
 *   `role` 与 `version`（旧文件缺 role 的推断只给用户文件兜底）；
 * - 技能：声明的每个 skill id 必须在 `skills/sources.yaml` 里有一行——上游技能字节在干净检出里
 *   不存在（`skills/<id>/` 是 gitignore 的），所以对账的是 checked-in 的来源清单而不是盘上的字节；
 * - 兼容：官方 agent 会被冻结进每个任务（`.pipeline-frozen/agents/`），上一个发行版的 agent 文件解析器是闭集，
 *   frontmatter 多出一个它不认识的键（例如 `attach_on`、`host`）就整个冻结副本读不了、agent next / check 失败。所以官方 agent 的
 *   frontmatter 只能用 N_MINUS_ONE_AGENT_KEYS；需要新键的行为（评审者挂载范围）写在代码里（kernel agents/official-scope.ts）。
 *   换到下一个 N-1 时同步这张表。
 * - 发行记录：`templates/agents/manifest.json` 逐条记 name / version / role / digest，必须与文件一致。
 *   改了官方 agent 后运行 `node tools/check-agents.mjs --write` 重写它。
 *
 * 依赖 `npm run build:packages` 产出的 packages/kernel/dist。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const BUILTIN_DIR = 'templates/agents'
export const MANIFEST_FILE = `${BUILTIN_DIR}/manifest.json`
export const SOURCES_FILE = 'skills/sources.yaml'

/** 上一个发行版（v0.2.1）的 agent 文件 frontmatter 闭集；见文件头的「兼容」一条。 */
export const N_MINUS_ONE_AGENT_KEYS = ['name', 'description', 'role', 'version', 'skills', 'tools', 'model', 'hosts']

/** frontmatter 里的键（第一个 `---` 与下一个 `---` 之间每行的 `key:`）。 */
export function frontmatterKeys(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') return []
  const close = lines.indexOf('---', 1)
  return lines.slice(1, close < 0 ? lines.length : close).flatMap((line) => {
    const match = /^([a-z_]+):/.exec(line)
    return match ? [match[1]] : []
  })
}

export const INVENTORY = [
  'architecture', 'backend-quality', 'builder', 'code-review', 'code-size', 'e2e', 'frontend-quality',
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

/** 由官方 agent 文件生成的发行记录（按名字排序，逐字确定）。 */
export function renderManifest(entries) {
  const agents = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, version, role, digest }) => ({ name, version, role, digest }))
  return `${JSON.stringify({ version: 1, agents }, null, 2)}\n`
}

export function checkAgents({ root = DEFAULT_ROOT, kernel, inventory = INVENTORY }) {
  const failures = []
  const base = join(root, BUILTIN_DIR)
  const files = existsSync(base) ? readdirSync(base).filter((name) => !name.startsWith('.')).sort() : []
  for (const name of files) {
    if (name === 'manifest.json') continue
    if (!name.endsWith('.md') || !inventory.includes(name.slice(0, -3))) failures.push(`${BUILTIN_DIR}/${name}: 不在清单中`)
  }
  const sourcesPath = join(root, SOURCES_FILE)
  const known = existsSync(sourcesPath) ? new Set(skillSourceIds(readFileSync(sourcesPath, 'utf8'))) : new Set()
  if (known.size === 0) failures.push(`${SOURCES_FILE}: 读不到任何 skill 来源`)
  const definitions = []
  const entries = []
  for (const name of inventory) {
    const rel = `${BUILTIN_DIR}/${name}.md`
    if (!files.includes(`${name}.md`)) {
      failures.push(`${rel}: 缺失`)
      continue
    }
    const text = readFileSync(join(root, rel), 'utf8')
    let definition
    try {
      definition = kernel.parseAgentFile(text, name)
    } catch (error) {
      failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    definitions.push(definition)
    const unknownKeys = frontmatterKeys(text).filter((key) => !N_MINUS_ONE_AGENT_KEYS.includes(key))
    if (unknownKeys.length > 0) {
      failures.push(`${rel}: frontmatter 键 ${unknownKeys.join('、')} 不在上一个发行版的闭集（${N_MINUS_ONE_AGENT_KEYS.join('/')}）里，它读不了冻结的副本`)
    }
    if (definition.roleInferred === true) failures.push(`${rel}: 官方 agent 必须显式写 role`)
    if (definition.version === undefined) failures.push(`${rel}: 官方 agent 必须写 version`)
    entries.push({ name, version: definition.version ?? '', role: definition.role, digest: kernel.agentDigest(text) })
    for (const skill of definition.skills) {
      if (!known.has(skill)) failures.push(`${rel}: skill '${skill}' 不在 ${SOURCES_FILE}`)
    }
  }
  const manifest = renderManifest(entries)
  const manifestPath = join(root, MANIFEST_FILE)
  const stored = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  if (stored === null) failures.push(`${MANIFEST_FILE}: 缺失（运行 node tools/check-agents.mjs --write）`)
  else if (stored !== manifest) failures.push(`${MANIFEST_FILE}: 与官方 agent 文件不一致（运行 node tools/check-agents.mjs --write）`)
  return { failures, definitions, manifest }
}

async function main() {
  const distEntry = join(DEFAULT_ROOT, 'packages/kernel/dist/index.js')
  if (!existsSync(distEntry)) {
    console.error('[agents] 缺少 packages/kernel/dist；先运行 npm run build:packages')
    process.exitCode = 1
    return
  }
  const kernel = await import(pathToFileURL(distEntry).href)
  if (process.argv.includes('--write')) {
    const { manifest } = checkAgents({ kernel })
    writeFileSync(join(DEFAULT_ROOT, MANIFEST_FILE), manifest)
    console.log(`[agents] 已写 ${MANIFEST_FILE}`)
  }
  const { failures, definitions } = checkAgents({ kernel })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[agents] ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`[agents] PASS: ${definitions.length} 个官方 agent`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
