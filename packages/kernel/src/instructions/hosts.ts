/**
 * 各宿主的项目级 / 用户级指令文件与两级加载关系（官方文档，2026-09-15 核对；
 * 见 .trellis/tasks/09-15-instruction-templates/research/harness-instructions.md）。
 *
 * - joined：两级同时加载叠加（Claude Code、Codex、Gemini、Cline、Continue、Amp、Devin、Pi）。
 * - project-wins：Zed 两级都读，项目级覆盖个人级。
 * - user-wins：Copilot 个人指令优先于仓库指令；个人级需要 applyTo 或 GitHub 设置，不是整文件 Markdown。
 * - project-only：Cursor 用户规则只能在设置界面填写，没有文件。
 * - needs-config：Aider 不自动加载任何文件，要 `read:` 配置。
 */

export type InstructionLevels = 'joined' | 'project-wins' | 'user-wins' | 'project-only' | 'needs-config'
export type ProjectInstructionFile = 'AGENTS.md' | 'CLAUDE.md' | 'GEMINI.md'

export interface InstructionHost { id: string; projectFile: ProjectInstructionFile | null; levels: InstructionLevels }

export const INSTRUCTION_HOSTS: readonly InstructionHost[] = [
  { id: 'claude', projectFile: 'CLAUDE.md', levels: 'joined' },
  { id: 'codex', projectFile: 'AGENTS.md', levels: 'joined' },
  { id: 'gemini', projectFile: 'GEMINI.md', levels: 'joined' },
  { id: 'copilot', projectFile: 'AGENTS.md', levels: 'user-wins' },
  { id: 'cursor', projectFile: 'AGENTS.md', levels: 'project-only' },
  { id: 'zed', projectFile: 'AGENTS.md', levels: 'project-wins' },
  { id: 'cline', projectFile: 'AGENTS.md', levels: 'joined' },
  { id: 'continue', projectFile: 'AGENTS.md', levels: 'joined' },
  { id: 'amp', projectFile: 'AGENTS.md', levels: 'joined' },
  { id: 'devin', projectFile: 'AGENTS.md', levels: 'joined' },
  { id: 'pi', projectFile: 'AGENTS.md', levels: 'joined' },
  { id: 'aider', projectFile: null, levels: 'needs-config' },
]

export const PROJECT_INSTRUCTION_FILES: readonly ProjectInstructionFile[] = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']

/** Zed 只读工作区根目录下按此顺序第一个存在的文件（zed.dev/docs/ai/instructions）；adapters/zed/install.sh 对账。 */
export const ZED_PROJECT_ORDER: readonly string[] = [
  '.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md',
  'AGENT.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
]

/** 用户级整文件 Markdown 的位置（相对宿主 home）；没有文档化文件位置的宿主不在表里。 */
const USER_FILES: Readonly<Record<string, readonly string[]>> = {
  claude: ['.claude', 'CLAUDE.md'],
  codex: ['.codex', 'AGENTS.md'],
  gemini: ['.gemini', 'GEMINI.md'],
  zed: ['.config', 'zed', 'AGENTS.md'],
  cline: ['.agents', 'AGENTS.md'],
  amp: ['.config', 'amp', 'AGENTS.md'],
  devin: ['.config', 'devin', 'AGENTS.md'],
  pi: ['.pi', 'agent', 'AGENTS.md'],
}

export function instructionHost(hostId: string): InstructionHost | null {
  return INSTRUCTION_HOSTS.find((host) => host.id === hostId) ?? null
}

export function hasUserInstructionFile(hostId: string): boolean {
  return Object.hasOwn(USER_FILES, hostId)
}

/** 所选宿主对应的项目级文件，按宿主顺序去重。 */
export function projectTargetsFor(hostIds: readonly string[]): ProjectInstructionFile[] {
  const targets: ProjectInstructionFile[] = []
  for (const id of hostIds) {
    const file = instructionHost(id)?.projectFile
    if (file && !targets.includes(file)) targets.push(file)
  }
  return targets
}

function absoluteDirectory(value: string | undefined, platform: NodeJS.Platform): string | null {
  const trimmed = value?.trim() ?? ''
  const absolute = platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(trimmed) : trimmed.startsWith('/')
  if (!absolute) return null
  const stripped = trimmed.replace(/[\\/]+$/u, '')
  return stripped === '' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped
}

/**
 * 用户级指令文件路径：第 0 段是受信根目录（宿主 home、`$CODEX_HOME` 或 `%APPDATA%`），其余是其下的相对段。
 * 宿主没有可编辑的用户级文件时返回 null。
 */
export function userInstructionPath(
  hostId: string,
  context: { homeDir: string; env: Readonly<Record<string, string | undefined>>; platform: NodeJS.Platform },
): readonly string[] | null {
  const relative = USER_FILES[hostId]
  if (!relative) return null
  if (hostId === 'codex') {
    const codexHome = absoluteDirectory(context.env.CODEX_HOME, context.platform)
    if (codexHome) return [codexHome, 'AGENTS.md']
  }
  if (hostId === 'zed' && context.platform === 'win32') {
    const appData = absoluteDirectory(context.env.APPDATA, context.platform)
    return appData ? [appData, 'Zed', 'AGENTS.md'] : [context.homeDir, 'AppData', 'Roaming', 'Zed', 'AGENTS.md']
  }
  return [context.homeDir, ...relative]
}

/** Zed 生效的项目指令文件：顺序表里第一个存在的，否则 AGENTS.md（适配器会建它）。 */
export function zedEffectiveFile(exists: (relativePath: string) => boolean): string {
  return ZED_PROJECT_ORDER.find((file) => exists(file)) ?? 'AGENTS.md'
}
