/**
 * 资源目录的全局存储 `<configRoot>/resources/{builtin,custom}`。
 *
 * builtin 由 syncBuiltinLibraries 按 payload 摘要整份同步（只读，装完或升级后第一次读时收敛）；
 * custom 由 Dashboard 读写，写入前必须能解析且校验通过，所以盘上的自定义条目始终合法。
 * 读取从不因单个坏文件失败：解析不了的条目进 errors，其余照常返回。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseResourceEntry } from '../resources/parse.js'
import { validateResourceEntry } from '../resources/validate.js'
import {
  RESOURCE_ENTRY_MAX_BYTES, RESOURCE_ID,
  type ResourceEntry, type ResourceFileError, type ResourceSource, type StoredResource,
} from '../resources/types.js'
import { sha256Hex } from '../sha256.js'
import { withLock } from '../state/lock.js'
import { builtinLibrary, syncBuiltinLibrary, type BuiltinSyncResult } from './builtin-library-sync.js'

export type ResourceStoreErrorCode = 'invalid' | 'builtin-readonly' | 'conflict' | 'not-found' | 'duplicate'

export class ResourceStoreError extends Error {
  readonly code: ResourceStoreErrorCode
  readonly errors: readonly string[]
  constructor(code: ResourceStoreErrorCode, message: string, errors: readonly string[] = []) {
    super(message)
    this.name = 'ResourceStoreError'
    this.code = code
    this.errors = errors
  }
}

export interface ResourceStoreOptions {
  /** 插件根目录；builtin 条目从 `<payloadRoot>/templates/resources/builtin` 同步。 */
  readonly payloadRoot: string
  /** 全局 config 根；条目落在 `<configRoot>/resources/{builtin,custom}`。 */
  readonly configRoot: string
}

/** `<configRoot>/resources`。 */
export const resourceStoreRoot = (configRoot: string): string => join(configRoot, 'resources')

const sourceDir = (storeRoot: string, source: ResourceSource): string => join(storeRoot, source)

async function listYaml(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.yaml')).sort()
  } catch {
    return []
  }
}

function read(text: string, file: string, source: ResourceSource): StoredResource | ResourceFileError {
  let entry: ResourceEntry
  try {
    entry = parseResourceEntry(text)
  } catch (error) {
    return { file, source, errors: [error instanceof Error ? error.message : String(error)] }
  }
  const errors = validateResourceEntry(entry, file)
  if (errors.length > 0) return { file, source, errors }
  return { entry, source, revision: `sha256:${sha256Hex(text)}` }
}

const isStored = (value: StoredResource | ResourceFileError): value is StoredResource => 'entry' in value

/** builtin 同步：摘要相同直接返回 unchanged，失败不抛出（旧 builtin 原样保留）。 */
export async function ensureBuiltinResources(options: ResourceStoreOptions): Promise<BuiltinSyncResult> {
  return syncBuiltinLibrary(builtinLibrary('resources'), options.payloadRoot, options.configRoot)
}

export interface ResourceCatalog {
  readonly resources: StoredResource[]
  readonly errors: ResourceFileError[]
  readonly sync: BuiltinSyncResult
}

/** 读全量目录；custom 与 builtin 撞 id 时 custom 被记为错误并排除。 */
export async function loadResourceCatalog(options: ResourceStoreOptions): Promise<ResourceCatalog> {
  const sync = await ensureBuiltinResources(options)
  const storeRoot = resourceStoreRoot(options.configRoot)
  const resources: StoredResource[] = []
  const errors: ResourceFileError[] = []
  const builtinIds = new Set<string>()
  for (const source of ['builtin', 'custom'] as const) {
    const dir = sourceDir(storeRoot, source)
    for (const file of await listYaml(dir)) {
      let text: string
      try {
        text = await readFile(join(dir, file), 'utf8')
      } catch (error) {
        errors.push({ file, source, errors: [error instanceof Error ? error.message : String(error)] })
        continue
      }
      const result = read(text, file, source)
      if (!isStored(result)) {
        errors.push(result)
        continue
      }
      if (source === 'builtin') builtinIds.add(result.entry.id)
      else if (builtinIds.has(result.entry.id)) {
        errors.push({ file, source, errors: ['与内置资源 id 重复'] })
        continue
      }
      resources.push(result)
    }
  }
  return { resources, errors, sync }
}

export interface ResourceFile { readonly stored: StoredResource; readonly yaml: string }

/** 单个条目的原文；custom 优先于同名 builtin（正常情况下两者不会同名）。 */
export async function readResourceFile(storeRoot: string, id: string): Promise<ResourceFile | null> {
  if (!RESOURCE_ID.test(id)) return null
  for (const source of ['custom', 'builtin'] as const) {
    let text: string
    try {
      text = await readFile(join(sourceDir(storeRoot, source), `${id}.yaml`), 'utf8')
    } catch {
      continue
    }
    const result = read(text, `${id}.yaml`, source)
    if (isStored(result)) return { stored: result, yaml: text }
    throw new ResourceStoreError('invalid', '条目不合法', result.errors)
  }
  return null
}

async function currentRevision(path: string): Promise<string | null> {
  try {
    return `sha256:${sha256Hex(await readFile(path, 'utf8'))}`
  } catch {
    return null
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function builtinExists(storeRoot: string, id: string): Promise<boolean> {
  try {
    await readFile(join(sourceDir(storeRoot, 'builtin'), `${id}.yaml`), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 新建或覆盖一条自定义条目；revision 给定时做乐观并发比对。 */
export async function writeCustomResource(
  storeRoot: string, id: string, yaml: string, revision?: string,
): Promise<StoredResource> {
  if (!RESOURCE_ID.test(id)) throw new ResourceStoreError('invalid', '条目不合法', [`id 必须匹配 ${RESOURCE_ID.source}`])
  if (new TextEncoder().encode(yaml).length > RESOURCE_ENTRY_MAX_BYTES) {
    throw new ResourceStoreError('invalid', '条目不合法', [`条目超过 ${RESOURCE_ENTRY_MAX_BYTES} 字节`])
  }
  const result = read(yaml, `${id}.yaml`, 'custom')
  if (!isStored(result)) throw new ResourceStoreError('invalid', '条目不合法', result.errors)
  await mkdir(storeRoot, { recursive: true })
  return withLock(storeRoot, async () => {
    if (await builtinExists(storeRoot, id)) throw new ResourceStoreError('builtin-readonly', '内置资源只读，先复制')
    const path = join(sourceDir(storeRoot, 'custom'), `${id}.yaml`)
    const now = await currentRevision(path)
    if (revision !== undefined && now !== revision) throw new ResourceStoreError('conflict', '资源已在磁盘上被修改，重新载入')
    await writeAtomic(path, yaml)
    return result
  })
}

/** 复制成新的自定义条目，id 为 `<id>-copy`、`<id>-copy-2`…；返回新 id。 */
export async function copyResource(storeRoot: string, id: string): Promise<string> {
  const file = await readResourceFile(storeRoot, id)
  if (!file) throw new ResourceStoreError('not-found', `未知资源：${id}`)
  await mkdir(storeRoot, { recursive: true })
  return withLock(storeRoot, async () => {
    const taken = new Set([
      ...await listYaml(sourceDir(storeRoot, 'builtin')),
      ...await listYaml(sourceDir(storeRoot, 'custom')),
    ].map((name) => name.slice(0, -'.yaml'.length)))
    let next = `${id}-copy`
    for (let index = 2; taken.has(next); index++) next = `${id}-copy-${index}`
    if (!RESOURCE_ID.test(next)) throw new ResourceStoreError('duplicate', `复制 id 过长：${next}`)
    await writeAtomic(join(sourceDir(storeRoot, 'custom'), `${next}.yaml`), file.yaml.replace(/^id: .*$/mu, `id: ${next}`))
    return next
  })
}

export async function deleteCustomResource(storeRoot: string, id: string, revision?: string): Promise<void> {
  if (!RESOURCE_ID.test(id)) throw new ResourceStoreError('not-found', `未知资源：${id}`)
  await mkdir(storeRoot, { recursive: true })
  await withLock(storeRoot, async () => {
    if (await builtinExists(storeRoot, id)) throw new ResourceStoreError('builtin-readonly', '内置资源只读，先复制')
    const path = join(sourceDir(storeRoot, 'custom'), `${id}.yaml`)
    const now = await currentRevision(path)
    if (now === null) throw new ResourceStoreError('not-found', `未知资源：${id}`)
    if (revision !== undefined && now !== revision) throw new ResourceStoreError('conflict', '资源已在磁盘上被修改，重新载入')
    await rm(path)
  })
}
