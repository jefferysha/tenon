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
import { assertOwner, FIELD_ORDER, LIST_FIELDS, resolveWorkflowName } from '@tenon/kernel'
import type {
  FieldName, HistoryEntry, PipelineState, RecordActor, TrackRegistry,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { refuseArchived } from '../archivedGuard.js'
import { requireActor } from '../userIdentity.js'
import { effectiveArtifactFields } from './effective-artifacts.js'
import { changeDir, isValidChangeName, readChangeForDisplay } from '../paths.js'
import {
  enumValueAllowed,
  fieldPatch,
  REVIEW_GATE_FIELDS,
  scalarField,
  scalarValue,
  trackWorkflowAllowed,
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

/** runComboWrite 的 compute 结果：CAS 未命中（退 3、不写）或待校验+落盘的最终组合 patch。 */
type ComboPlan =
  | { readonly kind: 'cas-miss'; readonly patch: Partial<Record<FieldName, string | string[]>> }
  | {
      readonly kind: 'write'
      readonly finalTrack: string
      readonly finalWorkflow: string
      readonly patch: Partial<Record<FieldName, string | string[]>>
    }

/**
 * 字段写入的身份/负责人前置。
 *
 * set/set-many/cas 是对 Change 的状态改写，和 document record / review request / transition 一样，
 * 因此走同一条规则：身份必须解析得出，且当前用户必须是负责人。此前这三条命令是唯一不过这道闸的
 * 写入口——换个 TENON_USER、甚至一个解析不出的身份，都能改别人任务的字段（包括 pr_url 这类交付
 * 证据）。校验在 change 锁内对刚读到的 state 做，避免锁外判定与落盘之间负责人被改（TOCTOU）。
 */
interface OwnerCheck {
  readonly change: string
  readonly actor: RecordActor
}

/** 写入口的公共前置：change 名合法 → 未被当前用户归档 → 身份可解析。返回 null = 已拒绝。 */
async function writePreflight(deps: CliDeps, name: string): Promise<OwnerCheck | null> {
  if (!checkName(deps, name)) return null
  if (await refuseArchived(deps, name)) return null
  const actor = requireActor(deps)
  return actor === null ? null : { change: name, actor }
}

/** P6 · artifact 字段被旧写入口拒绝时的统一 stderr 文案（含改用指引）。 */
function artifactRejectMsg(field: FieldName, ctx: PipelineState): string {
  return `ERROR: 字段 '${field}' 是当前 workflow '${resolveWorkflowName(ctx)}' / step '${scalarField(ctx, 'phase')}' / track '${scalarField(ctx, 'track')}' 的 artifact，禁止通过 set/set-many/cas 写入；请改用 tenon artifact register`
}

/**
 * P6 · set/set-many/cas 的 artifact 字段 cutover 判定（锁内调用）：patch 的**全部**字段（含
 * track/workflow——custom workflow 可合法把它们声明为 file_path artifact），若命中「当前上下文」curArt
 * 或「应用本批 patch 后上下文」patchedArt 的有效 artifact 声明集 → 返回拒绝文案，否则 null。两上下文
 * 都查全部字段，堵住 set-many 批内切入（file-artifact：phase=spec plan=x；meta-artifact：workflow=<把
 * track 声明为 artifact 的目标> track=x）/切出（phase=build plan=x）。effectiveArtifactFields 语义：
 * workflow 文件缺失 → 空集（无声明、无 cutover，如 R2 里 workflow 仅作 registry 名）；损坏/step 缺失 →
 * throw，由调用方锁内 try/catch 转 exit 1（fail-closed：坏 workflow 下写任何字段都拒）。
 */
function checkArtifactPatch(
  deps: CliDeps,
  cur: PipelineState,
  patch: Partial<Record<FieldName, string | string[]>>,
): string | null {
  const allFields = Object.keys(patch) as FieldName[]
  if (allFields.length === 0) return null
  // 当前上下文有效 artifact，检查**全部** patch 字段（含 track/workflow——custom workflow 可合法把它们
  // 声明为 file_path artifact；kernel compile：artifact field 严格 ∈ FIELD_ORDER 且非列表）。effectiveArtifact
  // Fields 语义：workflow 文件缺失 → 空集（无声明、无 cutover）；损坏/step 缺失 → throw → 调用方转 exit 1
  // （fail-closed：坏 workflow 下写任何字段都拒）。
  const curArt = effectiveArtifactFields(deps, cur)
  for (const f of allFields) {
    if (curArt.has(f)) return artifactRejectMsg(f, cur)
  }
  // patch 改了 phase/track/workflow → 查「切入后上下文」的**全部**字段（含 meta），堵 set-many 两类切入
  // 旁路：`phase=spec plan=x`（file-artifact 切入）与 `workflow=<把 track 声明为 artifact 的目标> track=x`
  // （meta-artifact 切入，codex 复审阻断 1）。目标 workflow 文件缺失 → 空集（无声明可绕过）；损坏 → throw
  // → exit 1。纯值改（未动 phase/track/workflow）无切入、跳过。
  const switchesContext = allFields.some((f) => f === 'phase' || f === 'track' || f === 'workflow')
  if (switchesContext) {
    const patched: PipelineState = { ...cur, fields: { ...cur.fields, ...patch } }
    const patchedArt = effectiveArtifactFields(deps, patched)
    for (const f of allFields) {
      if (patchedArt.has(f)) return artifactRejectMsg(f, patched)
    }
  }
  return null
}

/**
 * track/workflow 四个写入口的锁内统一执行体（R2 · 关 TOCTOU + 堵旁路）。在同一把 store 锁内
 * 串起「读旧 state → compute 组装最终 {track,workflow} 组合与落盘 patch → checkTrackWorkflow
 * 最终组合 → store.write」。校验与条件写同锁，杜绝「锁外校验、锁内写」之间被并发改另一半、
 * 落盘瞬间组合已非法的旁路（codex R2 点名的 TOCTOU）。
 *
 * 锁不可重入（见 kernel/state/lock.ts 头注）：锁内只用 store.read / store.write 原语，绝不回调
 * store.set/setMany/cas（三者各自 withLock，嵌套即死锁）。store.write→serializePipeline 对全字段
 * 过四闸（quoteGate），故不经 store.setMany/cas 也不丢四闸防线。
 *
 * 返回：0 落盘成功；1 组合非法（未写，错误已由 checkTrackWorkflow 记 stderr）；3 CAS 未命中
 * （未写）。store 读/写异常经 withLock 上抛，本函数统一转 exit 1 + stderr。
 */
async function runComboWrite(
  deps: CliDeps,
  dir: string,
  owner: OwnerCheck,
  compute: (cur: PipelineState) => ComboPlan,
): Promise<number> {
  try {
    // R3 D4：锁序 registry → change。外层持仓级 registry 锁并锁内 fresh-load registry（关跨锁
    // TOCTOU——tracks delete/update 与本组合写竞争时严格串行，扫描期不会读到陈旧 registry），内层
    // 保留 R2 的同一把 change 锁 read→组装最终组合→校验→write（CAS miss 仍退 3）。registry 锁非
    // 重入，故 cb 内只用 store 锁、不再取 registry 锁；用锁内 fresh registry 而非无锁 loadRegistry。
    return await deps.withRegistryLock(async ({ registry }) =>
      deps.store.withLock(dir, async () => {
        const cur = await deps.store.read(dir)
        assertOwner(owner.change, cur.fields, owner.actor)
        const plan = compute(cur)
        // P6：artifact 拒优先于一切（含 CAS miss）。track/workflow 若被 custom workflow 声明为 artifact，
        // 旧入口一律禁用，不能因 expect 不匹配先返 3、泄露「有时还能写」的契约（codex 阻断 1）。cas-miss 与
        // write 两态都带 patch 供判定；纯 track/workflow patch 且当前 workflow 不可加载时 checkArtifactPatch
        // 视空放行（见其实现），交 checkTrackWorkflow 组合校验。
        const artReject = checkArtifactPatch(deps, cur, plan.patch)
        if (artReject !== null) {
          deps.io.err(artReject)
          return 1
        }
        if (plan.kind === 'cas-miss') return 3
        if (!trackWorkflowAllowed(deps, registry, plan.finalTrack, plan.finalWorkflow)) return 1
        await deps.store.writeUnderLock(dir, { ...cur, fields: { ...cur.fields, ...plan.patch } }, {
          kind: Object.keys(plan.patch).length === 1 ? 'set' : 'set-many',
        })
        return 0
      }),
    )
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}

/**
 * P6 · 非 track/workflow 的 set/set-many 锁内执行体：change 锁内 read→artifact 判定→store.write。
 * patch 命中有效 artifact 集 → 整批拒（exit 1，改走 register），不写、不记 history。用 store.write
 * 而非 store.set/setMany（后者各自 withLock，无法与 artifact 判定同锁——设计点名的 TOCTOU）；
 * store.write→serializePipeline 对全字段过四闸，不丢防线。change 缺失/坏 state/触闸经 withLock
 * 上抛，统一转 exit 1。
 */
async function runGuardedWrite(
  deps: CliDeps,
  dir: string,
  owner: OwnerCheck,
  patch: Partial<Record<FieldName, string | string[]>>,
): Promise<number> {
  try {
    return await deps.store.withLock(dir, async () => {
      const cur = await deps.store.read(dir)
      assertOwner(owner.change, cur.fields, owner.actor)
      const artReject = checkArtifactPatch(deps, cur, patch)
      if (artReject !== null) {
        deps.io.err(artReject)
        return 1
      }
      await deps.store.writeUnderLock(dir, { ...cur, fields: { ...cur.fields, ...patch } }, {
        kind: Object.keys(patch).length === 1 ? 'set' : 'set-many',
      })
      return 0
    })
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}

/**
 * P6 · 非 track/workflow cas 锁内执行体：change 锁内 read→artifact 判定→比对 expect→store.write。
 * artifact 命中返 1（优先于 CAS miss 3——旧入口对 artifact 字段已禁用，不能因 expect 不匹配泄露
 * 「这条旧入口有时还能跑」的契约）。非 artifact：expect 不命中退 3、命中写入退 0。比对口径与
 * store.cas 逐字一致（fields[field] !== expect）。
 */
async function runGuardedCas(
  deps: CliDeps,
  dir: string,
  owner: OwnerCheck,
  f: FieldName,
  expect: string,
  next: string,
): Promise<number> {
  try {
    return await deps.store.withLock(dir, async () => {
      const cur = await deps.store.read(dir)
      assertOwner(owner.change, cur.fields, owner.actor)
      const artReject = checkArtifactPatch(deps, cur, fieldPatch(f, next))
      if (artReject !== null) {
        deps.io.err(artReject)
        return 1
      }
      if (cur.fields[f] !== expect) return 3
      await deps.store.writeUnderLock(dir, { ...cur, fields: { ...cur.fields, [f]: next } }, { kind: 'cas' })
      return 0
    })
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
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

function checkName(deps: CliDeps, name: string): boolean {
  if (isValidChangeName(name)) return true
  deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
  return false
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
