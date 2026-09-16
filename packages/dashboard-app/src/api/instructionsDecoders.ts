/**
 * 指令模板库、指令文件与新建项目接口的闭合解码器：多键、缺键、枚举越界一律返回 null。
 * 形状与 server `instructionRoutes.ts` / `instructionFiles.ts` / `projectCreate.ts` 的响应逐字段对应。
 */
import { isRecord, stringArray } from './transport'

export const TEMPLATE_CATEGORIES = ['common', 'frontend', 'state', 'styling', 'backend', 'mobile', 'system', 'api', 'database'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]
export type TemplateSource = 'builtin' | 'custom'
export interface TemplateRef { source: TemplateSource; category: TemplateCategory; id: string }

export interface BuiltinSync { id: string; state: 'updated' | 'unchanged' | 'failed'; detail?: string }
export interface TemplateSummary extends TemplateRef { title: string; frameworks: string[]; digest: string; errors: string[] }
export interface TemplateList { sync: BuiltinSync | null; templates: TemplateSummary[] }
export interface TemplateVariable { key: string; default: string | null }
export interface TemplateBlock {
  title: string
  frameworks: string[]
  directory: string | null
  directory_label: string | null
  catalog: string[]
  catalog_ref: string | null
  variables: TemplateVariable[]
}
export interface TemplateDocument extends TemplateRef { text: string; digest: string; block: TemplateBlock | null; errors: string[] }
export interface ComposedDirectory { path: string; label: string }
export interface ComposeResult { markdown: string; directories: ComposedDirectory[]; bytes: number }

/** 项目级指令文件（协议闭集，server 的解码器只接受这三个）。 */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const
export type ProjectInstructionFile = (typeof PROJECT_INSTRUCTION_FILES)[number]

export type InstructionLevels = 'joined' | 'project-wins' | 'user-wins' | 'project-only' | 'needs-config'
export type InstructionTargetError = 'managed-block-invalid' | 'target-symlink' | 'not-file' | 'too-large' | 'path-unsafe'
export interface InstructionHostRow { id: string; levels: InstructionLevels; target: string | null; effective_file?: string }
export interface InstructionTarget {
  id: string
  path: string
  exists: boolean
  digest: string
  text: string
  managed: { tag: string }[]
  bytes: number
  error: InstructionTargetError | null
}
export interface InstructionState { level: 'project' | 'user'; root: string; hosts: InstructionHostRow[]; targets: InstructionTarget[] }
export interface InstructionPreviewFile { id: string; path: string; base_digest: string; current: string | null; next: string }
export interface AppliedFile { id: string; digest: string }

export interface ProjectCreatePlan {
  root: string
  git: 'init' | 'existing' | 'none'
  registration: 'add' | 'already'
  directories: { path: string; exists: boolean }[]
  files: InstructionPreviewFile[]
}
export interface ProjectCreated {
  root: string
  git: 'init' | 'existing' | 'none'
  registration: 'add' | 'already'
  directories: string[]
  files: AppliedFile[]
}

/** 键集合必须恰好是 required ∪（optional 的子集）。 */
function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value)
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isCategory = (value: unknown): value is TemplateCategory => oneOf(value, TEMPLATE_CATEGORIES)
const isSource = (value: unknown): value is TemplateSource => oneOf(value, ['builtin', 'custom'] as const)

function decodeList<T>(value: unknown, decode: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const item of value) {
    const decoded = decode(item)
    if (decoded === null) return null
    out.push(decoded)
  }
  return out
}

function decodeSync(value: unknown): BuiltinSync | null | undefined {
  if (value === null) return null
  if (exactKeys(value, ['id', 'state']) && typeof value.id === 'string' && oneOf(value.state, ['updated', 'unchanged'] as const)) {
    return { id: value.id, state: value.state }
  }
  if (exactKeys(value, ['id', 'state', 'detail']) && typeof value.id === 'string' && value.state === 'failed' && typeof value.detail === 'string') {
    return { id: value.id, state: 'failed', detail: value.detail }
  }
  return undefined
}

function decodeSummary(value: unknown): TemplateSummary | null {
  if (!exactKeys(value, ['source', 'category', 'id', 'title', 'frameworks', 'digest', 'errors'])) return null
  if (!isSource(value.source) || !isCategory(value.category) || typeof value.id !== 'string' || typeof value.title !== 'string'
    || !stringArray(value.frameworks) || typeof value.digest !== 'string' || !stringArray(value.errors)) return null
  return {
    source: value.source, category: value.category, id: value.id, title: value.title,
    frameworks: value.frameworks, digest: value.digest, errors: value.errors,
  }
}

export function decodeTemplateList(value: unknown): TemplateList | null {
  if (!exactKeys(value, ['ok', 'sync', 'templates']) || value.ok !== true) return null
  const sync = decodeSync(value.sync)
  const templates = decodeList(value.templates, decodeSummary)
  return sync === undefined || templates === null ? null : { sync, templates }
}

function decodeVariable(value: unknown): TemplateVariable | null {
  return exactKeys(value, ['key', 'default']) && typeof value.key === 'string' && nullableString(value.default)
    ? { key: value.key, default: value.default }
    : null
}

function decodeBlock(value: unknown): TemplateBlock | null | undefined {
  if (value === null) return null
  if (!exactKeys(value, ['title', 'frameworks', 'directory', 'directory_label', 'catalog', 'catalog_ref', 'variables'])) return undefined
  const variables = decodeList(value.variables, decodeVariable)
  if (typeof value.title !== 'string' || !stringArray(value.frameworks) || !nullableString(value.directory)
    || !nullableString(value.directory_label) || !stringArray(value.catalog) || !nullableString(value.catalog_ref) || variables === null) return undefined
  return {
    title: value.title, frameworks: value.frameworks, directory: value.directory, directory_label: value.directory_label,
    catalog: value.catalog, catalog_ref: value.catalog_ref, variables,
  }
}

export function decodeTemplateDocument(value: unknown): TemplateDocument | null {
  if (!exactKeys(value, ['ok', 'source', 'category', 'id', 'text', 'digest', 'block', 'errors']) || value.ok !== true) return null
  const block = decodeBlock(value.block)
  if (!isSource(value.source) || !isCategory(value.category) || typeof value.id !== 'string' || typeof value.text !== 'string'
    || typeof value.digest !== 'string' || block === undefined || !stringArray(value.errors)) return null
  return { source: value.source, category: value.category, id: value.id, text: value.text, digest: value.digest, block, errors: value.errors }
}

export function decodeDigest(value: unknown): string | null {
  return exactKeys(value, ['ok', 'digest']) && value.ok === true && typeof value.digest === 'string' ? value.digest : null
}

function decodeDirectory(value: unknown): ComposedDirectory | null {
  return exactKeys(value, ['path', 'label']) && typeof value.path === 'string' && typeof value.label === 'string'
    ? { path: value.path, label: value.label }
    : null
}

export function decodeComposeResult(value: unknown): ComposeResult | null {
  if (!exactKeys(value, ['ok', 'markdown', 'directories', 'bytes']) || value.ok !== true) return null
  const directories = decodeList(value.directories, decodeDirectory)
  if (typeof value.markdown !== 'string' || directories === null || typeof value.bytes !== 'number') return null
  return { markdown: value.markdown, directories, bytes: value.bytes }
}

const LEVELS = ['joined', 'project-wins', 'user-wins', 'project-only', 'needs-config'] as const
const TARGET_ERRORS = ['managed-block-invalid', 'target-symlink', 'not-file', 'too-large', 'path-unsafe'] as const

function decodeHost(value: unknown): InstructionHostRow | null {
  if (!exactKeys(value, ['id', 'levels', 'target'], ['effective_file'])) return null
  if (typeof value.id !== 'string' || !oneOf(value.levels, LEVELS) || !nullableString(value.target)) return null
  if (value.effective_file !== undefined && typeof value.effective_file !== 'string') return null
  return {
    id: value.id, levels: value.levels, target: value.target,
    ...(typeof value.effective_file === 'string' ? { effective_file: value.effective_file } : {}),
  }
}

function decodeTarget(value: unknown): InstructionTarget | null {
  if (!exactKeys(value, ['id', 'path', 'exists', 'digest', 'text', 'managed', 'bytes', 'error'])) return null
  const managed = decodeList(value.managed, (item) => (exactKeys(item, ['tag']) && typeof item.tag === 'string' ? { tag: item.tag } : null))
  if (typeof value.id !== 'string' || typeof value.path !== 'string' || typeof value.exists !== 'boolean' || typeof value.digest !== 'string'
    || typeof value.text !== 'string' || managed === null || typeof value.bytes !== 'number'
    || (value.error !== null && !oneOf(value.error, TARGET_ERRORS))) return null
  return {
    id: value.id, path: value.path, exists: value.exists, digest: value.digest, text: value.text, managed,
    bytes: value.bytes, error: value.error === null ? null : value.error,
  }
}

export function decodeInstructionState(value: unknown): InstructionState | null {
  if (!exactKeys(value, ['ok', 'level', 'root', 'hosts', 'targets']) || value.ok !== true) return null
  const hosts = decodeList(value.hosts, decodeHost)
  const targets = decodeList(value.targets, decodeTarget)
  if (!oneOf(value.level, ['project', 'user'] as const) || typeof value.root !== 'string' || hosts === null || targets === null) return null
  return { level: value.level, root: value.root, hosts, targets }
}

function decodePreviewFile(value: unknown): InstructionPreviewFile | null {
  if (!exactKeys(value, ['id', 'path', 'base_digest', 'current', 'next'])) return null
  return typeof value.id === 'string' && typeof value.path === 'string' && typeof value.base_digest === 'string'
    && nullableString(value.current) && typeof value.next === 'string'
    ? { id: value.id, path: value.path, base_digest: value.base_digest, current: value.current, next: value.next }
    : null
}

export function decodeInstructionPreview(value: unknown): InstructionPreviewFile[] | null {
  return exactKeys(value, ['ok', 'files']) && value.ok === true ? decodeList(value.files, decodePreviewFile) : null
}

function decodeApplied(value: unknown): AppliedFile | null {
  return exactKeys(value, ['id', 'digest']) && typeof value.id === 'string' && typeof value.digest === 'string'
    ? { id: value.id, digest: value.digest }
    : null
}

export function decodeInstructionApply(value: unknown): AppliedFile[] | null {
  return exactKeys(value, ['ok', 'files']) && value.ok === true ? decodeList(value.files, decodeApplied) : null
}

export function decodeInstructionDelete(value: unknown): 'removed' | 'managed-kept' | null {
  return exactKeys(value, ['ok', 'result'], ['digest']) && value.ok === true && oneOf(value.result, ['removed', 'managed-kept'] as const) ? value.result : null
}

const GIT = ['init', 'existing', 'none'] as const
const REGISTRATION = ['add', 'already'] as const

export function decodeProjectCreatePlan(value: unknown): ProjectCreatePlan | null {
  if (!exactKeys(value, ['ok', 'root', 'git', 'registration', 'directories', 'files']) || value.ok !== true) return null
  const directories = decodeList(value.directories, (item) =>
    (exactKeys(item, ['path', 'exists']) && typeof item.path === 'string' && typeof item.exists === 'boolean' ? { path: item.path, exists: item.exists } : null))
  const files = decodeList(value.files, decodePreviewFile)
  if (typeof value.root !== 'string' || !oneOf(value.git, GIT) || !oneOf(value.registration, REGISTRATION) || directories === null || files === null) return null
  return { root: value.root, git: value.git, registration: value.registration, directories, files }
}

export function decodeProjectCreated(value: unknown): ProjectCreated | null {
  if (!exactKeys(value, ['ok', 'root', 'git', 'registration', 'directories', 'files']) || value.ok !== true) return null
  const files = decodeList(value.files, decodeApplied)
  if (typeof value.root !== 'string' || !oneOf(value.git, GIT) || !oneOf(value.registration, REGISTRATION)
    || !stringArray(value.directories) || files === null) return null
  return { root: value.root, git: value.git, registration: value.registration, directories: value.directories, files }
}
