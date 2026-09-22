/**
 * status [name] [--json] / list [--json] —— 展示层（CONTRACT §3）。
 * 人读：对齐宽度的紧凑表 / key-value 块；--json：schema 稳定（键序固定，见测试锚）。
 *   status --json        {"active_changes":[{name,track,phase,phase_status,verify_result,updated_at}]}
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
import { buildStatusStep, type StepBlock } from './statusStep.js'

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
      deps.io.err(`ERROR: ${errMsg(e)}`)
      return 1
    }
    const row: Row = { name, state }
    if (opts.json) {
      // 单个 change 的 JSON 多一块 step：单个 `tenon` skill 每一步照做的全部输入（键序即 schema）。
      // 列表形态（status --json 无名 / list --json）逐字不变。
      let step: StepBlock | undefined
      try {
        const plan = finished ? null : effectiveWorkflowForState(deps, state)
        if (plan !== null) step = await buildStatusStep(deps, name, state, plan)
      } catch (e) {
        deps.io.err(`WARN: step 投影不可用: ${errMsg(e)}`)
      }
      deps.io.out(JSON.stringify({
        active_changes: [statusJson(row)],
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
      ...(finished
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
 * 完结并被 OpenSpec 移进 `openspec/changes/archive/` 的 change。
 *
 * 与 `list --archived` 不同：那是当前用户的「先收起来」隐藏表（per-user，可 unarchive），这里是
 * 全项目做完的任务。两者此前都看不到完结任务，做完的工作就此从所有列表里消失。
 */
async function collectFinished(deps: CliDeps): Promise<Row[]> {
  let entries
  try {
    entries = readdirSync(archivedChangesRoot(deps.cwd), { withFileTypes: true })
  } catch {
    return []
  }
  const rows: Row[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = join(archivedChangesRoot(deps.cwd), entry.name)
    if (!stateStorageExistsSync(dir)) continue
    try {
      rows.push({ name: changeNameOfArchivedDir(entry.name), state: await deps.store.read(dir) })
    } catch (e) {
      deps.io.err(`WARN: 跳过 ${entry.name}（读取失败: ${errMsg(e)}）`)
    }
  }
  return rows
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
