export { agentDigest, parseAgentFile } from './parse.js'
export {
  AGENT_DESCRIPTION_MAX, AGENT_FILE_MAX_BYTES, AGENT_MODEL_RE, AGENT_NAME_RE, AGENT_ROLES, AGENT_SKILL_RE,
  AGENT_SOURCES, AGENT_TOOL_RE, AGENT_VERSION_RE, AgentFileError, KNOWN_AGENT_HOSTS, inferAgentRole,
} from './types.js'
export {
  CLAUDE_AGENT_TOOLS, HOST_AGENT_FALLBACK, HOST_AGENT_HOSTS, HOST_AGENT_PREFIX, HOST_SKILL_NAMESPACE, claudeAgentModel, codexAgentModel,
  hostAgentName, hostAgentPath, parseHostAgentPath, qualifySkillReferences, renderHostAgent,
} from './host-native.js'
export type { HostAgentHost } from './host-native.js'
export type { AgentDefinition, AgentRole, AgentSource } from './types.js'
