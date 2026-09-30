/**
 * 宿主原生 agent 文件的渲染（纯函数）：任务冻结的 agent → Claude Code `.claude/agents/tenon-<name>.md`
 * 或 Codex `.codex/agents/tenon-<name>.toml`。宿主据此用专属子代理执行，Claude 的 `tools` 白名单真正生效。
 *
 * 只写宿主认得的字段：Claude = name / description / tools / model；Codex = name / description /
 * developer_instructions / model（仅 Codex 认得的型号）/ sandbox_mode（工具里没有任何写或执行能力时只读）。
 * 型号不跨宿主硬译：对方宿主不认识的型号直接省略，由宿主用自己的默认型号。
 */
import type { AgentDefinition } from './types.js'

export type HostAgentHost = 'claude' | 'codex'
export const HOST_AGENT_HOSTS: readonly HostAgentHost[] = ['claude', 'codex']
export const HOST_AGENT_PREFIX = 'tenon-'

/** 专属子代理不可用时退回的通用子代理类型。 */
export const HOST_AGENT_FALLBACK: Readonly<Record<HostAgentHost, string>> = {
  claude: 'general-purpose',
  codex: 'default',
}

/** Claude Code 子代理 `tools` 里合法的内置工具名；`mcp__<server>__<tool>` 另按前缀放行。 */
export const CLAUDE_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'Agent', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'KillShell', 'LS', 'MultiEdit',
  'NotebookEdit', 'NotebookRead', 'Read', 'Skill', 'SlashCommand', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch',
  'Write',
])

const HOST_DIRS: Readonly<Record<HostAgentHost, { readonly dir: string; readonly ext: string }>> = {
  claude: { dir: '.claude/agents', ext: '.md' },
  codex: { dir: '.codex/agents', ext: '.toml' },
}

export const hostAgentName = (name: string): string => `${HOST_AGENT_PREFIX}${name}`

/** 仓库相对路径（POSIX）。 */
export function hostAgentPath(host: HostAgentHost, name: string): string {
  const { dir, ext } = HOST_DIRS[host]
  return `${dir}/${hostAgentName(name)}${ext}`
}

/** 反解 hostAgentPath；不是 Tenon 生成的宿主 agent 路径时返回 null。 */
export function parseHostAgentPath(path: string): { readonly host: HostAgentHost; readonly name: string } | null {
  for (const host of HOST_AGENT_HOSTS) {
    const { dir, ext } = HOST_DIRS[host]
    const prefix = `${dir}/${HOST_AGENT_PREFIX}`
    if (!path.startsWith(prefix) || !path.endsWith(ext)) continue
    const name = path.slice(prefix.length, -ext.length)
    if (/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) return { host, name }
  }
  return null
}

const CLAUDE_ALIASES: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku', 'inherit'])

/** Claude 认得的型号（别名或 claude-* 完整 id）；其它宿主的型号省略。 */
export function claudeAgentModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  return CLAUDE_ALIASES.has(model) || model.startsWith('claude-') ? model : undefined
}

/**
 * Codex 认得的型号：OpenAI 型号 id（gpt-* / o<数字>* / codex-*）原样保留；Claude 别名（sonnet 等）
 * 在 Codex 没有已核实的对应型号，省略后 Codex 用会话默认型号。
 */
export function codexAgentModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  return /^(?:gpt-|o\d|codex-)/u.test(model) ? model : undefined
}

/** 工具里没有任何写文件或跑命令的能力 → Codex 用只读沙箱落实同一份限制。 */
const WRITE_OR_EXEC: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
const readOnly = (tools: readonly string[]): boolean =>
  tools.length > 0 && !tools.some((tool) => WRITE_OR_EXEC.has(tool))

/** TOML 基本字符串（单行）：JSON 的转义在 TOML 里同样合法，再补上 JSON 不转义的 DEL。 */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/gu, '\\u007F')
}

/** TOML 多行基本字符串：反斜杠与引号一律转义，控制字符（换行、制表除外）转成 \uXXXX。 */
function tomlMultiline(value: string): string {
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r/gu, '\\r')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`)
  return `"""\n${escaped}"""`
}

/** 插件技能在宿主里的命名空间：宿主按 `<插件>:<技能>` 解析，裸名可能落到同名的外部技能上。 */
export const HOST_SKILL_NAMESPACE = 'tenon'

/**
 * 正文里用反引号写的、本 agent 声明过的技能名，改成带插件前缀的全名。裸名 `deep-research` 在宿主里会被
 * 解析到机器上另一个同名技能（真机验收 F5：被 disable-model-invocation 拒绝，研究者退化成不用技能）；
 * `tenon:<id>` 只指向插件自带的那份。已带前缀、名字只是前缀相同、没声明的反引号内容都不动；幂等。
 */
export function qualifySkillReferences(body: string, skills: readonly string[]): string {
  let out = body
  for (const id of skills) {
    if (id.includes(':') || id === '') continue
    out = out.split(`\`${id}\``).join(`\`${HOST_SKILL_NAMESPACE}:${id}\``)
  }
  return out
}

const bodyOf = (definition: AgentDefinition): string => {
  const trimmed = qualifySkillReferences(definition.body, definition.skills).replace(/^\n+/u, '')
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
}

function renderClaude(definition: AgentDefinition): string {
  const model = claudeAgentModel(definition.model)
  return [
    '---',
    `name: ${hostAgentName(definition.name)}`,
    `description: ${JSON.stringify(definition.description)}`,
    ...(definition.tools.length === 0 ? [] : [`tools: ${definition.tools.join(', ')}`]),
    ...(model === undefined ? [] : [`model: ${model}`]),
    '---',
    '',
    bodyOf(definition),
  ].join('\n')
}

function renderCodex(definition: AgentDefinition): string {
  const model = codexAgentModel(definition.model)
  return [
    `name = ${tomlString(hostAgentName(definition.name))}`,
    `description = ${tomlString(definition.description)}`,
    ...(model === undefined ? [] : [`model = ${tomlString(model)}`]),
    ...(readOnly(definition.tools) ? ['sandbox_mode = "read-only"'] : []),
    `developer_instructions = ${tomlMultiline(bodyOf(definition))}`,
    '',
  ].join('\n')
}

/** 渲染一份宿主原生 agent 文件；同一定义逐字确定。 */
export function renderHostAgent(host: HostAgentHost, definition: AgentDefinition): string {
  return host === 'claude' ? renderClaude(definition) : renderCodex(definition)
}
