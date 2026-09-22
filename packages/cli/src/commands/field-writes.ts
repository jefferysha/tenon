/**
 * set / set-many / cas 的写入闸与锁内执行体。
 *
 * 命令壳（fields.ts）只负责解析参数与挑执行体；这里放三件真正决定「能不能写」的事：
 *   · 身份与负责人前置（与 document record / review request / transition 同一条规则）；
 *   · artifact 字段 cutover（声明过的字段只能走 tenon artifact register）；
 *   · change 锁内的 read → 判定 → 条件写，校验与落盘同锁（关 TOCTOU）。
 */
import { assertOwner, resolveWorkflowName } from '@tenon/kernel'
import type { FieldName, PipelineState, RecordActor } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { refuseArchived, refuseFinished } from '../archivedGuard.js'
import { requireActor } from '../userIdentity.js'
import { effectiveArtifactFields } from './effective-artifacts.js'
import { isValidChangeName } from '../paths.js'
import { fieldPatch, scalarField, trackWorkflowAllowed } from './field-values.js'


export function checkName(deps: CliDeps, name: string): boolean {
  if (isValidChangeName(name)) return true
  deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
  return false
}


/** runComboWrite 的 compute 结果：CAS 未命中（退 3、不写）或待校验+落盘的最终组合 patch。 */
export type ComboPlan =
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
export interface OwnerCheck {
  readonly change: string
  readonly actor: RecordActor
}

/** 写入口的公共前置：change 名合法 → 未被当前用户归档 → 身份可解析。返回 null = 已拒绝。 */
export async function writePreflight(deps: CliDeps, name: string): Promise<OwnerCheck | null> {
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
export async function runComboWrite(
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
        if (refuseFinished(deps, owner.change, cur.fields)) return 1
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
export async function runGuardedWrite(
  deps: CliDeps,
  dir: string,
  owner: OwnerCheck,
  patch: Partial<Record<FieldName, string | string[]>>,
): Promise<number> {
  try {
    return await deps.store.withLock(dir, async () => {
      const cur = await deps.store.read(dir)
      assertOwner(owner.change, cur.fields, owner.actor)
      if (refuseFinished(deps, owner.change, cur.fields)) return 1
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
export async function runGuardedCas(
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
      // 完结拒写优先于 CAS 比对：expect 不匹配先返 3 会让人以为「换个 expect 就还能写」。
      if (refuseFinished(deps, owner.change, cur.fields)) return 1
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
