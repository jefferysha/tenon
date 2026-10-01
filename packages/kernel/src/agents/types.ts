/**
 * 任务级 agent 的定义层类型。agent 是「工作流步骤里的执行者或评审者」，与项目级 / 用户级的
 * 指令文件（AGENTS.md、CLAUDE.md）无关。文件声明自己的身份（`role`），工作流步骤按身份引用它。
 */
import { INSTRUCTION_HOSTS } from '../instructions/hosts.js'
import type { PathClass } from '../workspace/path-classes.js'

/** 文件名与 frontmatter name 共用；步骤按本名称引用。 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const AGENT_TOOL_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/
export const AGENT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** skill id 与 workflow validate 的 SKILL_IDENT_RE 同口径（允许命名空间冒号）。 */
export const AGENT_SKILL_RE = /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/
/** semver 2.0（可带预发布与构建元数据）；官方 agent 随发行包递增。 */
export const AGENT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const AGENT_FILE_MAX_BYTES = 64 * 1024
export const AGENT_DESCRIPTION_MAX = 200

/** 与指令文件同一份宿主闭集，不另立一张表。 */
export const KNOWN_AGENT_HOSTS: readonly string[] = INSTRUCTION_HOSTS.map((host) => host.id)

/**
 * 来源三层：`builtin` = 官方（随发行包，只读）、`custom` = 用户级、`project` = 项目 `.tenon/agents/`
 * （随仓库提交，团队共享）。同名时 project 优先于 custom；官方名字不能被任何一层覆盖。
 */
export type AgentSource = 'builtin' | 'custom' | 'project'
export const AGENT_SOURCES: readonly AgentSource[] = ['builtin', 'custom', 'project']
export type AgentRole = 'executor' | 'reviewer'
export const AGENT_ROLES: readonly AgentRole[] = ['executor', 'reviewer']

/** 会改文件的工具：旧文件没写 role 时，带其中任何一个的推断为执行者。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** 旧文件缺 `role` 时的推断规则（与旧 Dashboard 按工具分组同一口径）。 */
export function inferAgentRole(tools: readonly string[]): AgentRole {
  return tools.some((tool) => WRITE_TOOLS.has(tool)) ? 'executor' : 'reviewer'
}

export interface AgentDefinition {
  readonly name: string
  readonly description: string
  readonly role: AgentRole
  /** 文件没写 `role`、按工具推断出来的：读取照常，校验提示补上。 */
  readonly roleInferred?: true
  readonly version?: string
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly model?: string
  /** 缺省 = 适用每个宿主。 */
  readonly hosts?: readonly string[]
  /**
   * 评审者的挂载范围：只有本任务的改动命中其中一类路径（鉴权 / 依赖 / 契约 / 迁移）时，它才进入当前步骤的
   * 评审者集合。缺省 = 总是挂载。
   */
  readonly attachOn?: readonly PathClass[]
  readonly body: string
}

export class AgentFileError extends Error {
  readonly code = 'agent-file-invalid'
  readonly field?: string
  constructor(message: string, field?: string) {
    super(message)
    this.name = 'AgentFileError'
    if (field !== undefined) this.field = field
  }
}
