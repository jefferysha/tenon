/**
 * `tenon verify --ci` 的任务选择：`--change`、`--all-open`、`--since <ref>`。
 * 选出来的是「仓库里提交了状态的任务」：活跃目录优先，已完结的任务在 `openspec/changes/archive/<日期>-<名>/`。
 */
import { readdirSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { stateStorageExistsSync, type CiSelector } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { changeNameOfArchivedDir, changesRoot, isValidChangeName, resolveChangeDir } from '../paths.js'
import { mergeBaseWith, rangeChangedPaths } from './verify-ci-git.js'

export interface SelectedChange {
  readonly name: string
  /** 绝对路径。 */
  readonly dir: string
  /** 仓库相对路径（正斜杠）。 */
  readonly relDir: string
}

export type Selection =
  | { readonly ok: true; readonly changes: readonly SelectedChange[] }
  | { readonly ok: false; readonly error: string }

function located(deps: CliDeps, name: string): SelectedChange | undefined {
  const dir = resolveChangeDir(deps.cwd, name)
  if (!stateStorageExistsSync(dir)) return undefined
  return { name, dir, relDir: relative(deps.cwd, dir).split(sep).join('/') }
}

function openNames(cwd: string): readonly string[] {
  try {
    return readdirSync(changesRoot(cwd), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && isValidChangeName(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 一个仓库相对路径属于哪个任务（任务目录、归档目录、用户记录目录）；都不是返回 undefined。 */
export function changeNameOfPath(path: string): string | undefined {
  const parts = path.split('/')
  if (parts[0] === 'openspec' && parts[1] === 'changes' && parts.length > 3) {
    if (parts[2] === 'archive') {
      const name = changeNameOfArchivedDir(parts[3] ?? '')
      return isValidChangeName(name) ? name : undefined
    }
    return isValidChangeName(parts[2] ?? '') ? parts[2] : undefined
  }
  // .tenon/users/<slug>/tests/<change>/<run>.json
  if (parts[0] === '.tenon' && parts[1] === 'users' && parts[3] === 'tests' && parts.length > 5) {
    return isValidChangeName(parts[4] ?? '') ? parts[4] : undefined
  }
  return undefined
}

export async function selectChanges(
  deps: CliDeps,
  selector: CiSelector,
  isFinished: (dir: string) => Promise<boolean>,
): Promise<Selection> {
  if (selector.kind === 'change') {
    if (!isValidChangeName(selector.change)) return { ok: false, error: `change-name 非法: '${selector.change}'` }
    const found = located(deps, selector.change)
    return found === undefined
      ? { ok: false, error: `change 不存在: ${selector.change}（既不在 openspec/changes/ 也不在 openspec/changes/archive/）` }
      : { ok: true, changes: [found] }
  }
  if (selector.kind === 'all-open') {
    const out: SelectedChange[] = []
    for (const name of openNames(deps.cwd)) {
      const found = located(deps, name)
      if (found !== undefined && !(await isFinished(found.dir))) out.push(found)
    }
    return { ok: true, changes: out }
  }
  const base = await mergeBaseWith(deps.cwd, selector.ref)
  if (base === undefined) {
    return { ok: false, error: `--since ${selector.ref}：解析不到这个引用，或它与 HEAD 没有共同祖先（浅克隆请用 fetch-depth: 0）` }
  }
  const paths = await rangeChangedPaths(deps.cwd, base)
  if (paths === undefined) return { ok: false, error: `读不出 ${base}..HEAD 的改动文件` }
  const names = [...new Set(paths.flatMap((path) => changeNameOfPath(path) ?? []))].sort()
  const out: SelectedChange[] = []
  for (const name of names) {
    const found = located(deps, name)
    if (found !== undefined) out.push(found)
  }
  return { ok: true, changes: out }
}
