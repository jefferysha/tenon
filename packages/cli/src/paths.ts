/** change 定位与名字校验（CONTRACT §3：默认在 cwd 的 openspec/changes/<name>/ 下找） */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateStorageExistsSync } from '@tenon/kernel'

export function changesRoot(cwd: string): string {
  return join(cwd, 'openspec', 'changes')
}

export function changeDir(cwd: string, name: string): string {
  return join(changesRoot(cwd), name)
}

/** OpenSpec 归档目录：完结的 change 被移到这里，目录名是 `<name>` 或 `YYYY-MM-DD-<name>`。 */
export function archivedChangesRoot(cwd: string): string {
  return join(changesRoot(cwd), 'archive')
}

const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/u

/** 归档目录名 → 它承载的 change 名（去掉 OpenSpec 加的日期前缀）。 */
export function changeNameOfArchivedDir(dirName: string): string {
  return dirName.replace(ARCHIVE_DATE_PREFIX, '')
}

/**
 * 完结后 OpenSpec 会把 `openspec/changes/<name>` 移到 `openspec/changes/archive/<日期>-<name>`
 * （skills/openspec-archive-change 第 5 步），此后按活跃路径去读就只剩一句 ENOENT。做完的任务仍要
 * 可查，所以只读命令在活跃路径落空时回落到归档目录；同名多份（重跑过归档）取目录名最大的那份，
 * 日期前缀使字典序即时间序。写入路径不用本函数：归档目录是既成事实的记录，不是继续改的工作区。
 */
export function archivedChangeDir(cwd: string, name: string): string | null {
  let entries
  try {
    entries = readdirSync(archivedChangesRoot(cwd), { withFileTypes: true })
  } catch {
    return null
  }
  const matches = entries
    .filter((entry) => entry.isDirectory() && changeNameOfArchivedDir(entry.name) === name)
    .map((entry) => entry.name)
    .sort()
  for (let index = matches.length - 1; index >= 0; index--) {
    const dir = join(archivedChangesRoot(cwd), matches[index] as string)
    if (stateStorageExistsSync(dir)) return dir
  }
  return null
}

/**
 * 只读命令读 change：先按活跃路径读，只有读不到（change 目录已被归档移走）才回落到归档目录。
 *
 * 用「先读、失败再回落」而不是「先探路径再读」，是因为 store 是注入的：探真实文件系统会让注入了
 * 内存 store 的调用方（测试、dashboard）每次都被判成「已归档」。`finished` 只在真的从归档目录
 * 读到时为 true。
 */
export async function readChangeForDisplay<S>(
  read: (dir: string) => Promise<S>,
  cwd: string,
  name: string,
): Promise<{ readonly state: S; readonly finished: boolean }> {
  try {
    return { state: await read(changeDir(cwd, name)), finished: false }
  } catch (error) {
    const archived = archivedChangeDir(cwd, name)
    if (archived === null) throw error
    return { state: await read(archived), finished: true }
  }
}

/** 与老内核 validate_change_name 同口径：仅 a-z A-Z 0-9 - _（天然排除 .. / 空格 / 斜杠） */
export function isValidChangeName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}
