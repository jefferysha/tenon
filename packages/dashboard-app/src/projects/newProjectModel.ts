import type { ProjectCreateInput, ProjectInstructionsInput } from '../api/instructionsClient'
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

/** 以 `@AGENTS.md` 引用 AGENTS.md 的客户端文件（Claude Code、Gemini CLI 都支持 @ 导入）。 */
export const REFERENCE_FILES: readonly ProjectInstructionFile[] = ['CLAUDE.md', 'GEMINI.md']

/**
 * 要写的文件：正文只写进 AGENTS.md；所选客户端若读 CLAUDE.md / GEMINI.md，就再写一行引用。
 * 没选模板也没选客户端 = 只登记，不写文件。
 */
export function filesForClients(selected: ReadonlySet<string>, hasTemplates = true): { targets: ProjectInstructionFile[]; references: ProjectInstructionFile[] } {
  const chosen = CLIENTS.filter((client) => selected.has(client.id))
  if (chosen.length === 0 && !hasTemplates) return { targets: [], references: [] }
  const extra = new Set(chosen.map((client) => client.file).filter((file) => REFERENCE_FILES.includes(file)))
  const targets = PROJECT_INSTRUCTION_FILES.filter((file) => file === 'AGENTS.md' || extra.has(file))
  return { targets: ['AGENTS.md', ...targets.filter((file) => file !== 'AGENTS.md')], references: targets.filter((file) => extra.has(file)) }
}

/** 已有文件的处理：覆盖正文 / 追加在原文后 / 跳过不写（受管块在覆盖与追加时都保留）。 */
export type FileMode = 'replace' | 'append' | 'skip'
export const FILE_MODES: readonly FileMode[] = ['append', 'replace', 'skip']

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

/** 指令文件请求。forCreate=false（确认步预检）保留跳过的文件以便显示；true（执行）去掉跳过的文件。 */
export function instructionsInput(
  files: { targets: readonly string[]; references: readonly string[] }, text: string,
  modes: Readonly<Record<string, FileMode>>, forCreate: boolean,
): ProjectInstructionsInput | null {
  const targets = files.targets.filter((file) => !forCreate || modes[file] !== 'skip')
  if (targets.length === 0) return null
  return {
    text, targets: [...targets], base_digests: {},
    references: files.references.filter((file) => targets.includes(file)),
    append: targets.filter((file) => modes[file] === 'append'),
  }
}

export interface LocationInput { mode: LocationMode; path: string; parent: string; name: string; gitInit: boolean }

export function projectInput(
  location: LocationInput, directories: readonly string[], instructions: ProjectInstructionsInput | null, clients?: readonly string[],
): ProjectCreateInput {
  const extra = clients === undefined ? {} : { clients: [...clients] }
  return location.mode === 'empty'
    ? { mode: 'empty', parent: location.parent, name: location.name, directories: [...directories], instructions, ...extra }
    : { mode: 'existing', path: location.path, instructions, ...(location.gitInit ? { git_init: true } : {}), ...extra }
}
