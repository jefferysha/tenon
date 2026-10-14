/**
 * M5 的边缘：读「项目 → 全局存储 → 插件模板」三处的工作流文件，交给纯函数 `buildRouterTable`，再编码成缓存。
 *
 * - 三个目录与 `loadWorkflow` 用同一套路径（`workflowsDirUnder` / `globalWorkflowRoot`，全局存储经 `resolveProductPaths`
 *   得到配置根）；模板目录由调用方给出（插件的 `templates/`）。
 * - 路由读文件有界且不跟随符号链接：每个目录最多 64 个、每个文件最多读 1 MiB；符号链接、隐藏文件、目录一律忽略。
 *   `router.sh` 命中缓存时用 shell 按同一约定重算摘要（见 router-table.ts 的 `routerSourceDigest`），所以这些界限不能随意改。
 * - 一份文件写坏只让它自己变成带错误的条目，不会抛出。
 */
import { closeSync, constants, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { ProductPathInput } from '../product-paths.js'
import { compileLoadedWorkflow } from '../workflow/track-lookup.js'
import { globalWorkflowRoot, workflowsDirUnder } from '../workflow/global-store.js'
import { isValidWorkflowName } from '../workflow/identifier.js'
import type { WorkflowIR } from '../workflow/ir.js'
import { parseWorkflow } from '../workflow/parse.js'
import { validateWorkflowForStorage } from '../workflow/validate.js'
import { encodeRouterCache } from './router-cache.js'
import {
  buildRouterTable, isBuiltinRouterWorkflow,
  type RouterSourceScope, type RouterTable, type RouterWorkflowSource,
} from './router-table.js'

/** 每个工作流文件最多读这么多字节（再多一个字节用来发现「超大」）。 */
export const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_FILES_PER_DIR = 64

export interface RouterSourceRequest {
  readonly repoRoot: string
  /** 插件的 `templates/` 目录；其下 `workflows/*.yaml` 是随插件发布的模板。 */
  readonly templatesRoot: string
  /** 测试用：覆盖 `resolveProductPaths` 的环境，决定全局存储的位置。 */
  readonly product?: ProductPathInput
}

export interface CollectedRouterSources {
  readonly sources: readonly RouterWorkflowSource[]
  readonly warnings: readonly string[]
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** 目录里的 `*.yaml` 普通文件名（字节序、非隐藏、非符号链接），最多 64 个。 */
function yamlFiles(dir: string, scope: RouterSourceScope, warnings: string[]): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') warnings.push(`无法读取 ${scope} 工作流目录：${code ?? String(error)}`)
    return []
  }
  const files = names
    .filter((name) => name.endsWith('.yaml') && !name.startsWith('.') && isRegularFile(join(dir, name)))
    .sort(byteOrder)
  if (files.length > MAX_FILES_PER_DIR) {
    warnings.push(`${scope} 工作流目录有 ${files.length} 个文件，只读前 ${MAX_FILES_PER_DIR} 个`)
  }
  return files.slice(0, MAX_FILES_PER_DIR)
}

/** 读至多 MAX_SOURCE_BYTES + 1 字节，不跟随符号链接（打开时就拒绝，不留检查与使用之间的空档）。 */
function readCapped(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null)
      if (read === 0) break
      total += read
    }
    return buffer.subarray(0, total)
  } finally {
    closeSync(fd)
  }
}

/** 与 `loadWorkflow` 同一条校验链（存储校验 + 按 default / custom 契约编译）；任何失败都是一个 Error 值。 */
function loadIr(id: string, source: string, oversize: boolean): WorkflowIR | Error {
  try {
    if (oversize) return new Error(`文件超过 1 MiB（${MAX_SOURCE_BYTES} 字节）`)
    if (!isValidWorkflowName(id)) return new Error(`非法 workflow 名 '${id}'`)
    const def = parseWorkflow(source)
    if (def.name !== id) return new Error(`文件名 '${id}' 与 name '${def.name}' 不一致`)
    const errors = validateWorkflowForStorage(id, def)
    if (errors.length > 0) return new Error(errors.join('；'))
    return compileLoadedWorkflow(id, def)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

function scopeSources(dir: string, scope: RouterSourceScope, warnings: string[]): RouterWorkflowSource[] {
  const sources: RouterWorkflowSource[] = []
  for (const name of yamlFiles(dir, scope, warnings)) {
    const id = name.slice(0, -'.yaml'.length)
    let bytes: Buffer
    try {
      bytes = readCapped(join(dir, name))
    } catch (error) {
      warnings.push(`无法读取 ${scope} 工作流 '${id}'：${errorCode(error) ?? String(error)}`)
      continue
    }
    // 非 UTF-8 的文件解码会改写字节，摘要因此与 shell 重算的对不上（每轮重建，路由结果仍然正确）；这样的文件本来也编译不过。
    const source = bytes.toString('utf8')
    sources.push({ id, scope, source, ir: loadIr(id, source, bytes.length > MAX_SOURCE_BYTES), builtin: isBuiltinRouterWorkflow(id) })
  }
  return sources
}

/** 三处目录里的全部工作流文件，按「项目、全局、模板」与文件名字节序排好（即遮蔽优先级与摘要的顺序）。 */
export function collectRouterSources(request: RouterSourceRequest): CollectedRouterSources {
  const warnings: string[] = []
  const sources = [
    ...scopeSources(workflowsDirUnder(request.repoRoot), 'project', warnings),
    ...scopeSources(workflowsDirUnder(globalWorkflowRoot(request.product)), 'global', warnings),
    ...scopeSources(join(request.templatesRoot, 'workflows'), 'template', warnings),
  ]
  return { sources, warnings }
}

export interface RouterCacheResult {
  readonly text: string
  readonly table: RouterTable
  readonly warnings: readonly string[]
}

/** 冷路径入口：收集 → 建表 → 编码。`projectRoot` 是规范化后的项目根（缓存元数据里的归属标记）。 */
export function generateRouterCache(request: RouterSourceRequest & { readonly projectRoot: string }): RouterCacheResult {
  const collected = collectRouterSources(request)
  const table = buildRouterTable(collected.sources)
  return {
    text: encodeRouterCache(table, request.projectRoot),
    table,
    warnings: [...collected.warnings, ...table.warnings],
  }
}
