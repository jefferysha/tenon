/**
 * get / set / set-many / cas —— 字段读写命令（CONTRACT §3，2026-07-06 oracle 实测回写）。
 * stdout/exit 契约（get/set 以老内核双跑逐字一致为准）：
 *   get      裸值一行（去引号后由 store 保证），0；字段缺失/未知 → 空行 + 0（老内核 yaml_get 语义）；
 *            change 缺失/名非法=1
 *   set      无输出，0；四闸/枚举/未知字段/身份/负责人/已归档拒写=1
 *            （枚举表对齐老内核 state-fields.sh cmd_set）
 *   set-many 无输出，同 set
 *   cas      无输出，0；不匹配=3；错误=1
 *
 * 三条写命令与 document record / review request / transition 同属 Change 改写，因此过同一条
 * 身份+负责人闸（writePreflight + 锁内 assertOwner）。`get` 是只读面，不过闸。
 */
import { FIELD_ORDER, LIST_FIELDS } from '@tenon/kernel'
import type { FieldName, HistoryEntry } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, readChangeForDisplay } from '../paths.js'
import {
  checkName, runComboWrite, runGuardedCas, runGuardedWrite, writePreflight,
} from './field-writes.js'
import {
  enumValueAllowed,
  fieldPatch,
  REVIEW_GATE_FIELDS,
  scalarField,
  scalarValue,
} from './field-values.js'

/** history 记账 best-effort（CONTRACT §1：失败仅 WARN，绝不影响主写已成功的 exit） */
export async function recordHistory(deps: CliDeps, dir: string, entry: HistoryEntry): Promise<void> {
  if (!deps.history) return
  try {
    await deps.history.append(dir, entry)
  } catch (e) {
    deps.io.err(`WARN: history 写入失败: ${errMsg(e)}`)
  }
}

function asField(deps: CliDeps, field: string): FieldName | undefined {
  if ((FIELD_ORDER as readonly string[]).includes(field)) return field as FieldName
  deps.io.err(`ERROR: 未知字段: ${field}`)
  return undefined
}

/** Review receipt 是 transition 安全边界，不能经通用状态写入口伪造。 */
function rejectReviewGateField(deps: CliDeps, field: FieldName): boolean {
  if (!REVIEW_GATE_FIELDS.has(field)) return false
  deps.io.err(`ERROR: 字段 '${field}' 由 tenon review request|acknowledge 管理，禁止通过 set/set-many/cas 写入`)
  return true
}

/**
 * `phase` is the state-machine cursor.  It must only change as part of a
 * validated transition (which also appends history and applies phase guards),
 * never through the generic field writers.  Keeping this check beside the
 * review-receipt guard ensures set, set-many and cas share one protected-field
 * boundary.
 */
function rejectProtectedField(deps: CliDeps, field: FieldName): boolean {
  if (field === 'phase' || field === 'created_by' || field === 'assignee') {
    deps.io.err(`ERROR: 字段 '${field}' 由 ${field === 'phase' ? 'tenon transition' : 'tenon owner'} 管理，禁止通过 set/set-many/cas 写入`)
    return true
  }
  // 完结是一次转换，不是一个字段。`archived`/`archived_at` 由 archived 事件的 archive-run 副作用
  // 成对落下（archived=true + archived_at=<now>，phase_status=done 在 flow 层）；手写 archived
  // 只会留下 archived=true、archived_at=null、phase_status=pending 这种半盖章的终态。
  if (field === 'archived' || field === 'archived_at') {
    deps.io.err(`ERROR: 字段 '${field}' 由 tenon transition <change> archived 管理，禁止通过 set/set-many/cas 写入；完结须经该转换才会同时落 archived_at 与 phase_status`)
    return true
  }
  return rejectReviewGateField(deps, field)
}

function isListField(field: FieldName): boolean {
  return (LIST_FIELDS as readonly string[]).includes(field)
}

/** 列表字段的 CLI 值口径：逗号分隔、去首尾空白、剔空项；空串=清空 */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function coerceValue(field: FieldName, raw: string): string | string[] {
  return isListField(field) ? splitList(raw) : raw
}

export async function cmdGet(deps: CliDeps, name: string, field: string): Promise<number> {
  if (!checkName(deps, name)) return 1
  try {
    // 状态文件缺失仍 fail-loud（老内核 ensure_state_exists）；字段缺失/未知则对齐
    // 老内核 yaml_get grep 语义：空行 + exit 0（2026-07-06 oracle 实测回写）。
    // 完结并被 OpenSpec 移入 archive/ 的 change 仍可读（readChangeForDisplay 的回落）。
    const { state } = await readChangeForDisplay((dir) => deps.store.read(dir), deps.cwd, name)
    const known = (FIELD_ORDER as readonly string[]).includes(field)
    const v = known ? state.fields[field as FieldName] : undefined
    deps.io.out(v === undefined ? '' : Array.isArray(v) ? v.join(',') : v)
    return 0
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? Reflect.get(e, 'code') : undefined
    deps.io.err(code === 'ENOENT' ? `ERROR: change 不存在: ${name}` : `ERROR: ${errMsg(e)}`)
    return 1
  }
}

export async function cmdSet(deps: CliDeps, name: string, field: string, value: string): Promise<number> {
  const owner = await writePreflight(deps, name)
  if (owner === null) return 1
  const f = asField(deps, field)
  if (!f) return 1
  if (rejectProtectedField(deps, f)) return 1
  const v = coerceValue(f, value)
  if (!enumValueAllowed(deps, f, v)) return 1
  const dir = changeDir(deps.cwd, name)
  // track/workflow：锁内按「更新后的最终 {track,workflow} 组合」校验 + 落盘（R2 · 关 TOCTOU、堵旁路）。
  //  - set track    → finalTrack=新值、finalWorkflow=旧 workflow（读 state 补齐）；
  //  - set workflow → finalTrack=旧 track（读 state 补齐）、finalWorkflow=新值。
  // 两者都过统一的 checkTrackWorkflow（requireTrack + assertWorkflowAllowed）；内建轨 allowed='*'
  // 恒放行（零回归）。此前 set track 只 requireTrack、不看旧 workflow，是 codex R2 点名的旁路。
  if (f === 'track' || f === 'workflow') {
    const code = await runComboWrite(deps, dir, owner, (cur) => ({
      kind: 'write',
      finalTrack: f === 'track' ? (v as string) : scalarField(cur, 'track'),
      finalWorkflow: f === 'workflow' ? (v as string) : scalarField(cur, 'workflow'),
      patch: fieldPatch(f, v),
    }))
    if (code !== 0) return code
    await recordHistory(deps, dir, { ts: deps.clock(), kind: 'set', field: f, to: v as string })
    return 0
  }
  // P6：非 track/workflow 字段也走锁内 read→判 artifact→write（不能锁外判定再 store.set，
  // store.set 另取锁，artifact 判定依据 phase/track/workflow 存在 TOCTOU）。artifact 字段 → 拒。
  const code = await runGuardedWrite(deps, dir, owner, fieldPatch(f, v))
  if (code !== 0) return code
  await recordHistory(deps, dir, {
    ts: deps.clock(),
    kind: 'set',
    field: f,
    to: Array.isArray(v) ? v.join(',') : v,
  })
  return 0
}

export async function cmdSetMany(deps: CliDeps, name: string, pairs: string[]): Promise<number> {
  const owner = await writePreflight(deps, name)
  if (owner === null) return 1
  const kv: Partial<Record<FieldName, string | string[]>> = {}
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    if (i <= 0) {
      deps.io.err(`ERROR: kv 格式错误(缺 '=' 或键为空): ${pair}`)
      return 1
    }
    const f = asField(deps, pair.slice(0, i))
    if (!f) return 1
    if (rejectProtectedField(deps, f)) return 1
    if (Object.hasOwn(kv, f)) {
      // 同字段重复 key：拒写（旧行为静默 last-wins，如 `phase=build phase=spec` 只留后者）
      deps.io.err(`ERROR: set-many 重复字段 '${f}'（同键多次赋值，拒写以免静默 last-wins）`)
      return 1
    }
    const v = coerceValue(f, pair.slice(i + 1))
    if (!enumValueAllowed(deps, f, v)) return 1
    kv[f] = v
  }
  if (Object.keys(kv).length === 0) {
    deps.io.err('ERROR: set-many 至少需要 1 个 key=value')
    return 1
  }
  const dir = changeDir(deps.cwd, name)
  // 触及 track 和/或 workflow 时：锁内按「更新后的最终组合」校验 + 整批落盘（R2 · 关 TOCTOU）。
  // 读旧 state 补齐未在本批显式给出的那一半，避免只校验单字段漏掉「新 track 不允许旧 workflow」
  // （反之亦然）的组合。不触及两者的 set-many（如仅改 build_mode/isolation）走原路 store.setMany
  // （其内部自持一次锁完成 read-modify-write）——不额外 read、不做组合校验，无从谈起也无需谈起。
  if (Object.hasOwn(kv, 'track') || Object.hasOwn(kv, 'workflow')) {
    const code = await runComboWrite(deps, dir, owner, (cur) => ({
      kind: 'write',
      finalTrack: scalarValue(kv.track, scalarField(cur, 'track')),
      finalWorkflow: scalarValue(kv.workflow, scalarField(cur, 'workflow')),
      patch: kv,
    }))
    if (code !== 0) return code
  } else {
    // P6：不触及 track/workflow 的批量也走锁内 read→判 artifact 并集→write（同 set，堵 TOCTOU +
    // artifact 字段 cutover）。任一字段命中当前/patch 后有效 artifact 集 → 整批拒、零落盘。
    const code = await runGuardedWrite(deps, dir, owner, kv)
    if (code !== 0) return code
  }
  for (const [f, v] of Object.entries(kv) as Array<[FieldName, string | string[]]>) {
    await recordHistory(deps, dir, {
      ts: deps.clock(),
      kind: 'set',
      field: f,
      to: Array.isArray(v) ? v.join(',') : v,
    })
  }
  return 0
}

export async function cmdCas(
  deps: CliDeps,
  name: string,
  field: string,
  expect: string,
  next: string,
): Promise<number> {
  const owner = await writePreflight(deps, name)
  if (owner === null) return 1
  const f = asField(deps, field)
  if (!f) return 1
  if (rejectProtectedField(deps, f)) return 1
  // 老内核 cmd_cas 仅对 automation 复用枚举校验（state-fields.sh）
  if (f === 'automation' && !enumValueAllowed(deps, f, next)) return 1
  const dir = changeDir(deps.cwd, name)
  // track/workflow：锁内 read + 比对 expect + 最终组合校验 + 条件写（R2 · 关 TOCTOU、堵 cas 旁路）。
  //  - cas track    → finalTrack=next、finalWorkflow=旧 workflow；
  //  - cas workflow → finalTrack=旧 track、finalWorkflow=next。
  // expect 不命中 → 退 3、不写；命中但最终组合非法 → 退 1、不写。此前 cas track 只 requireTrack
  // （不看旧 workflow）、cas workflow 完全无 registry 校验——是 codex R2 点名的两条旁路。
  if (f === 'track' || f === 'workflow') {
    const code = await runComboWrite(deps, dir, owner, (cur) => {
      if (cur.fields[f] !== expect) return { kind: 'cas-miss', patch: fieldPatch(f, next) }
      return {
        kind: 'write',
        finalTrack: f === 'track' ? next : scalarField(cur, 'track'),
        finalWorkflow: f === 'workflow' ? next : scalarField(cur, 'workflow'),
        patch: fieldPatch(f, next),
      }
    })
    if (code === 0) {
      await recordHistory(deps, dir, { ts: deps.clock(), kind: 'set', field: f, from: expect, to: next })
    }
    return code
  }
  // P6：非 track/workflow cas 也锁内 read→判 artifact（命中优先于 CAS miss）→比对 expect→write。
  const code = await runGuardedCas(deps, dir, owner, f, expect, next)
  if (code === 0) {
    await recordHistory(deps, dir, { ts: deps.clock(), kind: 'set', field: f, from: expect, to: next })
  }
  return code
}
