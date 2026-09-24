import { PROJECT_INSTRUCTION_FILES, type ProjectInstructionFile } from '../api/instructionsDecoders'

export const WIZARD_STEPS = ['location', 'templates', 'clients', 'confirm'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export type LocationMode = 'existing' | 'empty'

/**
 * 可写项目级指令文件的客户端（与 kernel `INSTRUCTION_HOSTS` 的 projectFile 一致；Aider 没有自动加载的文件，不列）。
 * name 是产品名，不翻译。
 */
export interface ClientOption { id: string; name: string; file: ProjectInstructionFile }
export const CLIENTS: readonly ClientOption[] = [
  { id: 'claude', name: 'Claude Code', file: 'CLAUDE.md' },
  { id: 'codex', name: 'Codex', file: 'AGENTS.md' },
  { id: 'gemini', name: 'Gemini CLI', file: 'GEMINI.md' },
  { id: 'copilot', name: 'GitHub Copilot', file: 'AGENTS.md' },
  { id: 'cursor', name: 'Cursor', file: 'AGENTS.md' },
  { id: 'zed', name: 'Zed', file: 'AGENTS.md' },
  { id: 'cline', name: 'Cline', file: 'AGENTS.md' },
  { id: 'continue', name: 'Continue', file: 'AGENTS.md' },
  { id: 'amp', name: 'Amp', file: 'AGENTS.md' },
  { id: 'devin', name: 'Devin', file: 'AGENTS.md' },
  { id: 'pi', name: 'Pi', file: 'AGENTS.md' },
]

/** 本机检测不到任何客户端时默认勾选的两个。 */
export const FALLBACK_CLIENTS: readonly string[] = ['claude', 'codex']

/** 主列表 = 检测到的客户端（没有就用默认两个）；其余进「更多客户端」。 */
export function splitClients(detected: readonly string[]): { primary: ClientOption[]; more: ClientOption[] } {
  const known = detected.filter((id) => CLIENTS.some((client) => client.id === id))
  const primaryIds = known.length > 0 ? known : FALLBACK_CLIENTS
  return {
    primary: CLIENTS.filter((client) => primaryIds.includes(client.id)),
    more: CLIENTS.filter((client) => !primaryIds.includes(client.id)),
  }
}

/** 所选客户端要写的文件，按协议文件顺序去重。 */
export function filesForClients(selected: ReadonlySet<string>): ProjectInstructionFile[] {
  const files = new Set(CLIENTS.filter((client) => selected.has(client.id)).map((client) => client.file))
  return PROJECT_INSTRUCTION_FILES.filter((file) => files.has(file))
}

/** 与 server 的新文件夹名规则一致：字母或数字开头，只含字母、数字、. _ -，最长 100。 */
export const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export function joinPath(parent: string, name: string): string {
  if (parent === '') return name
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`
}

export const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** 进度与确认共用的动作标签键：directory / git / skeleton / file:<name> / register。 */
export function stepLabelKey(id: string): { key: string; vars?: Record<string, string> } {
  if (id.startsWith('file:')) return { key: 'projects.action_file', vars: { file: id.slice('file:'.length) } }
  return { key: `projects.action_${id}` }
}
