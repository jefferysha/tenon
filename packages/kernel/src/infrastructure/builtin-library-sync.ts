/**
 * 内建库同步：把插件 payload 里的 `templates/<kind>/…` 按内容摘要整份复制到全局 `config/<kind>/builtin/`。
 *
 * 所有内建库（模板、agent、资源目录、测试方向）共用本实现，只各加一行 BUILTIN_LIBRARIES。
 * 触发点：release 激活提交之后、Dashboard 每次读库之前；摘要相同直接返回 unchanged。
 * `builtin/` 每次整份替换（staging → rename），同级的 `custom/` 从不打开。失败按库返回，不抛出，
 * 旧的 builtin 保持原样。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isInstructionCategory } from '../instructions/categories.js'
import { parseInstructionBlock } from '../instructions/block.js'
import { parseResourceEntry } from '../resources/parse.js'
import { validateResourceEntry } from '../resources/validate.js'
import { parseTestDirection } from '../test-evidence/direction.js'
import { sha256Hex } from '../sha256.js'
import { withLock } from '../state/lock.js'

export const BUILTIN_LIBRARY_MARKER = '.library.json'
const MAX_FILES = 512
const MAX_FILE_BYTES = 64 * 1024

export interface BuiltinLibrary {
  /** 写进标记文件的库名。 */
  id: string
  /** payload 根目录下的相对路径（POSIX）。 */
  source: string
  /** configRoot 下的相对路径（POSIX），以 `builtin` 结尾。 */
  target: string
  /** 参与同步的文件扩展名；其它文件忽略。 */
  extensions: readonly string[]
  /** 校验一个源文件；返回错误列表，任一文件有错则整个库同步失败。 */
  validate(relativePath: string, text: string): readonly string[]
}

function validateInstructionTemplate(relativePath: string, text: string): readonly string[] {
  const segments = relativePath.split('/')
  const category = segments[0] ?? ''
  if (segments.length !== 2 || !isInstructionCategory(category)) return ['路径必须是 <category>/<id>.md']
  const parsed = parseInstructionBlock(text, { category, id: (segments[1] ?? '').replace(/\.md$/u, '') })
  return parsed.ok ? [] : parsed.errors.map((error) => `${error.line === undefined ? '' : `${error.line}: `}${error.detail}`)
}

function validateResourceEntryFile(relativePath: string, text: string): readonly string[] {
  if (relativePath.includes('/')) return ['条目必须直接放在 builtin/ 下']
  try {
    return validateResourceEntry(parseResourceEntry(text), relativePath)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

function validateTestDirection(relativePath: string, text: string): readonly string[] {
  if (relativePath.includes('/')) return ['路径必须是 <id>.yaml']
  try {
    const direction = parseTestDirection(text)
    return direction.id === relativePath.replace(/\.yaml$/u, '') ? [] : ['id 必须等于文件名主干']
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

export const BUILTIN_LIBRARIES: readonly BuiltinLibrary[] = [
  {
    id: 'instruction-templates',
    source: 'templates/instructions/builtin',
    target: 'templates/instructions/builtin',
    extensions: ['.md'],
    validate: validateInstructionTemplate,
  },
  {
    id: 'resources',
    source: 'templates/resources/builtin',
    target: 'resources/builtin',
    extensions: ['.yaml'],
    validate: validateResourceEntryFile,
  },
  {
    id: 'test-directions',
    source: 'templates/test-directions',
    target: 'test-directions/builtin',
    extensions: ['.yaml'],
    validate: validateTestDirection,
  },
]

/** 按 id 取库定义；调用方只同步自己那一个库时用。 */
export function builtinLibrary(id: string): BuiltinLibrary {
  const library = BUILTIN_LIBRARIES.find((item) => item.id === id)
  if (!library) throw new Error(`未知内建库：${id}`)
  return library
}

export type BuiltinSyncResult =
  | { id: string; state: 'updated' | 'unchanged' }
  | { id: string; state: 'failed'; detail: string }

export interface BuiltinLibraryMarker { version: 1; library: string; source_digest: string; synced_at: string }

interface SourceFile { path: string; bytes: Buffer }

class SyncFailure extends Error {}

async function readSourceTree(library: BuiltinLibrary, root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(relative === '' ? root : join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.')) continue
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      const item = await lstat(join(root, path))
      if (item.isSymbolicLink()) throw new SyncFailure(`${path}: 不允许符号链接`)
      if (item.isDirectory()) {
        await walk(path)
        continue
      }
      if (!item.isFile() || !library.extensions.some((extension) => entry.name.endsWith(extension))) continue
      if (files.length >= MAX_FILES) throw new SyncFailure(`文件超过 ${MAX_FILES} 个`)
      if (item.size > MAX_FILE_BYTES) throw new SyncFailure(`${path}: 超过 ${MAX_FILE_BYTES} 字节`)
      files.push({ path, bytes: await readFile(join(root, path)) })
    }
  }
  try {
    const top = await lstat(root)
    if (top.isSymbolicLink() || !top.isDirectory()) throw new SyncFailure(`${library.source} 不是目录`)
  } catch (error) {
    if (error instanceof SyncFailure) throw error
    throw new SyncFailure(`${library.source} 不存在`)
  }
  await walk('')
  return files
}

/** 源摘要：排好序的 `<posix 相对路径>\0<文件 sha256>\n` 行再做 sha256。 */
export function builtinSourceDigest(files: readonly { path: string; bytes: Uint8Array }[]): string {
  const lines = files
    .map((file) => `${file.path}\0${sha256Hex(file.bytes)}\n`)
    .sort()
    .join('')
  return `sha256:${sha256Hex(lines)}`
}

export function parseBuiltinLibraryMarker(text: string): BuiltinLibraryMarker | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = Object.fromEntries(Object.entries(value))
  if (Object.keys(record).sort().join(',') !== 'library,source_digest,synced_at,version') return null
  if (record.version !== 1 || typeof record.library !== 'string' || typeof record.source_digest !== 'string'
    || typeof record.synced_at !== 'string') return null
  return { version: 1, library: record.library, source_digest: record.source_digest, synced_at: record.synced_at }
}

async function readMarker(targetDir: string): Promise<BuiltinLibraryMarker | null> {
  try {
    return parseBuiltinLibraryMarker(await readFile(join(targetDir, BUILTIN_LIBRARY_MARKER), 'utf8'))
  } catch {
    return null
  }
}

async function removeStale(parent: string, base: string): Promise<void> {
  for (const name of await readdir(parent)) {
    if (name.startsWith(`${base}.staging-`) || name.startsWith(`${base}.old-`)) {
      await rm(join(parent, name), { recursive: true, force: true })
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function replaceTarget(library: BuiltinLibrary, parent: string, targetDir: string, files: readonly SourceFile[], digest: string): Promise<void> {
  const base = basename(targetDir)
  const staging = join(parent, `${base}.staging-${process.pid}-${randomUUID()}`)
  const old = join(parent, `${base}.old-${randomUUID()}`)
  try {
    await mkdir(staging, { mode: 0o755 })
    for (const file of files) {
      const destination = join(staging, ...file.path.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o644 })
    }
    const marker: BuiltinLibraryMarker = { version: 1, library: library.id, source_digest: digest, synced_at: new Date().toISOString() }
    await writeFile(join(staging, BUILTIN_LIBRARY_MARKER), `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o644 })
    if (!(await exists(targetDir))) {
      await rename(staging, targetDir)
      return
    }
    await rename(targetDir, old)
    try {
      await rename(staging, targetDir)
    } catch (error) {
      await rename(old, targetDir)
      throw error
    }
    await rm(old, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

export async function syncBuiltinLibrary(library: BuiltinLibrary, payloadRoot: string, configRoot: string): Promise<BuiltinSyncResult> {
  try {
    const files = await readSourceTree(library, join(payloadRoot, ...library.source.split('/')))
    const problems = files.flatMap((file) => library.validate(file.path, file.bytes.toString('utf8')).map((detail) => `${file.path}: ${detail}`))
    if (problems.length > 0) return { id: library.id, state: 'failed', detail: problems.join('; ') }
    const digest = builtinSourceDigest(files)
    const targetDir = join(configRoot, ...library.target.split('/'))
    const parent = dirname(targetDir)
    await mkdir(parent, { recursive: true })
    return await withLock(parent, async () => {
      await removeStale(parent, basename(targetDir))
      const marker = await readMarker(targetDir)
      if (marker?.library === library.id && marker.source_digest === digest) return { id: library.id, state: 'unchanged' as const }
      await replaceTarget(library, parent, targetDir, files, digest)
      return { id: library.id, state: 'updated' as const }
    })
  } catch (error) {
    return { id: library.id, state: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function syncBuiltinLibraries(
  payloadRoot: string,
  configRoot: string,
  libraries: readonly BuiltinLibrary[] = BUILTIN_LIBRARIES,
): Promise<readonly BuiltinSyncResult[]> {
  const results: BuiltinSyncResult[] = []
  for (const library of libraries) results.push(await syncBuiltinLibrary(library, payloadRoot, configRoot))
  return results
}
