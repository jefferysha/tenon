/**
 * `tenon agent list | show | add | validate | copy | rm | export` —— agent 库在终端里的登记与查看。
 *
 * 三层来源：官方（随发行包，只读）/ 自定义（用户级 config）/ 项目（`<项目>/.tenon/agents`，随仓库共享）。
 * 同名时项目级优先于自定义；官方名字任何一层都不能用。Dashboard 只展示与编辑正文，登记都在这里。
 *
 * exit 0 = 正常，1 = 用法 / 校验失败 / IO，2 = 被拦下（被工作流引用、官方只读）。
 */
import { readFile, stat } from 'node:fs/promises'
import {
  AGENT_FILE_MAX_BYTES, AgentStoreError, CLAUDE_AGENT_TOOLS, HOST_AGENT_HOSTS, KNOWN_AGENT_HOSTS,
  agentScope, agentWorkflowReferences, deleteAgent, effectiveAgent, parseAgentFile, renameAgentContent,
  renderHostAgent, writeAgent,
  type AgentDefinition, type AgentEntry, type AgentLibrary, type AgentRole, type AgentScope, type AgentSource,
  type HostAgentHost,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

export const ROLE_WORD: Readonly<Record<AgentRole, string>> = { executor: '执行者', reviewer: '评审者' }
export const SOURCE_WORD: Readonly<Record<AgentSource, string>> = { builtin: '官方', custom: '自定义', project: '项目' }

/** `--scope user|project` → 可写的一层；缺省 user。 */
export function scopeOf(deps: CliDeps, raw: string | undefined): AgentScope | string {
  const paths = deps.agentPaths?.()
  if (paths === undefined) return 'agent 库未装配'
  if (raw !== undefined && raw !== 'user' && raw !== 'project') return `--scope 只能是 user | project（收到 '${raw}'）`
  return agentScope(raw === 'project' ? 'project' : 'custom', { configRoot: paths.configRoot, projectRoot: deps.cwd })
}

export async function loadLibrary(deps: CliDeps): Promise<AgentLibrary | undefined> {
  if (deps.agentLibrary === undefined) {
    deps.io.err('ERROR: agent 库未装配')
    return undefined
  }
  try {
    const library = await deps.agentLibrary()
    if (library.sync.state === 'failed') deps.io.err(`WARN: 官方 agent 同步失败：${library.sync.detail}`)
    return library
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return undefined
  }
}

function sourceFilter(raw: string | undefined): AgentSource | null | undefined {
  if (raw === undefined) return undefined
  if (raw === 'official' || raw === 'builtin') return 'builtin'
  if (raw === 'custom' || raw === 'user') return 'custom'
  if (raw === 'project') return 'project'
  return null
}

function roleFilter(raw: string | undefined): AgentRole | null | undefined {
  if (raw === undefined) return undefined
  return raw === 'executor' || raw === 'reviewer' ? raw : null
}

const entryJson = (entry: AgentEntry): Record<string, unknown> => ({
  name: entry.name,
  source: entry.source,
  role: entry.definition?.role ?? null,
  role_inferred: entry.definition?.roleInferred === true,
  version: entry.definition?.version ?? null,
  description: entry.definition?.description ?? '',
  skills: entry.definition?.skills ?? [],
  tools: entry.definition?.tools ?? [],
  model: entry.definition?.model ?? null,
  hosts: entry.definition?.hosts ?? null,
  digest: entry.digest,
  path: entry.path ?? null,
  shadowed_by: entry.shadowedBy ?? null,
  error: entry.error ?? null,
})

function note(entry: AgentEntry): string {
  if (entry.error !== undefined) return `  ${entry.error === '名称冲突' ? '名称冲突（与官方同名，不生效）' : `无效：${entry.error}`}`
  if (entry.shadowedBy === 'project') return '  被项目级同名覆盖'
  if (entry.definition?.roleInferred === true) return '  缺 role（按工具推断）'
  return ''
}

export async function cmdAgentList(
  deps: CliDeps,
  opts: { readonly role?: string; readonly source?: string; readonly json?: boolean },
): Promise<number> {
  const role = roleFilter(opts.role)
  const source = sourceFilter(opts.source)
  if (role === null) {
    deps.io.err(`ERROR: --role 只能是 executor | reviewer（收到 '${opts.role ?? ''}'）`)
    return 1
  }
  if (source === null) {
    deps.io.err(`ERROR: --source 只能是 official | custom | project（收到 '${opts.source ?? ''}'）`)
    return 1
  }
  const library = await loadLibrary(deps)
  if (library === undefined) return 1
  const rows = library.entries
    .filter((entry) => source === undefined || entry.source === source)
    .filter((entry) => role === undefined || entry.definition?.role === role)
    .sort((a, b) => (a.definition?.role ?? 'z').localeCompare(b.definition?.role ?? 'z') || a.name.localeCompare(b.name))
  if (opts.json === true) {
    deps.io.out(JSON.stringify({ agents: rows.map(entryJson) }))
    return 0
  }
  if (rows.length === 0) {
    deps.io.out('（没有 agent）新建：tenon agent new <name> --role executor|reviewer --description <一句话>')
    return 0
  }
  const width = Math.max(...rows.map((entry) => entry.name.length))
  for (const entry of rows) {
    const definition = entry.definition
    const roleWord = definition === undefined ? '—' : ROLE_WORD[definition.role]
    deps.io.out(`${entry.name.padEnd(width)}  ${roleWord}  ${SOURCE_WORD[entry.source]}  ${definition?.version ?? '—'}  `
      + `${definition?.description ?? ''}${note(entry)}`)
  }
  return 0
}

export async function cmdAgentShow(deps: CliDeps, name: string, json: boolean): Promise<number> {
  const library = await loadLibrary(deps)
  if (library === undefined) return 1
  const entry = effectiveAgent(library, name) ?? library.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) {
    deps.io.err(`ERROR: agent 库中不存在 '${name}'`)
    return 1
  }
  if (json) {
    deps.io.out(JSON.stringify({ ...entryJson(entry), content: entry.content }))
    return 0
  }
  deps.io.out(`# ${SOURCE_WORD[entry.source]} · ${entry.path ?? ''}`)
  deps.io.out(entry.content.replace(/\n$/u, ''))
  return 0
}

// ── 校验 ────────────────────────────────────────────────────────────────────

export interface AgentCheck { readonly level: 'ok' | 'warn' | 'fail'; readonly message: string }

/** 解析之外的检查：role 是否显式、技能是否存在、工具名按宿主是否合法。 */
export function checkDefinition(definition: AgentDefinition, knownSkills: ReadonlySet<string> | undefined): readonly AgentCheck[] {
  const checks: AgentCheck[] = [{ level: 'ok', message: `frontmatter 与正文（${ROLE_WORD[definition.role]}）` }]
  if (definition.roleInferred === true) {
    checks.push({ level: 'warn', message: `缺 role，按工具推断为 ${definition.role}；补一行 role: ${definition.role}` })
  }
  if (knownSkills === undefined) {
    if (definition.skills.length > 0) checks.push({ level: 'warn', message: '读不到插件技能清单，未核对技能' })
  } else {
    for (const skill of definition.skills) {
      const id = skill.startsWith('tenon:') ? skill.slice('tenon:'.length) : skill
      if (knownSkills.has(id)) continue
      checks.push(id.includes(':')
        ? { level: 'warn', message: `技能 '${skill}' 属于其它插件，未核对` }
        : { level: 'fail', message: `技能 '${skill}' 不存在（插件里没有这个技能）` })
    }
  }
  const hosts = definition.hosts ?? KNOWN_AGENT_HOSTS
  if (hosts.includes('claude')) {
    for (const tool of definition.tools) {
      if (!CLAUDE_AGENT_TOOLS.has(tool) && !tool.startsWith('mcp__')) {
        checks.push({ level: 'fail', message: `工具 '${tool}' 不是 Claude Code 的工具名` })
      }
    }
  }
  return checks
}

function report(deps: CliDeps, subject: string, checks: readonly AgentCheck[]): boolean {
  const failed = checks.some((check) => check.level === 'fail')
  for (const check of checks) deps.io.out(`[${check.level.toUpperCase()}] ${check.message}`)
  deps.io.out(`${failed ? 'FAIL' : 'PASS'} ${subject}`)
  return !failed
}

async function readAgentText(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${path} 不是文件`)
  if (info.size > AGENT_FILE_MAX_BYTES) throw new Error(`agent 文件超过 ${AGENT_FILE_MAX_BYTES} 字节`)
  return readFile(path, 'utf8')
}

/** frontmatter 里的 name（add / validate 文件时文件名不必等于它）。 */
function frontmatterName(text: string): string {
  const lines = text.split('\n')
  const close = lines.indexOf('---', 1)
  const head = close < 0 ? [] : lines.slice(1, close)
  return /^name:\s*(\S+)\s*$/u.exec(head.find((line) => line.startsWith('name:')) ?? '')?.[1] ?? ''
}

function parseText(deps: CliDeps, text: string): { readonly name: string; readonly definition: AgentDefinition } | undefined {
  const name = frontmatterName(text)
  try {
    return { name, definition: parseAgentFile(text, name) }
  } catch (e) {
    deps.io.out(`[FAIL] ${errMsg(e)}`)
    return undefined
  }
}

const looksLikePath = (arg: string): boolean => arg.includes('/') || arg.endsWith('.md')

export async function cmdAgentValidate(deps: CliDeps, target: string): Promise<number> {
  let text: string
  let subject = target
  if (looksLikePath(target)) {
    try {
      text = await readAgentText(target)
    } catch (e) {
      deps.io.err(`ERROR: ${errMsg(e)}`)
      return 1
    }
  } else {
    const library = await loadLibrary(deps)
    if (library === undefined) return 1
    const entry = effectiveAgent(library, target)
    if (entry === undefined) {
      deps.io.err(`ERROR: agent 库中不存在 '${target}'`)
      return 1
    }
    text = entry.content
    subject = `${target}（${SOURCE_WORD[entry.source]}）`
  }
  const parsed = parseText(deps, text)
  if (parsed === undefined) {
    deps.io.out(`FAIL ${subject}`)
    return 1
  }
  return report(deps, subject, checkDefinition(parsed.definition, deps.knownSkillIds?.())) ? 0 : 1
}

function storeFailure(deps: CliDeps, e: unknown): number {
  deps.io.err(`ERROR: ${errMsg(e)}`)
  return e instanceof AgentStoreError && e.code === 'agent-builtin-readonly' ? 2 : 1
}

/** 写进库：先按 create；已存在且允许替换时覆盖。 */
export async function registerAgent(
  deps: CliDeps, scope: AgentScope, name: string, content: string, replace: boolean,
): Promise<AgentEntry | number> {
  try {
    return await writeAgent(scope, name, content, { create: true })
  } catch (e) {
    if (!(e instanceof AgentStoreError && e.code === 'agent-exists' && replace)) return storeFailure(deps, e)
  }
  try {
    return await writeAgent(scope, name, content)
  } catch (e) {
    return storeFailure(deps, e)
  }
}

export async function cmdAgentAdd(
  deps: CliDeps, file: string, opts: { readonly scope?: string; readonly replace?: boolean },
): Promise<number> {
  const scope = scopeOf(deps, opts.scope)
  if (typeof scope === 'string') {
    deps.io.err(`ERROR: ${scope}`)
    return 1
  }
  let text: string
  try {
    text = await readAgentText(file)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const parsed = parseText(deps, text)
  if (parsed === undefined || !report(deps, parsed.name, checkDefinition(parsed.definition, deps.knownSkillIds?.()))) {
    deps.io.err('ERROR: 校验未通过，未登记')
    return 1
  }
  if (deps.agentLibrary !== undefined) await loadLibrary(deps)
  const entry = await registerAgent(deps, scope, parsed.name, text, opts.replace === true)
  if (typeof entry === 'number') return entry
  deps.io.out(`[AGENT] 已登记 ${entry.name}（${SOURCE_WORD[entry.source]}）${entry.path ?? ''}`)
  return 0
}

export async function cmdAgentCopy(
  deps: CliDeps, from: string, to: string, opts: { readonly scope?: string },
): Promise<number> {
  const scope = scopeOf(deps, opts.scope)
  if (typeof scope === 'string') {
    deps.io.err(`ERROR: ${scope}`)
    return 1
  }
  const library = await loadLibrary(deps)
  if (library === undefined) return 1
  const source = effectiveAgent(library, from)
  if (source === undefined || source.definition === undefined) {
    deps.io.err(`ERROR: agent 库中不存在可用的 '${from}'`)
    return 1
  }
  try {
    const entry = await writeAgent(scope, to, renameAgentContent(source.content, to), { create: true })
    deps.io.out(`[AGENT] 已复制 ${from} → ${entry.name}（${SOURCE_WORD[entry.source]}）${entry.path ?? ''}`)
    return 0
  } catch (e) {
    return storeFailure(deps, e)
  }
}

export async function cmdAgentRm(deps: CliDeps, name: string, opts: { readonly scope?: string }): Promise<number> {
  if (opts.scope !== undefined && opts.scope !== 'user' && opts.scope !== 'project') {
    deps.io.err(`ERROR: --scope 只能是 user | project（收到 '${opts.scope}'）`)
    return 1
  }
  const paths = deps.agentPaths?.()
  const library = await loadLibrary(deps)
  if (library === undefined || paths === undefined) {
    if (paths === undefined) deps.io.err('ERROR: agent 库未装配')
    return 1
  }
  const entry = opts.scope === undefined
    ? effectiveAgent(library, name)
    : library.entries.find((candidate) => candidate.name === name && candidate.source === (opts.scope === 'project' ? 'project' : 'custom'))
  if (entry === undefined) {
    deps.io.err(`ERROR: agent 库中不存在 '${name}'`)
    return 1
  }
  if (entry.source === 'builtin') {
    deps.io.err(`ERROR: 官方 agent '${name}' 只读；需要改动就 tenon agent copy ${name} <新名字>`)
    return 2
  }
  const references = agentWorkflowReferences({ configRoot: paths.configRoot, projectRoot: deps.cwd }, name)
  if (references.length > 0) {
    deps.io.err(`ERROR: agent '${name}' 被工作流引用，先从这些步骤移除：`)
    for (const ref of references) {
      deps.io.err(`  - ${[ref.workflow, ref.track, ref.label].filter((part) => part !== null && part !== '').join(' / ')} · ${ROLE_WORD[ref.role]}`)
    }
    return 2
  }
  const scope = scopeOf(deps, entry.source === 'project' ? 'project' : 'user')
  if (typeof scope === 'string') {
    deps.io.err(`ERROR: ${scope}`)
    return 1
  }
  try {
    await deleteAgent(scope, name)
    deps.io.out(`[AGENT] 已删除 ${name}（${SOURCE_WORD[entry.source]}）`)
    return 0
  } catch (e) {
    return storeFailure(deps, e)
  }
}

export async function cmdAgentExport(deps: CliDeps, name: string, host: string | undefined): Promise<number> {
  if (host === undefined || !(HOST_AGENT_HOSTS as readonly string[]).includes(host)) {
    deps.io.err(`ERROR: --host 只能是 ${HOST_AGENT_HOSTS.join(' | ')}`)
    return 1
  }
  const library = await loadLibrary(deps)
  if (library === undefined) return 1
  const entry = effectiveAgent(library, name)
  if (entry?.definition === undefined) {
    deps.io.err(`ERROR: agent 库中不存在可用的 '${name}'`)
    return 1
  }
  deps.io.out(renderHostAgent(host as HostAgentHost, entry.definition).replace(/\n$/u, ''))
  return 0
}
