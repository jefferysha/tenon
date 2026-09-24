/**
 * 页面内目录浏览器的数据源：列出一个目录下的子目录（不含文件、不含符号链接），供原生对话框不可用时「选择」目录。
 *
 * 只读、不跟随符号链接；默认隐藏以点开头的目录。单次最多返回 FOLDER_LIST_MAX 项并标 truncated——
 * 这是交互式逐级浏览，不做分页游标。
 */
import { lstatSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

export const FOLDER_LIST_MAX = 2000

export interface FolderEntry { readonly name: string; readonly path: string }

export type FolderListResult =
  | { readonly status: 200; readonly body: { ok: true; dir: string; parent: string | null; home: string; entries: FolderEntry[]; truncated: boolean } }
  | { readonly status: 400 | 403 | 404; readonly body: { ok: false; code: string; error: string } }

const fail = (status: 400 | 403 | 404, code: string, error: string): FolderListResult => ({ status, body: { ok: false, code, error } })

/** dir 为空 = 主目录。 */
export function listFolders(rawDir: string, showHidden: boolean, home: string): FolderListResult {
  const requested = rawDir === '' ? home : rawDir
  if (requested.includes('\0') || !isAbsolute(requested)) return fail(400, 'invalid-path', '路径必须是绝对路径')
  const dir = resolvePath(requested)
  let entry
  try {
    entry = lstatSync(dir)
  } catch {
    return fail(404, 'path-missing', '路径不存在')
  }
  if (entry.isSymbolicLink()) return fail(400, 'path-unsafe', '路径不能是符号链接')
  if (!entry.isDirectory()) return fail(400, 'not-directory', '路径不是目录')
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
    return code === 'EACCES' || code === 'EPERM' ? fail(403, 'permission-denied', '没有读取权限') : fail(404, 'path-missing', '路径不存在')
  }
  const entries = names
    .filter((item) => item.isDirectory() && (showHidden || !item.name.startsWith('.')))
    .map((item) => ({ name: item.name, path: join(dir, item.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(dir)
  return {
    status: 200,
    body: {
      ok: true, dir, parent: parent === dir ? null : parent, home,
      entries: entries.slice(0, FOLDER_LIST_MAX), truncated: entries.length > FOLDER_LIST_MAX,
    },
  }
}
