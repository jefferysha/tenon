/**
 * 新建项目时每个指令文件实际写入的正文：
 *
 * - references 里的文件（CLAUDE.md / GEMINI.md）只写一行 `@AGENTS.md` 引用，不复制全文；
 * - append 里的文件保留已有正文，把新内容接在后面（已包含同样内容时不再重复，重试幂等）；
 * - 其余文件用新正文替换已有正文。三种情况下已有的受管块都原样保留（由 mergeManagedBlocks 负责）。
 */
import { parseManagedBlocks } from '@tenon/kernel'
import { previewInstructionApply, type InstructionResult } from './instructionFiles.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

export const REFERENCE_FILES: readonly string[] = ['CLAUDE.md', 'GEMINI.md']
export const REFERENCE_TEXT = '@AGENTS.md\n'

export interface InstructionsRequest {
  readonly text: string
  readonly targets: readonly string[]
  readonly baseDigests: Readonly<Record<string, string>>
  readonly references: readonly string[]
  readonly append: readonly string[]
}

/** current = 盘上全文（含受管块），null = 文件不存在。 */
export function effectiveText(request: InstructionsRequest, id: string, current: string | null): string {
  const base = request.references.includes(id) ? REFERENCE_TEXT : request.text
  if (!request.append.includes(id) || current === null) return base
  const parsed = parseManagedBlocks(current)
  if (!parsed.ok) return base
  const user = parsed.userText.replace(/\s+$/u, '')
  if (user === '') return base
  const addition = base.replace(/\s+$/u, '')
  if (addition === '' || user.includes(addition)) return parsed.userText
  return `${user}\n\n${addition}\n`
}

interface PreviewFile { id: string; path: string; base_digest: string; current: string | null; next: string }

function previewFiles(result: InstructionResult): PreviewFile[] {
  const files = Reflect.get(Object(result.body), 'files')
  return Array.isArray(files) ? files : []
}

/** 单个文件的 dry run：先读现状，再按实际正文算 next。 */
export function previewProjectFile(anchor: WorkflowRootAnchor, request: InstructionsRequest, id: string): InstructionResult {
  const scope = { level: 'project' as const, anchor }
  const first = previewInstructionApply(scope, request.text, [id])
  if (first.status !== 200) return first
  const current = previewFiles(first)[0]?.current ?? null
  const text = effectiveText(request, id, current)
  return text === request.text ? first : previewInstructionApply(scope, text, [id])
}

/** 全部目标文件的 dry run；任一失败即返回该失败。 */
export function previewProjectFiles(anchor: WorkflowRootAnchor, request: InstructionsRequest): InstructionResult {
  const files: PreviewFile[] = []
  for (const id of request.targets) {
    const preview = previewProjectFile(anchor, request, id)
    if (preview.status !== 200) return preview
    files.push(...previewFiles(preview))
  }
  return { status: 200, body: { ok: true, files } }
}
