import type { InstructionHostRow, InstructionTarget } from '../api/instructionsDecoders'

/** 客户端显示名（专有名词，中英文相同）；未知 id 原样显示。 */
const CLIENT_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  zed: 'Zed',
  cline: 'Cline',
  continue: 'Continue',
  amp: 'Amp',
  devin: 'Devin',
  pi: 'Pi',
  aider: 'Aider',
}

export function clientName(id: string): string {
  return CLIENT_NAMES[id] ?? id
}

/**
 * 目标的真实文件名。项目级目标 id 就是文件名；用户级目标 id 是宿主 id（claude、codex），
 * 文件名要从路径取（~/.claude/CLAUDE.md → CLAUDE.md）。路径缺失时才退回 id。
 */
export function fileNameOf(target: Pick<InstructionTarget, 'id' | 'path'>): string {
  return target.path.split(/[\\/]/u).filter(Boolean).pop() ?? target.id
}

/** 项目级的一组：同一个文件，被哪些已启用客户端读取（按宿主表顺序，第一个是显示名）。 */
export interface ClientGroup {
  readonly file: string
  readonly clients: readonly string[]
}

/** Zed 读的是顺序表里第一个存在的文件；它是可编辑的三个文件之一时按它归组，否则按声明的目标文件。 */
function projectFileOf(host: InstructionHostRow, editable: ReadonlySet<string>): string | null {
  if (host.target === null) return null
  return host.effective_file !== undefined && editable.has(host.effective_file) ? host.effective_file : host.target
}

/** 已启用客户端按项目级文件归组：共享同一文件的客户端合并成一组。 */
export function groupByProjectFile(
  hosts: readonly InstructionHostRow[], targets: readonly InstructionTarget[], enabled: readonly string[],
): ClientGroup[] {
  const editable = new Set(targets.map((target) => target.id))
  const groups: { file: string; clients: string[] }[] = []
  for (const host of hosts) {
    if (!enabled.includes(host.id)) continue
    const file = projectFileOf(host, editable)
    if (file === null) continue
    const group = groups.find((candidate) => candidate.file === file)
    if (group) group.clients.push(host.id)
    else groups.push({ file, clients: [host.id] })
  }
  return groups
}

/**
 * 没有记录时推导已启用的客户端：每个已存在的项目级文件，取宿主表里第一个声明读它的客户端
 * （CLAUDE.md → claude、AGENTS.md → codex、GEMINI.md → gemini）。
 */
export function derivedEnabled(hosts: readonly InstructionHostRow[], targets: readonly InstructionTarget[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const host of hosts) {
    if (host.target === null || seen.has(host.target)) continue
    const target = targets.find((candidate) => candidate.id === host.target)
    if (target === undefined || !target.exists) continue
    seen.add(host.target)
    out.push(host.id)
  }
  return out
}

/** 可以直接启用：有项目级文件可写（需配置的客户端没有）。 */
export function canEnable(host: InstructionHostRow): boolean {
  return host.target !== null
}

export type FileStatus = 'missing' | 'same' | 'different' | 'error'

/** 文件相对编辑器正文（或盘上正文）的状态。 */
export function fileStatus(target: InstructionTarget, text: string): FileStatus {
  if (target.error !== null) return 'error'
  if (!target.exists) return 'missing'
  return target.text === text ? 'same' : 'different'
}

/** Codex 的 project_doc_max_bytes 是 32 KiB：超过就提示，但不阻止写入。 */
export const CODEX_MAX_BYTES = 32 * 1024
