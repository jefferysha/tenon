/**
 * artifact register —— 受 artifact 契约约束的单字段写（G2 P5，codex 定稿 D2/D5）。
 *
 *   tenon artifact register <change> <field> <path> --producer <skill-id>
 *
 * 语义上是「受 artifact declaration + producer 校验约束的单字段 set」，但**不**先校验再调
 * deps.store.set：校验依赖当前 phase/track/workflow，锁外校验后再写会被并发推进 phase/改 track/
 * workflow 撕开（TOCTOU）。故复用 store.withLock/read/write 原语，在**同一把 change 锁**内串起
 * 「读 state → 判 declaration/producer → 写 artifact 字段」——与 fields.ts 的组合写同款锁内纪律。
 * 锁不可重入，锁内只用 read/write（绝不回调自带锁的 store.set）。
 *
 * exit：成功静默 0；一切声明/producer/workflow/field/path/I-O 错误 1（不写 state）。不用 2
 * （guard/check 口径）/ 3（CAS 未命中口径）。--producer 缺失是 commander usage error → main 映射 1。
 *
 * producer 是写入授权/evidence 输入，**不**持久化：artifact 字段仍只存 path，history 记普通 set
 * （不把 producer 塞自由串）。审计「究竟哪个 skill 产出」若需要，另立结构化 record（不在本轮暗藏）。
 * 路径语义与旧 file_path 字段一致：非空即可，不要求文件已存在、不 canonicalize、不限制目录。
 *
 * P5 保留 set/set-many/cas 旧写能力（P6 才 cutover）；default 用 P4 codegen 查询层、不用 Track
 * Registry；T-R6 已在生产装配把 default resolver 接到 effective track profile，本命令保持只依赖接口。
 */
import {
  matchesTrackPredicate,
  resolveExplicitProfileSkillSlots,
  resolveStep,
  aliasesForSkill,
  recordFieldSubject,
} from '@tenon/kernel'
import type { EffectiveSkillSlot, FieldName, PipelineState } from '@tenon/kernel'
import { relative, resolve } from 'node:path'
import { refuseArchived } from '../archivedGuard.js'
import { errMsg, type CliDeps } from '../deps.js'
import { recordHistory } from './fields.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { artifactNamespaceForChange } from '@tenon/automation'

/** 拒绝：stderr 记 ERROR + 返回 exit 1（统一口径，state 一律不写）。 */
function reject(deps: CliDeps, msg: string): number {
  deps.io.err(`ERROR: ${msg}`)
  return 1
}

/** 标量字段值（列表按逗号连接；缺键 → 空串）。register 只读 phase/track/workflow 三个标量。 */
function scalar(state: PipelineState, f: FieldName): string {
  const v = state.fields[f]
  return Array.isArray(v) ? v.join(',') : (v ?? '')
}

/** 有效 skill 槽 → 稳定序具体 producer 列表（错误列许可 producer 用；default=manifest 序 / custom=step.skills 序）。 */
function listAllowed(slots: readonly EffectiveSkillSlot[]): string {
  return slots.flatMap((s) => s.alternatives).join(' ')
}

/**
 * register 的锁内核心（读 state → 判 declaration/origin → 取 slots → 校验 producer → 写）。
 * default/custom 两条 declaration 判定路径各自区分「未声明」与「track 不适用」两类拒绝（D5）。
 * 返回 0=已写 / 1=拒绝（含各类校验失败，state 未写）。
 */
async function runRegister(
  deps: CliDeps,
  dir: string,
  field: string,
  path: string,
  producer: string,
): Promise<number> {
  const cur = await deps.store.read(dir)
  const plan = effectiveWorkflowForState(deps, cur)
  const stepId = scalar(cur, 'phase')
  const track = scalar(cur, 'track')
  const f = field as FieldName // 仅当某 declaration 命中该 field 才写；declaration 恒用 FieldName，未命中即拒。

  if (!plan) {
    return reject(deps, `workflow '${String(cur.fields.workflow ?? '')}' 不存在或不可编译`)
  }
  const step = resolveStep(plan.workflow, stepId)
  if (!step) {
    return reject(deps, `step '${stepId}' 不在 workflow '${plan.id}' 里`)
  }
  const decl = step.artifacts.find((artifact) => artifact.field === field)
  if (!decl) return reject(deps, `step '${stepId}' 未声明 artifact '${field}'（workflow '${plan.id}'）`)
  if (decl.requiredWhen && !matchesTrackPredicate(decl.requiredWhen, track)) {
    return reject(deps, `artifact '${field}' 对 track '${track}' 不适用（required_when 排除；step '${stepId}'）`)
  }
  const skillCapability = plan.capabilities.skills
  const expectedPolicy = skillCapability.source === 'manifest-overlay'
    ? 'effective-phase-skills'
    : 'effective-step-skills'
  if (decl.producerPolicy !== expectedPolicy) {
    return reject(
      deps,
      `artifact '${field}' 的 producerPolicy '${decl.producerPolicy}' 与 workflow skill policy '${skillCapability.source}' 不相容（应 ${expectedPolicy}）`,
    )
  }
  // Artifact registration is an explicit named-profile projection. It retains the frozen phase
  // slot even when matrix=false, while never making that profile an automatic Hook/transition
  // requirement; custom workflows resolve to their frozen step declarations only.
  const slots: readonly EffectiveSkillSlot[] = skillCapability.source === 'manifest-overlay'
    ? resolveExplicitProfileSkillSlots(
        deps.resolver,
        skillCapability,
        stepId,
        skillCapability.trackOverlay.profile,
      )
    : resolveExplicitProfileSkillSlots(deps.resolver, skillCapability, stepId, track)

  // 空 effective skill 集必须拒绝（不退化成任意 producer 入口，D5）。
  if (slots.length === 0) {
    return reject(deps, `step '${stepId}'/track '${track}' 的有效 skill 集为空——无合法 producer，拒绝登记`)
  }
  // --producer 必须精确命中某 slot 的某具体 alternative（整个 a|b token 非法）。
  // 等价写法（tenon:/superpowers: 前缀、opsx 别名）视为同一 skill。
  const producerAliases = new Set(aliasesForSkill(producer))
  const matched = slots.some((s) => s.alternatives.some((alternative) => producerAliases.has(alternative) || aliasesForSkill(alternative).includes(producer)))
  if (!matched) {
    return reject(deps, `producer '${producer}' 不在有效 skill 集内（允许: ${listAllowed(slots)}）`)
  }

  // 同锁内写 artifact 字段 + best-effort history（同 set：history 失败仅 WARN、不回滚主写）。
  await deps.store.writeUnderLock(dir, { ...cur, fields: { ...cur.fields, [f]: path } }, { kind: 'set' })
  // Field subject metadata is an optional projection. The canonical field state above is already
  // committed; a missing source path or a sidecar I/O failure must never roll that commit back.
  try {
    await recordFieldSubject({
      changeDir: dir,
      repoRoot: deps.cwd,
      field: f,
      value: path,
      sourcePath: path,
      logicalKey: `field:${f}`,
      namespace: artifactNamespaceForChange(dir),
      producer,
      recordedAt: deps.clock(),
    })
  } catch (error) {
    deps.io.err(`WARN: field subject projection 写入失败: ${errMsg(error)}`)
  }
  await recordHistory(deps, dir, { ts: deps.clock(), kind: 'set', field: f, to: path })
  return 0
}

export async function cmdArtifactRegister(
  deps: CliDeps,
  name: string,
  field: string,
  path: string,
  producer: string,
): Promise<number> {
  if (!isValidChangeName(name)) {
    return reject(deps, `change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
  }
  if (await refuseArchived(deps, name)) return 1
  // path 非空（D2：保持旧 file_path 值语义，不额外要求存在/canonicalize）。
  if (path === '') {
    return reject(deps, 'artifact path 不得为空')
  }
  // producer 具体 skill id 前置形态校验：非空、非整段 a|b 备选 token（备选拆分后无 alternative 含 `|`，
  // 且 validateWorkflow 的 SKILL_IDENT_RE 不许 custom id 含 `|`，故含 `|` 的 producer 恒非具体 id）。
  if (producer === '') {
    return reject(deps, '--producer 不得为空')
  }
  if (producer.includes('|')) {
    return reject(deps, `--producer '${producer}' 是 a|b 备选 token、不是具体 skill id——请传其中某一个具体 branch`)
  }
  const dir = changeDir(deps.cwd, name)
  try {
    const result = await deps.store.withLock(dir, () => runRegister(deps, dir, field, path, producer))
    if (result === 0 && deps.artifactSubmission) {
      try {
        const submission = await deps.artifactSubmission({ changeDir: dir })
        const submissionPath = relative(dir, resolve(deps.cwd, path))
        const receipt = await submission.submit({
          projection: 'field',
          logicalKey: `field:${field}`,
          path: submissionPath,
          field,
          value: path,
          producer,
        })
        if (receipt.status !== 'committed') deps.io.err(`WARN: unified field submission 未提交: ${receipt.diagnostics?.join('; ') ?? 'unknown error'}`)
      } catch (error) {
        deps.io.err(`WARN: unified field submission 初始化失败: ${errMsg(error)}`)
      }
    }
    return result
  } catch (e) {
    // change 缺失/坏 state/I-O 异常经 withLock 上抛 → 统一 exit 1（state 未写）。
    return reject(deps, errMsg(e))
  }
}
