/**
 * `tenon assess --files` 的路径入口：把 agent 报来的「预计要改的文件」变成 `PathChange`。
 *
 * 只接受仓库内的相对路径：拒绝空串、NUL、绝对路径、`..` 段，以及经符号链接指向仓库外（或无法确认留在仓库内）
 * 的路径。只做 lstat / realpath，不读文件内容，也不跟随最后一级以外的链接去取内容——评估只按路径分类。
 * 每个路径按「存在 = modified，不存在 = added」定状态，与探针读 git 得到的两种状态同一口径；
 * 读不出来是否存在的路径（权限、I/O）不猜，直接拒绝。
 */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { PathChange } from '@tenon/kernel'

export type RepoPathProblem = 'empty' | 'nul' | 'absolute' | 'parent' | 'outside' | 'unreadable'

export type RepoPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly problem: RepoPathProblem }

/** 词法检查与规整（纯函数）：`./a//b` → `a/b`；`\` 只在判 `..` 与绝对路径时当分隔符，不改写。 */
export function normalizeRepoPath(input: string): RepoPathResult {
  if (input.includes('\0')) return { ok: false, problem: 'nul' }
  if (input.trim() === '') return { ok: false, problem: 'empty' }
  if (isAbsolute(input) || /^[A-Za-z]:[\\/]/u.test(input) || input.startsWith('\\\\')) return { ok: false, problem: 'absolute' }
  if (input.split(/[\\/]/u).includes('..')) return { ok: false, problem: 'parent' }
  const kept = input.split('/').filter((segment) => segment !== '' && segment !== '.')
  return kept.length === 0 ? { ok: false, problem: 'empty' } : { ok: true, path: kept.join('/') }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isMissing(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 路径（解开符号链接后）是否仍在仓库真实根内。还不存在的路径看最近的已存在祖先；悬空的符号链接读不出目标，
 * 无法确认留在仓库内，和其它读不了的情形（权限、链接环）一起失败关闭。
 */
async function staysInside(realRoot: string, absolute: string): Promise<boolean> {
  let probe = absolute
  for (;;) {
    try {
      return isInside(realRoot, await realpath(probe))
    } catch (error) {
      if (!isMissing(error) || await isSymlink(probe)) return false
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}

/** 路径存在性探测（`lstat` 的最小形状）；参数化只为让测试能模拟读不出来的文件系统。 */
export type ExistenceProbe = (path: string) => Promise<unknown>

/** 只有「确实没有」（ENOENT / ENOTDIR）算不存在；权限、I/O 等其它失败说明没法判断，抛出让调用方失败关闭。 */
async function exists(path: string, probe: ExistenceProbe): Promise<boolean> {
  try {
    await probe(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function failureReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}

export type RepoPathChanges =
  | { readonly ok: true; readonly changes: readonly PathChange[] }
  | {
      readonly ok: false
      readonly path: string
      readonly problem: RepoPathProblem
      /** 仅 `unreadable`：探测失败的 errno 码（没有就取错误文本）。 */
      readonly reason?: string
    }

/**
 * 校验并转换一组路径；第一条不合法或读不出来的路径即返回（带原始输入，便于报错）。规整后相同的路径只算一次。
 * 存在性读不出来（权限、I/O）时不能默认成「不存在」——那会把已有文件按新增文件评估——所以按 `unreadable` 拒绝。
 */
export async function repoPathChanges(
  repoRoot: string,
  inputs: readonly string[],
  probe: ExistenceProbe = lstat,
): Promise<RepoPathChanges> {
  const realRoot = await realpath(repoRoot)
  const seen = new Set<string>()
  const changes: PathChange[] = []
  for (const input of inputs) {
    const normalized = normalizeRepoPath(input)
    if (!normalized.ok) return { ok: false, path: input, problem: normalized.problem }
    if (seen.has(normalized.path)) continue
    seen.add(normalized.path)
    const absolute = join(repoRoot, ...normalized.path.split('/'))
    if (!await staysInside(realRoot, absolute)) return { ok: false, path: input, problem: 'outside' }
    try {
      changes.push({ path: normalized.path, status: await exists(absolute, probe) ? 'modified' : 'added' })
    } catch (error) {
      return { ok: false, path: input, problem: 'unreadable', reason: failureReason(error) }
    }
  }
  return { ok: true, changes }
}
