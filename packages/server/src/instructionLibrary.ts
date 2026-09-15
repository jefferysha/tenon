/**
 * 指令模板库：`<configRoot>/templates/instructions/{builtin,custom}/<category>/<id>.md`。
 *
 * builtin 由 kernel syncBuiltinLibraries 按摘要整份同步（只读）；custom 由本模块读写，保存前必须能被
 * parseInstructionBlock 解析，所以经 UI 写入的自定义模板始终合法。解析与拼合只调用 kernel，不在 server 复制规则。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  INSTRUCTION_BLOCK_MAX_BYTES, INSTRUCTION_CATEGORIES, composeInstructions, isInstructionCategory, isTemplateId,
  isTemplateSource, parseInstructionBlock,
  type BlockError, type CatalogLookup, type ComposeSelection, type InstructionBlock, type InstructionCategory, type TemplateRef,
} from '@tenon/kernel'
import { listTrustedDirectory, readTrustedFile, unlinkTrustedFile, writeTrustedFile } from './instructionTrustedFs.js'
import {
  assertWorkflowRootAnchor, captureWorkflowRootAnchor, closeWorkflowRootAnchor, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export interface LibraryResult { readonly status: number; readonly body: unknown }

export interface TemplateSummary {
  source: TemplateRef['source']
  category: InstructionCategory
  id: string
  title: string
  frameworks: readonly string[]
  digest: string
  errors: string[]
}

const anchors = new Map<string, WorkflowRootAnchor>()

/** 模板库根目录的受信锚点（首次使用时创建目录）；锚点失效时重新捕获。 */
export function templateLibraryAnchor(configRoot: string): WorkflowRootAnchor {
  const root = join(configRoot, 'templates', 'instructions')
  const cached = anchors.get(root)
  if (cached) {
    try {
      assertWorkflowRootAnchor(cached)
      return cached
    } catch {
      closeWorkflowRootAnchor(cached)
      anchors.delete(root)
    }
  }
  mkdirSync(root, { recursive: true })
  const anchor = captureWorkflowRootAnchor(root)
  anchors.set(root, anchor)
  return anchor
}

const formatError = (error: BlockError): string => `${error.line === undefined ? '' : `${error.line}: `}${error.detail}`

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): LibraryResult {
  return { status, body: { ok: false, code, error, ...extra } }
}

function invalid(errors: readonly string[]): LibraryResult {
  return { status: 400, body: { ok: false, code: 'invalid', errors } }
}

export function parseTemplateRef(source: string, category: string, id: string): TemplateRef | null {
  return isTemplateSource(source) && isInstructionCategory(category) && isTemplateId(id) ? { source, category, id } : null
}

function readRef(anchor: WorkflowRootAnchor, ref: TemplateRef) {
  return readTrustedFile(anchor, [ref.source, ref.category], `${ref.id}.md`, INSTRUCTION_BLOCK_MAX_BYTES)
}

export function listTemplates(anchor: WorkflowRootAnchor): TemplateSummary[] {
  const templates: TemplateSummary[] = []
  for (const source of ['builtin', 'custom'] as const) {
    for (const category of INSTRUCTION_CATEGORIES) {
      for (const name of listTrustedDirectory(anchor, [source, category])) {
        const id = name.endsWith('.md') ? name.slice(0, -3) : ''
        if (!isTemplateId(id)) continue
        const read = readRef(anchor, { source, category, id })
        if (read.bytes === null) {
          if (read.error) templates.push({ source, category, id, title: id, frameworks: [], digest: read.digest, errors: [read.error] })
          continue
        }
        const parsed = parseInstructionBlock(read.bytes.toString('utf8'), { category, id })
        templates.push({
          source, category, id,
          title: parsed.ok ? parsed.block.title : id,
          frameworks: parsed.ok ? parsed.block.frameworks : [],
          digest: read.digest,
          errors: parsed.ok ? [] : parsed.errors.map(formatError),
        })
      }
    }
  }
  return templates
}

function blockBody(block: InstructionBlock): Record<string, unknown> {
  return {
    title: block.title,
    frameworks: block.frameworks,
    directory: block.directory ?? null,
    directory_label: block.directoryLabel ?? null,
    catalog: block.catalog,
    catalog_ref: block.catalogRef ?? null,
    variables: block.variables.map((variable) => ({ key: variable.key, default: variable.default ?? null })),
  }
}

export function readTemplate(anchor: WorkflowRootAnchor, ref: TemplateRef): LibraryResult {
  const read = readRef(anchor, ref)
  if (read.error) return fail(409, read.error, '模板文件不可读')
  if (read.bytes === null) return fail(404, 'template-not-found', '模板不存在')
  const text = read.bytes.toString('utf8')
  const parsed = parseInstructionBlock(text, { category: ref.category, id: ref.id })
  return {
    status: 200,
    body: {
      ok: true, ...ref, text, digest: read.digest,
      block: parsed.ok ? blockBody(parsed.block) : null,
      errors: parsed.ok ? [] : parsed.errors.map(formatError),
    },
  }
}

export function writeCustomTemplate(
  anchor: WorkflowRootAnchor, category: InstructionCategory, id: string, text: string, ifMatch: string,
): LibraryResult {
  const parsed = parseInstructionBlock(text, { category, id })
  if (!parsed.ok) return invalid(parsed.errors.map(formatError))
  const written = writeTrustedFile(anchor, ['custom', category], `${id}.md`, text, ifMatch, INSTRUCTION_BLOCK_MAX_BYTES)
  if (written.ok) return { status: 200, body: { ok: true, digest: written.digest } }
  if (written.code === 'changed') return fail(409, 'template-changed', '模板已被修改', { digest: written.digest })
  return fail(409, written.code, '模板文件不可写')
}

export function copyTemplate(anchor: WorkflowRootAnchor, from: TemplateRef, id: string): LibraryResult {
  const read = readRef(anchor, from)
  if (read.error) return fail(409, read.error, '模板文件不可读')
  if (read.bytes === null) return fail(404, 'template-not-found', '模板不存在')
  const text = read.bytes.toString('utf8').replace(/^id: .*$/m, `id: ${id}`)
  const parsed = parseInstructionBlock(text, { category: from.category, id })
  if (!parsed.ok) return invalid(parsed.errors.map(formatError))
  const written = writeTrustedFile(anchor, ['custom', from.category], `${id}.md`, text, 'absent', INSTRUCTION_BLOCK_MAX_BYTES)
  if (written.ok) return { status: 200, body: { ok: true, digest: written.digest } }
  if (written.code === 'changed') return fail(409, 'template-exists', '同名自定义模板已存在')
  return fail(409, written.code, '模板文件不可写')
}

export function deleteCustomTemplate(anchor: WorkflowRootAnchor, category: InstructionCategory, id: string, digest: string): LibraryResult {
  const removed = unlinkTrustedFile(anchor, ['custom', category], `${id}.md`, digest, INSTRUCTION_BLOCK_MAX_BYTES)
  if (removed.ok) return { status: 200, body: { ok: true } }
  if (removed.code === 'missing') return fail(404, 'template-not-found', '模板不存在')
  if (removed.code === 'changed') return fail(409, 'template-changed', '模板已被修改', { digest: removed.digest })
  return fail(409, removed.code, '模板文件不可删除')
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function stringMap(value: unknown): Record<string, string> | null {
  const entries = record(value)
  if (!entries) return null
  return Object.values(entries).every((item) => typeof item === 'string') ? Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, String(v)])) : null
}

function catalogMap(value: unknown): ComposeSelection['catalog'] | null {
  const entries = record(value)
  if (!entries) return null
  const out: Record<string, readonly string[]> = {}
  for (const [key, ids] of Object.entries(entries)) {
    if (!Array.isArray(ids) || !ids.every((item) => typeof item === 'string')) return null
    out[key] = ids.map(String)
  }
  return out
}

/** POST /api/instruction-templates/compose 的请求体解码 + 读块 + kernel 拼合。 */
export function composeFromRequest(anchor: WorkflowRootAnchor, body: unknown, catalog: CatalogLookup): LibraryResult {
  const request = record(body)
  if (!request || !onlyKeys(request, ['project_name', 'selections'])) return invalid(['请求体只允许 project_name 与 selections'])
  const projectName = typeof request.project_name === 'string' ? request.project_name.trim() : ''
  if (projectName === '' || projectName.length > 100) return invalid(['project_name 必须是 1–100 个字符'])
  if (!Array.isArray(request.selections) || request.selections.length > 64) return invalid(['selections 必须是不超过 64 项的数组'])
  const selections: ComposeSelection[] = []
  const errors: string[] = []
  for (const [index, raw] of request.selections.entries()) {
    const item = record(raw)
    const ref = item ? parseTemplateRef(String(item.source), String(item.category), String(item.id)) : null
    const values = item?.values === undefined ? {} : stringMap(item.values)
    const catalogSelection = item?.catalog === undefined ? undefined : catalogMap(item.catalog)
    if (!item || !onlyKeys(item, ['source', 'category', 'id', 'values', 'catalog']) || !ref || values === null || catalogSelection === null) {
      errors.push(`selections[${index}] 不合法`)
      continue
    }
    const read = readRef(anchor, ref)
    if (read.bytes === null) {
      errors.push(`${ref.source}/${ref.category}/${ref.id}: 模板不存在或不可读`)
      continue
    }
    const parsed = parseInstructionBlock(read.bytes.toString('utf8'), { category: ref.category, id: ref.id })
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((error) => `${ref.source}/${ref.category}/${ref.id}: ${formatError(error)}`))
      continue
    }
    selections.push({ ref, block: parsed.block, values, ...(catalogSelection === undefined ? {} : { catalog: catalogSelection }) })
  }
  if (errors.length > 0) return invalid(errors)
  const composed = composeInstructions({ projectName, selections, catalog })
  if (!composed.ok) {
    return invalid(composed.errors.map((error) => `${error.code} ${error.ref.source}/${error.ref.category}/${error.ref.id}: ${error.detail}`))
  }
  return {
    status: 200,
    body: { ok: true, markdown: composed.markdown, directories: composed.directories, bytes: Buffer.byteLength(composed.markdown, 'utf8') },
  }
}
