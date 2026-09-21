/**
 * 任务级 agent 的定义层类型。agent 是「工作流步骤里的执行者或评审者」，与项目级 / 用户级的
 * 指令文件（AGENTS.md、CLAUDE.md）无关；角色不写在文件里，由步骤决定。
 */
import { INSTRUCTION_HOSTS } from '../instructions/hosts.js'

/** 文件名与 frontmatter name 共用；步骤按本名称引用。 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const AGENT_TOOL_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/
export const AGENT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** skill id 与 workflow validate 的 SKILL_IDENT_RE 同口径（允许命名空间冒号）。 */
export const AGENT_SKILL_RE = /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/
export const AGENT_FILE_MAX_BYTES = 64 * 1024
export const AGENT_DESCRIPTION_MAX = 200

/** 与指令文件同一份宿主闭集，不另立一张表。 */
export const KNOWN_AGENT_HOSTS: readonly string[] = INSTRUCTION_HOSTS.map((host) => host.id)

export type AgentSource = 'builtin' | 'custom'
export type AgentRole = 'executor' | 'reviewer'

export interface AgentDefinition {
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly model?: string
  /** 缺省 = 适用每个宿主。 */
  readonly hosts?: readonly string[]
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
