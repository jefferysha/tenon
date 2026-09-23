/**
 * status [name] [--json] / list [--json] —— 展示层（CONTRACT §3）。
 * 人读：对齐宽度的紧凑表 / key-value 块；--json：schema 稳定（键序固定，见测试锚）。
 *   status --json        {"active_changes":[{name,track,phase,phase_status,verify_result,updated_at}]}
 *   status <c> --json    同上 + step；已完结的 change 不在 active_changes，而在 finished_changes（多 archived_at）
 *   list   --json        {"changes":[{name,track,phase,phase_status,owner:{id,name}|null}]}
 * 活跃 = openspec/changes/ 下有 .pipeline.yaml 且 archived != true；坏 change 跳过 + WARN。
 */
import { ownerOf, stateStorageExistsSync, type PipelineState } from '@tenon/kernel'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { archivedChangesForUser } from '../archivedGuard.js'
import { errMsg, type CliDeps } from '../deps.js'
import {
  archivedChangesRoot, changeDir, changeNameOfArchivedDir, changesRoot, isValidChangeName,
  readChangeForDisplay,
} from '../paths.js'
import { display, renderKV, renderTable, str } from '../render.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { buildStatusStep, finishedStatusStep, type StepBlock } from './statusStep.js'

interface Row {
  name: string
  state: PipelineState
}

function field(row: Row, name: keyof PipelineState['fields']): string {
  return str(row.state.fields[name])
}

/** 读活跃 change（排除 archived=true 与当前用户已归档的；单个读失败 → WARN + 跳过），按名排序 */
async function collectActive(deps: CliDeps): Promise<Row[]> {
  const names = [...(await deps.listChanges(changesRoot(deps.cwd)))].sort()
  const archivedForMe = await archivedChangesForUser(deps)
  const rows: Row[] = []
  for (const name of names) {
    if (archivedForMe.has(name)) continue
    try {
      const state = await deps.store.read(changeDir(deps.cwd, name))
      if (str(state.fields.archived) === 'true') continue
      rows.push({ name, state })
    } catch (e) {
      deps.io.err(`WARN: 跳过 ${name}（读取失败: ${errMsg(e)}）`)
    }
  }
  return rows
}

function ownerView(row: Row): { id: string; name: string } | null {
  const owner = ownerOf(row.state.fields)
  return owner === null ? null : { id: owner.id, name: owner.name }
}

function statusJson(row: Row): Record<string, string> {
  // 键序即 schema（status.test.ts 锚定逐字输出），改动 = 契约变更
  return {
    name: row.name,
    track: field(row, 'track'),
    phase: field(row, 'phase'),
    phase_status: field(row, 'phase_status'),
    verify_result: field(row, 'verify_result'),
    updated_at: field(row, 'updated_at'),
  }
}

export async function cmdStatus(
  deps: CliDeps,
  name: string | undefined,
  opts: { json?: boolean },
): Promise<number> {
  if (name !== undefined) {
    if (!isValidChangeName(name)) {
      deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
      return 1
    }
    let state: PipelineState
    // 已移进 archive/ 的 change 没有「下一步」——它的 step 投影只会描述一份不存在的工作区。
    let finished: boolean
    try {
      // 完结后 OpenSpec 会把目录移进 archive/；做完的任务仍要能查（见 paths.readChangeForDisplay）。
      const read = await readChangeForDisplay((dir) => deps.store.read(dir), deps.cwd, name)
      state = read.state
      finished = read.finished
    } catch (e) {
      // 不存在的任务是产品层的一句话，不是一行 `ENOENT ... open '.../.pipeline.yaml'`：那行既点名
      // 了内部存储文件，又不告诉读者该怎么办。`tenon get` 早已是这个口径，这里与它同一句。
      const code = typeof e === 'object' && e !== null ? Reflect.get(e, 'code') : undefined
      deps.io.err(code === 'ENOENT' ? `ERROR: change 不存在: ${name}` : `ERROR: ${errMsg(e)}`)
      return 1
    }
    const row: Row = { name, state }
    if (opts.json) {
      // 单个 change 的 JSON 多一块 step：单个 `tenon` skill 每一步照做的全部输入（键序即 schema）。
      // 列表形态（status --json 无名 / list --json）逐字不变。
      let step: StepBlock | undefined
      try {
        if (finished) {
          // 目录已搬进 archive/：没有工作区可投影，给结构一致、next 为 `stop finished` 的 step。
          let plan: ReturnType<typeof effectiveWorkflowForState>
          try {
            plan = effectiveWorkflowForState(deps, state)
          } catch {
            plan = null
          }
          step = await finishedStatusStep(deps, name, state, plan)
        } else {
          const plan = effectiveWorkflowForState(deps, state)
          if (plan !== null) step = await buildStatusStep(deps, name, state, plan)
        }
      } catch (e) {
        deps.io.err(`WARN: step 投影不可用: ${errMsg(e)}`)
      }
      // 已完结（archived=true，无论目录是否已被 `openspec archive` 搬走）不是活跃任务：与列表形态
      // （collectActive 按 archived=true 滤掉）和 `list --finished` 同一口径。它落在 finished_changes。
      // step 恒在（step.archived=true）：还有收尾动作时 next 是 finish-change，没有可做的事了是
      // `stop finished`——default 搬进 archive/ 之后与 simple 收尾之后是同一形态。
      const done = finished || str(state.fields.archived) === 'true'
      deps.io.out(JSON.stringify({
        active_changes: done ? [] : [statusJson(row)],
        ...(done ? { finished_changes: [{ ...statusJson(row), archived_at: field(row, 'archived_at') }] } : {}),
        ...(step === undefined ? {} : { step }),
      }))
      return 0
    }
    for (const line of renderKV([
      ['change', row.name],
      ['track', display(state.fields.track)],
      ['phase', `${display(state.fields.phase)} (${display(state.fields.phase_status)})`],
      ['verify', display(state.fields.verify_result)],
      ['updated', display(state.fields.updated_at)],
      // 完结的判定是 `archived=true`；目录被 OpenSpec 搬走与否只决定它还能不能继续改。
      ...(finished || str(state.fields.archived) === 'true'
        ? [
            ['archived', display(state.fields.archived)] as [string, string],
            ['archived_at', display(state.fields.archived_at)] as [string, string],
          ]
        : []),
    ])) {
      deps.io.out(line)
    }
    return 0
  }

  const rows = await collectActive(deps)
  if (opts.json) {
    deps.io.out(JSON.stringify({ active_changes: rows.map(statusJson) }))
    return 0
  }
  if (rows.length === 0) {
    deps.io.out('无活跃 change')
    return 0
  }
  const table = renderTable(
    ['NAME', 'TRACK', 'PHASE', 'STATUS', 'VERIFY', 'UPDATED'],
    rows.map((r) => [
      r.name,
      display(r.state.fields.track),
      display(r.state.fields.phase),
      display(r.state.fields.phase_status),
      display(r.state.fields.verify_result),
      display(r.state.fields.updated_at),
    ]),
  )
  for (const line of table) deps.io.out(line)
  return 0
}

/**
 * 完结的 change：`archived=true`，或已被 OpenSpec 移进 `openspec/changes/archive/`。
 *
 * 与 `list --archived` 不同：那是当前用户的「先收起来」隐藏表（per-user，可 unarchive），这里是
 * 全项目做完的任务。两者此前都看不到完结任务，做完的工作就此从所有列表里消失。
 *
 * 判定必须包含还留在活跃目录里的完结 change：`tenon transition <c> archived` 与 `openspec
 * archive` 是两条命令，中间那段时间里活跃表按 `archived=true` 把它滤掉、归档目录里又还没有它，
 * 任务在两张表里同时消失——正是这段注释说不该存在的状态。目录在哪只决定它还能不能继续改。
 */
async function collectFinished(deps: CliDeps): Promise<Row[]> {
  const rows = new Map<string, Row>()
  for (const name of [...(await deps.listChanges(changesRoot(deps.cwd)))].sort()) {
    try {
      const state = await deps.store.read(changeDir(deps.cwd, name))
      if (str(state.fields.archived) === 'true') rows.set(name, { name, state })
    } catch (e) {
      deps.io.err(`WARN: 跳过 ${name}（读取失败: ${errMsg(e)}）`)
    }
  }
  let entries
  try {
    entries = readdirSync(archivedChangesRoot(deps.cwd), { withFileTypes: true })
  } catch {
    return [...rows.values()]
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = join(archivedChangesRoot(deps.cwd), entry.name)
    if (!stateStorageExistsSync(dir)) continue
    const name = changeNameOfArchivedDir(entry.name)
    try {
      // 归档目录里的那份是既成事实的记录，同名时以它为准。
      rows.set(name, { name, state: await deps.store.read(dir) })
    } catch (e) {
      deps.io.err(`WARN: 跳过 ${entry.name}（读取失败: ${errMsg(e)}）`)
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function cmdListFinished(deps: CliDeps, opts: { json?: boolean }): Promise<number> {
  const rows = await collectFinished(deps)
  if (opts.json) {
    deps.io.out(JSON.stringify({
      finished: rows.map((r) => ({
        name: r.name,
        track: field(r, 'track'),
        phase: field(r, 'phase'),
        phase_status: field(r, 'phase_status'),
        archived: field(r, 'archived'),
        archived_at: field(r, 'archived_at'),
        owner: ownerView(r),
      })),
    }))
    return 0
  }
  if (rows.length === 0) {
    deps.io.out('无已完结 change')
    return 0
  }
  const table = renderTable(
    ['NAME', 'TRACK', 'PHASE', 'STATUS', 'ARCHIVED_AT', 'OWNER'],
    rows.map((r) => [
      r.name,
      display(r.state.fields.track),
      display(r.state.fields.phase),
      display(r.state.fields.phase_status),
      display(r.state.fields.archived_at),
      ownerView(r)?.name ?? '-',
    ]),
  )
  for (const line of table) deps.io.out(line)
  return 0
}

export async function cmdList(deps: CliDeps, opts: { json?: boolean }): Promise<number> {
  const rows = await collectActive(deps)
  if (opts.json) {
    deps.io.out(
      JSON.stringify({
        changes: rows.map((r) => ({
          // 键序即 schema（status.test.ts 锚定逐字输出），改动 = 契约变更
          name: r.name,
          track: field(r, 'track'),
          phase: field(r, 'phase'),
          phase_status: field(r, 'phase_status'),
          owner: ownerView(r),
        })),
      }),
    )
    return 0
  }
  if (rows.length === 0) {
    deps.io.out('无活跃 change')
    return 0
  }
  const table = renderTable(
    ['NAME', 'TRACK', 'PHASE', 'STATUS', 'OWNER'],
    rows.map((r) => [
      r.name,
      display(r.state.fields.track),
      display(r.state.fields.phase),
      display(r.state.fields.phase_status),
      ownerView(r)?.name ?? '-',
    ]),
  )
  for (const line of table) deps.io.out(line)
  return 0
}
