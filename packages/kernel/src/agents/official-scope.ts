/**
 * 官方评审者的默认挂载范围（`attach_on`）。
 *
 * 为什么写在代码里而不是官方 agent 文件的 frontmatter：官方 agent 会在每个 default 任务创建时被冻结进
 * `<change>/.pipeline-frozen/agents/`，上一个发行版（v0.2.1）的 agent 文件解析器是闭集，frontmatter 里出现
 * `attach_on` 就判整个冻结副本不可读，升级后回滚的用户（或还在用 v0.2.1 的同事）的 agent next / check 都会失败。
 * 官方文件因此保持上一个发行版读得了的形状，范围在读取库条目与冻结副本时按「来源是 builtin + 名字」补上，
 * 对挂载判定的效果与文件里写着 `attach_on` 完全相同。
 *
 * 自定义 / 项目级 agent 照旧在自己的 frontmatter 里写 `attach_on`（用户主动写的，只有 v0.3 读得了，见文档）；
 * 复制官方 agent（`tenon agent copy`）时把这里的范围写进副本的 frontmatter，副本由用户接管。
 */
import type { PathClass } from '../workspace/path-classes.js'
import type { AgentDefinition, AgentSource } from './types.js'

const OFFICIAL_ATTACH_ON: ReadonlyMap<string, readonly PathClass[]> = new Map<string, readonly PathClass[]>([
  ['security', ['auth', 'dependency', 'contract']],
])

/** 官方 agent 的默认挂载范围；没有声明范围（总是挂载）返回 undefined。 */
export function officialAttachOn(name: string): readonly PathClass[] | undefined {
  return OFFICIAL_ATTACH_ON.get(name)
}

/** 来源是官方、文件里没写 `attach_on` 时补上默认范围；其余原样返回。 */
export function withOfficialAttachOn(source: AgentSource, definition: AgentDefinition): AgentDefinition {
  if (source !== 'builtin' || definition.attachOn !== undefined) return definition
  const scope = officialAttachOn(definition.name)
  return scope === undefined ? definition : { ...definition, attachOn: scope }
}

/** frontmatter 的分隔行：`---`，或 CRLF 文件里带行尾 `\r` 的 `---\r`（按 `\n` 切分后 `\r` 留在行尾）。 */
const isDelimiter = (line: string | undefined): boolean => line === '---' || line === '---\r'

/**
 * 把 `attach_on:` 行写进 agent 文件的 frontmatter（结束的 `---` 之前）；已经有该行或没有 frontmatter 时原样返回。
 * CRLF 文件（首行是 `---\r`）的分隔行照认，插入的行沿用文件自己的行尾，不把一个 CRLF 文件改成混合行尾。
 */
export function withAttachOnLine(content: string, attachOn: readonly PathClass[]): string {
  const lines = content.split('\n')
  if (!isDelimiter(lines[0])) return content
  const eol = lines[0] === '---\r' ? '\r' : ''
  const close = lines.findIndex((line, index) => index > 0 && isDelimiter(line))
  if (close < 0 || lines.slice(1, close).some((line) => /^attach_on:/u.test(line))) return content
  lines.splice(close, 0, `attach_on: [${attachOn.join(', ')}]${eol}`)
  return lines.join('\n')
}
