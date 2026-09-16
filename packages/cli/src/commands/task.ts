/**
 * task 子命令 —— 依赖图 / children / cascade / canonical（CONTRACT §1 depends_on 列表字段）。
 * 老仓真相源：skills/pipeline/scripts/state-task.sh（语义盘点见 kernel/src/state/tasks.ts 顶注）。
 *   add-dep <name> <dep>       depends_on 追加（去重 + 防自环），无 stdout；[OK] 去重走 stderr
 *   remove-dep <name> <dep>    depends_on 移除（清空回空集 []），无 stdout
 *   children <name> [--json]   反查直接子（活跃 + 归档），stdout 列表 / JSON
 *   cascade <name>             BFS 传递闭包，stdout 逐行 active/archived
 *   canonical <name> [--json]  Tenon contract 24 字段 canonical task.json，stdout（pretty / 紧凑）
 *   delete / archive / unarchive <name> [--yes] [--json]  见 task-lifecycle.ts（退出码 0/1/2/3）
 * stdout/exit 对齐老仓：数据走 stdout（老仓 echo/printf/python print），状态与错误走 stderr
 * （老仓 red/green 均 >&2）。exit：错误/非法 = 1；成功 = 0。
 */
import type { ChangeNode, HistoryEntry, PipelineState, StateStore } from '@tenon/kernel'
import {
  addDependency,
  canonicalChildNames,
  cascadeDependents,
  directChildren,
  loadTaskTree,
  normalizeDeps,
  projectCanonical,
  removeDependency,
  resolveChangeDir,
  stateRelatedFiles,
  stateSubtasks,
  type ChildRef,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { cmdTaskArchive, cmdTaskDelete, cmdTaskUnarchive, type TaskLifecycleOpts } from './task-lifecycle.js'

export type { ChangeNode } from '@tenon/kernel'

/** 树枚举 / 目录定位注入面（默认真 fs；mock 层注入 fake，见 task.test.ts）。 */
export interface TaskFs {
  loadTree: (cwd: string, store: StateStore) => Promise<ChangeNode[]>
  resolveDir: (cwd: string, name: string) => Promise<string>
}

const REAL_FS: TaskFs = { loadTree: loadTaskTree, resolveDir: resolveChangeDir }

/** change 名校验（显式挡 undefined/空——isValidChangeName 对 "undefined" 会误判为合法）。 */
function checkName(deps: CliDeps, name: string | undefined): name is string {
  if (name !== undefined && name !== '' && isValidChangeName(name)) return true
  deps.io.err(`ERROR: change-name 非法: '${name ?? ''}' (仅允许 a-z A-Z 0-9 - _)`)
  return false
}

/** history 记账 best-effort（同 fields.ts recordHistory：失败仅 WARN，不影响主写 exit）。 */
async function recordHistory(deps: CliDeps, dir: string, entry: HistoryEntry): Promise<void> {
  if (!deps.history) return
  try {
    await deps.history.append(dir, entry)
  } catch (e) {
    deps.io.err(`WARN: history 写入失败: ${errMsg(e)}`)
  }
}

/** depends_on 写回 + history 记账（add/remove 共用）。 */
async function writeDeps(deps: CliDeps, dir: string, next: string[]): Promise<number> {
  try {
    await deps.store.set(dir, 'depends_on', next)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  await recordHistory(deps, dir, { ts: deps.clock(), kind: 'set', field: 'depends_on', to: next.join(',') })
  return 0
}

async function cmdAddDep(deps: CliDeps, name: string | undefined, dep: string | undefined): Promise<number> {
  if (!checkName(deps, name)) return 1
  if (dep === undefined || dep === '') {
    deps.io.err('ERROR: Usage: add-dep <change> <dep>')
    return 1
  }
  if (!isValidChangeName(dep)) {
    deps.io.err(`ERROR: dep 名非法: '${dep}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  // 防自环：依赖自己 → 拒（老仓 cmd_add_dep:153-156）
  if (dep === name) {
    deps.io.err(`ERROR: add-dep 不能依赖自己（自环）: ${name}`)
    return 1
  }
  const dir = changeDir(deps.cwd, name)
  let state: PipelineState
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const { deps: next, added } = addDependency(normalizeDeps(state.fields.depends_on), dep)
  if (!added) {
    // 去重幂等（老仓 green [OK] → stderr）
    deps.io.err(`[OK] ${name}: depends_on 已含 ${dep}（去重，未重复追加）`)
    return 0
  }
  return writeDeps(deps, dir, next)
}

async function cmdRemoveDep(deps: CliDeps, name: string | undefined, dep: string | undefined): Promise<number> {
  if (!checkName(deps, name)) return 1
  if (dep === undefined || dep === '') {
    deps.io.err('ERROR: Usage: remove-dep <change> <dep>')
    return 1
  }
  const dir = changeDir(deps.cwd, name)
  let state: PipelineState
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const next = removeDependency(normalizeDeps(state.fields.depends_on), dep)
  return writeDeps(deps, dir, next)
}

/** sort -u（老仓 cmd_children:268）：按 name\tarchived 去重再排序。 */
function sortUniqueChildren(rows: ChildRef[]): ChildRef[] {
  const seen = new Set<string>()
  const uniq: ChildRef[] = []
  for (const r of rows) {
    const k = `${r.name}\t${r.archived}`
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(r)
  }
  return uniq.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.archived === b.archived ? 0 : a.archived ? 1 : -1,
  )
}

const tag = (archived: boolean): string => (archived ? '[archived]' : '[active]')

async function cmdChildren(deps: CliDeps, args: string[], fs: TaskFs): Promise<number> {
  const name = args[0]
  const json = args.includes('--json')
  if (!checkName(deps, name)) return 1
  const tree = await fs.loadTree(deps.cwd, deps.store)
  const rows = sortUniqueChildren(directChildren(tree, name))
  if (json) {
    deps.io.out(JSON.stringify(rows.map((r) => ({ name: r.name, archived: r.archived }))))
    return 0
  }
  if (rows.length === 0) {
    deps.io.out(`(none) ${name} 无子 change（无 depends_on 指向它）`)
    return 0
  }
  deps.io.out(`[CHILDREN] ${name}（depends_on 指向它的 change）：`)
  for (const r of rows) deps.io.out(`  ${r.name} ${tag(r.archived)}`)
  return 0
}

async function cmdCascade(deps: CliDeps, name: string | undefined, fs: TaskFs): Promise<number> {
  if (!checkName(deps, name)) return 1
  const tree = await fs.loadTree(deps.cwd, deps.store)
  const desc = cascadeDependents(tree, name)
  deps.io.out(`[CASCADE] ${name} 的全部传递后代 dependent：`)
  if (desc.length === 0) {
    deps.io.out('  (none) 无后代 dependent')
    return 0
  }
  for (const r of desc) deps.io.out(`  ${r.name} ${tag(r.archived)}`)
  return 0
}

async function cmdCanonical(deps: CliDeps, args: string[], fs: TaskFs): Promise<number> {
  const name = args[0]
  const json = args.includes('--json')
  if (!checkName(deps, name)) return 1
  const dir = await fs.resolveDir(deps.cwd, name)
  let state: PipelineState
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const tree = await fs.loadTree(deps.cwd, deps.store)
  const rec = projectCanonical({
    name,
    fields: state.fields,
    subtasks: stateSubtasks(state),
    children: canonicalChildNames(tree, name),
    relatedFiles: stateRelatedFiles(state),
  })
  // pretty（默认）与 python json.dumps(indent=2) 逐字对齐；--json 紧凑（与 python 紧凑仅差
  // 分隔符空白，见报告 oracle 对位建议——本命令不入 oracle 门）。
  deps.io.out(json ? JSON.stringify(rec) : JSON.stringify(rec, null, 2))
  return 0
}

/** 生命周期子命令的开关（program.ts 把 --json / --yes 追加进 args，同 children/canonical 口径）。 */
function lifecycleOpts(args: readonly string[]): TaskLifecycleOpts {
  return { json: args.includes('--json'), yes: args.includes('--yes') }
}

/**
 * task 子命令分派（纯函数 + deps 注入，风格同 fields.ts）。
 * fs 缺省真 fs（integration 走真路径）；mock 层注入 fake TaskFs 快速回归。
 */
export async function cmdTask(
  deps: CliDeps,
  sub: string,
  args: string[],
  fs: TaskFs = REAL_FS,
): Promise<number> {
  switch (sub) {
    case 'add-dep':
      return cmdAddDep(deps, args[0], args[1])
    case 'remove-dep':
      return cmdRemoveDep(deps, args[0], args[1])
    case 'children':
      return cmdChildren(deps, args, fs)
    case 'cascade':
      return cmdCascade(deps, args[0], fs)
    case 'canonical':
      return cmdCanonical(deps, args, fs)
    case 'delete':
      return cmdTaskDelete(deps, args[0] ?? '', lifecycleOpts(args))
    case 'archive':
      return cmdTaskArchive(deps, args[0] ?? '', lifecycleOpts(args))
    case 'unarchive':
      return cmdTaskUnarchive(deps, args[0] ?? '', lifecycleOpts(args))
    default:
      deps.io.err(
        `ERROR: 未知 task 子命令: ${sub}`
        + '（支持: add-dep remove-dep children cascade canonical delete archive unarchive）',
      )
      return 1
  }
}
