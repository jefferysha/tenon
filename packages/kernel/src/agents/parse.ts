/**
 * agent 文件解析：闭集 frontmatter + Markdown 正文。frontmatter 只认 `key: value` 一行一条，
 * 不做通用 YAML——保存回盘时逐字写回同样的形态，所以往返保真且没有隐藏语义。
 */
import { sha256Hex } from '../sha256.js'
import {
  AGENT_DESCRIPTION_MAX, AGENT_FILE_MAX_BYTES, AGENT_MODEL_RE, AGENT_NAME_RE, AGENT_SKILL_RE,
  AGENT_TOOL_RE, AgentFileError, KNOWN_AGENT_HOSTS, type AgentDefinition,
} from './types.js'

const KEYS: readonly string[] = ['name', 'description', 'skills', 'tools', 'model', 'hosts']

function fail(message: string, field?: string): never {
  throw new AgentFileError(message, field)
}

function inlineList(raw: string, field: string): string[] {
  const trimmed = raw.trim()
  if (trimmed === '[]') return []
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) fail(`${field} 必须是 [a, b] 形态的单行列表`, field)
  return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter((item) => item !== '')
}

function eachMatches(values: readonly string[], re: RegExp, field: string): readonly string[] {
  for (const value of values) if (!re.test(value)) fail(`${field} 的 '${value}' 非法`, field)
  return values
}

/** 解析并校验一个 agent 文件；expectedName 是文件名主干，必须等于 frontmatter name。 */
export function parseAgentFile(text: string, expectedName: string): AgentDefinition {
  if (new TextEncoder().encode(text).length > AGENT_FILE_MAX_BYTES) {
    fail(`agent 文件超过 ${AGENT_FILE_MAX_BYTES} 字节`)
  }
  const lines = text.split('\n')
  if ((lines[0] ?? '') !== '---') fail('首行必须是 ---')
  const close = lines.indexOf('---', 1)
  if (close < 0) fail('frontmatter 缺少结束的 ---')
  const fields = new Map<string, string>()
  for (let index = 1; index < close; index++) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line)
    if (!match) fail(`frontmatter 第 ${index + 1} 行不是 'key: value'`)
    const key = match[1] ?? ''
    if (!KEYS.includes(key)) fail(`frontmatter 出现未知字段 '${key}'（闭集：${KEYS.join('/')}）`, key)
    if (fields.has(key)) fail(`frontmatter 重复声明 '${key}'`, key)
    fields.set(key, match[2] ?? '')
  }
  const name = fields.get('name') ?? ''
  if (!AGENT_NAME_RE.test(name)) fail('name 非法（仅允许小写字母、数字与 -）', 'name')
  if (name !== expectedName) fail(`frontmatter name 与文件名不一致（'${name}' ≠ '${expectedName}'）`, 'name')
  const description = fields.get('description') ?? ''
  if (description === '' || description.length > AGENT_DESCRIPTION_MAX) {
    fail(`description 必须是 1–${AGENT_DESCRIPTION_MAX} 字的一行`, 'description')
  }
  const skills = eachMatches(inlineList(fields.get('skills') ?? '[]', 'skills'), AGENT_SKILL_RE, 'skills')
  const tools = eachMatches(inlineList(fields.get('tools') ?? '[]', 'tools'), AGENT_TOOL_RE, 'tools')
  const model = fields.get('model')
  if (model !== undefined && !AGENT_MODEL_RE.test(model)) fail(`model '${model}' 非法`, 'model')
  const rawHosts = fields.get('hosts')
  const hosts = rawHosts === undefined ? undefined : inlineList(rawHosts, 'hosts')
  for (const host of hosts ?? []) {
    if (!KNOWN_AGENT_HOSTS.includes(host)) fail(`hosts 的 '${host}' 不是已知宿主`, 'hosts')
  }
  const body = lines.slice(close + 1).join('\n')
  if (body.trim() === '') fail('正文不得为空')
  return {
    name, description, skills, tools,
    ...(model === undefined ? {} : { model }),
    ...(hosts === undefined ? {} : { hosts }),
    body,
  }
}

/** 文件原始字节的摘要；冻结与乐观并发都用它。 */
export function agentDigest(text: string): string {
  return `sha256:${sha256Hex(text)}`
}
