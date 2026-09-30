/**
 * 产物索引：套件声明的产物路径（文件或目录，目录逐文件展开）与用例附件（截图、trace、视频）复制进本次运行的产物目录，
 * 并建立 `{path, bytes, digest, media}` 索引，Dashboard 按索引查看 / 下载。只收仓库内的普通文件（不跟随符号链接）；
 * 单文件 ≤64 MiB、单次运行 ≤256 MiB、单套件 ≤5000 个文件，超出的跳过并报 truncated。
 * 复制目标 `artifacts/<套件>/<仓库相对路径>`，索引里的 path 相对本次运行的产物目录。
 */
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtifactIndexEntry, ArtifactMedia } from '@tenon/kernel'

export const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024
export const MAX_ARTIFACT_RUN_BYTES = 256 * 1024 * 1024
export const MAX_ARTIFACT_FILES_PER_SUITE = 5000
/** 记录里索引路径的长度上限（记录解码器按 4096 字符封顶，留出余量）。 */
const MAX_INDEX_PATH = 3900

export interface ArtifactBudget { used: number }

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])
const VIDEO = new Set(['.webm', '.mp4', '.mov', '.mkv'])
const TEXT = new Set(['.txt', '.log', '.md', '.xml', '.yml', '.yaml', '.csv', '.lcov', '.info', '.tap'])

export function mediaOf(path: string): ArtifactMedia {
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  const ext = extname(lower)
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (/^trace(?:[-.].*)?\.zip$/.test(name) || name.endsWith('.trace') || name === 'trace.zip') return 'trace'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.json' || ext === '.jsonl') return 'json'
  if (TEXT.has(ext)) return 'text'
  return 'other'
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectStream)
    stream.once('end', () => resolveStream())
  })
  return `sha256:${hash.digest('hex')}`
}

async function insideRepo(repoRoot: string, path: string): Promise<boolean> {
  try {
    const rel = relative(await realpath(repoRoot), await realpath(path))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

async function walkFiles(dir: string, limit: number, out: string[]): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (await walkFiles(path, limit, out)) return true
    } else if (entry.isFile()) {
      if (out.length >= limit) return true
      out.push(path)
    }
  }
  return false
}

export interface CollectedArtifacts {
  readonly index: readonly ArtifactIndexEntry[]
  /** 源文件真实路径 → 索引路径（用例附件挂接用；键是 realpath，调用方查询前先 realpath）。 */
  readonly mapped: ReadonlyMap<string, string>
  readonly truncated: boolean
}

async function realOrSame(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** 复制并索引；artifactPaths 相对套件 cwd，extraFiles 是绝对路径（用例附件，可以是 realpath 或软链路径）。 */
export async function collectArtifacts(input: {
  readonly repoRoot: string
  readonly cwd: string
  readonly suiteId: string
  readonly artifactPaths: readonly string[]
  readonly extraFiles: readonly string[]
  /** 先于其余文件复制（运行预算不够时也要保住它们），例如套件报告。 */
  readonly priorityFiles?: readonly string[]
  readonly runDir: string
  readonly budget: ArtifactBudget
}): Promise<CollectedArtifacts> {
  const root = await realOrSame(input.repoRoot)
  const cwd = await realOrSame(input.cwd)
  const files: string[] = []
  let truncated = false
  for (const declared of input.artifactPaths) {
    const target = resolve(cwd, declared)
    let entry
    try {
      entry = await lstat(target)
    } catch {
      continue
    }
    if (entry.isSymbolicLink() || !(await insideRepo(root, target))) continue
    if (entry.isFile()) files.push(target)
    else if (entry.isDirectory() && await walkFiles(target, MAX_ARTIFACT_FILES_PER_SUITE, files)) truncated = true
  }
  const extras = await Promise.all(input.extraFiles.map((file) => realOrSame(resolve(cwd, file))))
  const priority = await Promise.all((input.priorityFiles ?? []).map((file) => realOrSame(resolve(cwd, file))))
  const all = [...new Set([...priority, ...files, ...extras])]
  const index: ArtifactIndexEntry[] = []
  const mapped = new Map<string, string>()
  const declaredDirs = input.artifactPaths.map((declared) => resolve(cwd, declared))
  for (const source of all) {
    if (index.length >= MAX_ARTIFACT_FILES_PER_SUITE) { truncated = true; break }
    let entry
    try {
      entry = await lstat(source)
    } catch {
      continue
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !(await insideRepo(root, source))) continue
    if (entry.size > MAX_ARTIFACT_FILE_BYTES || input.budget.used + entry.size > MAX_ARTIFACT_RUN_BYTES) { truncated = true; continue }
    const repoRelative = relative(root, source).split(sep).join('/')
    const indexPath = `artifacts/${input.suiteId}/${repoRelative}`
    if (indexPath.length > MAX_INDEX_PATH) { truncated = true; continue }
    const destination = join(input.runDir, ...indexPath.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    input.budget.used += entry.size
    const isEntry = declaredDirs.some((dir) => source === join(dir, 'index.html'))
    index.push({
      path: indexPath, bytes: entry.size, digest: await sha256Of(destination), media: mediaOf(indexPath),
      ...(isEntry ? { entry: true as const } : {}),
    })
    mapped.set(source, indexPath)
  }
  return { index: index.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)), mapped, truncated }
}
