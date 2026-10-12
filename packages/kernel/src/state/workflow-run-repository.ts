/**
 * WorkflowRunRepository —— W1 第二增量的原子提交边界。
 *
 * transact() 持锁的范围覆盖整个 callback（不只是 commit() 那一刻）：调用方（CLI/server 的
 * default/custom 规划分支）在同一把锁内完成"读 run → 决定下一状态 → commit() 落盘 →
 * 收尾 history/breadcrumb/marker 兼容投影"全过程，锁到 callback 返回才释放。这直接堵死了
 * G1 REFACTOR 一路遗留到现在的并发撕裂——此前 breadcrumb/history/marker 在锁外写，两次
 * 并发 transition 可能交错完成、旧尾覆盖新状态；现在整条链路在同一把锁内，天然串行。
 *
 * 提交模型：不可变记录 + canonical revision/current 指针。
 *   1. 锁内读 state（含 runMetadata）；老 change 缺身份则在本次锁内生成（不用 change 名/
 *      路径/时间戳冒充稳定 ID）。
 *   2. commit() 时：先原子写不可变 TransitionRecord（此刻它是未被引用的孤儿，current rename 前
 *      崩溃 = 不可达 = 未提交，见 transition-record-store.ts）。
 *   3. canonical revision 绑定 record id + 精确字节 digest，再把新 fields + 推进的 runMetadata
 *      一起原子 rename 为 `.pipeline-run/current.json`——这是唯一提交点；YAML 只在其后投影。
 * "原子"的范围是现有文件系统口径下的进程崩溃原子可见性，不承诺断电后的 fsync durability。
 *
 * CLI/server 的转换编排已统一到 TransitionApplication；`.pipeline.yaml` 已降为兼容 adapter。
 */
import { randomUUID } from 'node:crypto'
import type {
  DocumentProfileId,
  FieldName,
  InitOptions,
  PipelineState,
  RunMetadata,
  StateStore,
} from '../types.js'
import { validateAutomationPolicySnapshot, type AutomationPolicySnapshot } from '../loops/automation-policy.js'
import { resolveWorkflowName } from '../workflow/engine.js'
import type {
  TransitionDraft, WorkflowRun, WorkflowRunRepository, WorkflowRunTransaction,
} from '../workflow/run-types.js'
import type { WorkflowActionAuthoritySnapshotV1 } from '../workflow/action-authority-types.js'
import { diffWireFieldsToEffects } from './run-metadata.js'
import type { TransitionRecordStore } from './transition-record-store.js'
import { defaultOpenSpecScaffoldFiles } from './default-openspec-scaffold.js'
import { DOCUMENT_LEDGER_FILE, initialDocumentLedgerContent } from './document-ledger.js'
import { required } from '../required.js'
import { ensureWorkflowGovernanceBinding } from './workflow-governance-binding.js'
import {
  ensureWorkflowActionAuthorityRecord,
  readWorkflowActionAuthorityRecord,
} from './workflow-action-authority-record.js'
import {
  documentGovernanceFingerprint as fingerprintOfDocumentPolicy,
  effectiveWorkflowPlanFromSnapshot,
  resolveEffectiveWorkflowPlan,
  workflowPlanSnapshot,
} from '../workflow/effective-plan.js'
import type { DocumentGovernancePolicy } from '../workflow/document-contract.js'
import { fieldStr } from '../workflow/transition-field-scalar.js'

const documentPolicyFingerprint = (policy: DocumentGovernancePolicy | undefined): string | undefined =>
  policy === undefined ? undefined : fingerprintOfDocumentPolicy(policy)

export interface WorkflowRunRepositoryDeps {
  store: StateStore
  recordStore: TransitionRecordStore
  clock: () => string
  /** 稳定 ID 生成器（run 身份 / record 身份共用）；缺省 crypto.randomUUID，测试可注入确定性序列。 */
  newId?: () => string
}

function deriveRun(
  fields: Record<FieldName, string | string[]>,
  metadata: RunMetadata,
  workflowActionAuthority?: WorkflowActionAuthoritySnapshotV1,
): WorkflowRun {
  const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(',') : (v ?? ''))
  return {
    id: metadata.runId,
    workflowId: resolveWorkflowName({ fields, opaqueTail: '' }),
    currentStep: str(fields.phase),
    lifecycle: str(fields.archived) === 'true' ? 'archived' : 'active',
    transitionSequence: metadata.transitionSequence,
    transitionHead: metadata.transitionHead,
    documentProfile: metadata.documentProfile,
    documentGovernanceFingerprint: metadata.documentGovernanceFingerprint,
    workflowPlanFingerprint: metadata.workflowPlanFingerprint,
    workflowPlanSnapshot: metadata.workflowPlanSnapshot,
    createdAt: str(fields.created_at),
    updatedAt: str(fields.updated_at),
    automationPolicy: metadata.automationPolicy,
    policyId: metadata.automationPolicy?.policy_id,
    policyVersion: metadata.automationPolicy?.policy_version,
    loopId: metadata.loopId,
    iterationId: metadata.iterationId,
    workflowActionAuthority,
  }
}

async function authorityForCurrentIteration(
  changeDir: string,
  metadata: RunMetadata,
): Promise<WorkflowActionAuthoritySnapshotV1 | undefined> {
  if (metadata.iterationId === undefined) return undefined
  return readWorkflowActionAuthorityRecord(changeDir, metadata.iterationId)
}

class FsWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly deps: WorkflowRunRepositoryDeps) {}

  async initChange(opts: InitOptions): Promise<{ changeDir: string; run: WorkflowRun }> {
    const newId = this.deps.newId ?? randomUUID
    // Trusted adapters such as triage derive an idempotent run id from a canonical request. They
    // still use this single creation boundary; ordinary CLI/server callers omit it and get UUID.
    const runId = opts.runId ?? newId()
    const workflowId = opts.initialWorkflow?.workflow ?? 'default'
    // 计划按任务自己的轨道算：调用方冻结的快照优先（它已按同一轨道编译），没有快照才取包内定义。
    const frozen = opts.initialWorkflow?.workflowPlanSnapshot
    const packaged = frozen === undefined ? resolveEffectiveWorkflowPlan(workflowId, () => null, { track: opts.track }) : null
    const snapshot = frozen ?? (packaged === null ? undefined : workflowPlanSnapshot(packaged))
    const plan = snapshot === undefined ? null : effectiveWorkflowPlanFromSnapshot(snapshot, opts.track)
    if (plan !== null) {
      const boundFingerprint = opts.initialWorkflow?.workflowPlanFingerprint
      if (plan.id !== workflowId
        || (boundFingerprint !== undefined && plan.workflowFingerprint !== boundFingerprint)) {
        throw new Error('init workflow plan snapshot 与 workflow identity/fingerprint 不一致')
      }
    }
    const usesOpenSpecScaffold = plan?.capabilities.documents.profile === 'legacy-full'
    const governed = (
      usesOpenSpecScaffold
      || opts.initialWorkflow?.documentProfile !== undefined
      || opts.initialWorkflow?.openspecContract === true
      || opts.initialWorkflow?.documentContract === true
    )
    const initialFiles = [
      ...(opts.initialFiles ?? []),
      ...(usesOpenSpecScaffold
        ? defaultOpenSpecScaffoldFiles(
          opts.name,
          opts.documentLocale ?? 'zh-CN',
          plan.workflow.steps.map((step) => ({ id: step.id, label: step.label })),
          plan.projection.stepLabelSource,
        )
        : []),
      ...(governed
        ? [{
          relativePath: DOCUMENT_LEDGER_FILE,
          content: initialDocumentLedgerContent(this.deps.clock()),
        }]
        : []),
    ]
    // State, immutable run identity, locale/governance sidecars, ledger, and default OpenSpec files
    // are prepared in one private candidate, then published no-replace with canonical current last.
    const changeDir = await this.deps.store.init({
      ...opts,
      runId,
      initialFiles,
      ...(snapshot === undefined
        ? {}
        : {
          initialWorkflow: {
            ...(opts.initialWorkflow ?? {
              workflow: workflowId,
              phase: plan?.workflow.steps[0]?.id ?? 'open',
            }),
            workflowPlanFingerprint: opts.initialWorkflow?.workflowPlanFingerprint
              ?? snapshot.workflowFingerprint,
            workflowPlanSnapshot: snapshot,
          },
        }),
    })
    const state = await this.deps.store.read(changeDir)
    // state.runMetadata 在这里必然存在（刚用 runId 创建的），非空断言有 store.init 的实现保证。
    return { changeDir, run: deriveRun(state.fields, required(state.runMetadata)) }
  }

  async establishRun(
    changeDir: string,
    governance: {
      readonly openspecContract?: boolean
      readonly documentContract?: boolean
      readonly documentProfile?: DocumentProfileId
      readonly documentGovernanceFingerprint?: string
      readonly workflowPlanFingerprint?: string
    } = {},
  ): Promise<WorkflowRun> {
    const { store } = this.deps
    const newId = this.deps.newId ?? randomUUID
    return store.withLock(changeDir, async () => {
      const state = await store.read(changeDir)
      const workflowId = resolveWorkflowName(state)
      // 没有显式绑定时按任务自己的轨道取包内定义的计划（有分支的工作流里没有该轨道 → 抛错，不取第一条）。
      let packaged: ReturnType<typeof resolveEffectiveWorkflowPlan> | undefined
      const packagedPlan = (): ReturnType<typeof resolveEffectiveWorkflowPlan> => {
        packaged ??= resolveEffectiveWorkflowPlan(workflowId, () => null, { track: fieldStr(state.fields.track) })
        return packaged
      }
      const documentProfile = governance.documentProfile
        ?? (governance.openspecContract === true
          ? 'legacy-full'
          : governance.documentContract === true
            ? 'document-v1'
            : undefined)
      // 已有 run 记着自己冻结的指纹（可能是升级前的旧引擎计划）：调用方没点名时沿用，不拿今天的包内计划去比。
      // 包内计划只给还没有指纹的 run 补缺。
      const existingRun = state.runMetadata
      const documentGovernanceFingerprint = governance.documentGovernanceFingerprint
        ?? existingRun?.documentGovernanceFingerprint
        ?? (documentProfile === 'legacy-full' ? documentPolicyFingerprint(packagedPlan()?.documentPolicy) : undefined)
      const workflowPlanFingerprint = governance.workflowPlanFingerprint
        ?? existingRun?.workflowPlanFingerprint
        ?? packagedPlan()?.workflowFingerprint
      if (state.runMetadata) {
        const existing = state.runMetadata
        const asserted = [
          ['documentProfile', documentProfile],
          ['documentGovernanceFingerprint', documentGovernanceFingerprint],
          ['workflowPlanFingerprint', workflowPlanFingerprint],
        ] as const
        for (const [field, expected] of asserted) {
          const observed = existing[field]
          if (observed !== undefined && expected !== undefined && observed !== expected) {
            throw new Error(
              `establishRun 拒绝覆盖已有 ${field}：observed='${observed}' expected='${expected}'`,
            )
          }
        }
        const metadata: RunMetadata = {
          ...existing,
          ...(existing.documentProfile === undefined && documentProfile !== undefined
            ? { documentProfile }
            : {}),
          ...(existing.documentGovernanceFingerprint === undefined
            && documentGovernanceFingerprint !== undefined
            ? { documentGovernanceFingerprint }
            : {}),
          ...(existing.workflowPlanFingerprint === undefined && workflowPlanFingerprint !== undefined
            ? { workflowPlanFingerprint }
            : {}),
        }
        if (
          metadata.documentProfile !== existing.documentProfile
          || metadata.documentGovernanceFingerprint !== existing.documentGovernanceFingerprint
          || metadata.workflowPlanFingerprint !== existing.workflowPlanFingerprint
        ) {
          await ensureWorkflowGovernanceBinding(changeDir, metadata)
        } else if (
          metadata.documentProfile !== undefined
          || metadata.documentGovernanceFingerprint !== undefined
          || metadata.workflowPlanFingerprint !== undefined
        ) {
          // Migrate older canonical revisions lazily without rewriting immutable history. The next
          // real state commit drops these fields from canonical runMetadata; this sidecar already
          // preserves the effective governance identity for the current release.
          await ensureWorkflowGovernanceBinding(changeDir, metadata)
        }
        return deriveRun(state.fields, metadata, await authorityForCurrentIteration(changeDir, metadata))
      }
      const metadata: RunMetadata = {
        runId: newId(),
        transitionSequence: 0,
        transitionHead: undefined,
        ...(documentProfile === undefined ? {} : { documentProfile }),
        ...(documentGovernanceFingerprint === undefined ? {} : { documentGovernanceFingerprint }),
        ...(workflowPlanFingerprint === undefined ? {} : { workflowPlanFingerprint }),
      }
      if (
        metadata.documentProfile !== undefined
        || metadata.documentGovernanceFingerprint !== undefined
        || metadata.workflowPlanFingerprint !== undefined
      ) {
        await ensureWorkflowGovernanceBinding(changeDir, metadata)
      }
      await store.writeUnderLock(changeDir, { ...state, runMetadata: metadata })
      return deriveRun(state.fields, metadata, await authorityForCurrentIteration(changeDir, metadata))
    })
  }

  async bindAutomationPolicy(
    changeDir: string,
    policy: AutomationPolicySnapshot,
    binding?: { readonly loopId: string; readonly iterationId: string },
  ): Promise<WorkflowRun> {
    const { store } = this.deps
    const newId = this.deps.newId ?? randomUUID
    return store.withLock(changeDir, async () => {
      const state = await store.read(changeDir)
      const metadata: RunMetadata = state.runMetadata
        ? structuredClone(state.runMetadata)
        : { runId: newId(), transitionSequence: 0, transitionHead: undefined }
      const existing = metadata.automationPolicy
      if (existing !== undefined && existing.policy_version !== policy.policy_version) {
        throw new Error(
          `WorkflowRun policy is immutable: ${existing.policy_version} != ${policy.policy_version}`,
        )
      }
      // 同一 content version 的 policy 快照不可被后一次 admission 覆盖；iteration current pointer
      // 可前进。captured_at 不参与版本摘要，因此仍保留首次 policy 快照的精确时间。即使版本字符串
      // 相同，也先重算入参摘要，防止伪造内容借重放分支被调用方误认为已绑定。
      const canonicalPolicy = validateAutomationPolicySnapshot(policy)
      if (binding !== undefined) {
        if (binding.loopId !== canonicalPolicy.loop_id || binding.iterationId.length === 0) {
          throw new Error('WorkflowRun governed binding does not match policy loop or has empty iteration')
        }
        if (metadata.loopId !== undefined && metadata.loopId !== binding.loopId) {
          throw new Error('WorkflowRun loop binding is immutable')
        }
        // A WorkflowRun may be retried in a later loop iteration. The current pointer advances here;
        // immutable TransitionRecords snapshot the iteration used by each historical commit.
        metadata.loopId = binding.loopId
        metadata.iterationId = binding.iterationId
      }
      if (existing === undefined) metadata.automationPolicy = canonicalPolicy
      if (existing !== undefined && binding === undefined) {
        return deriveRun(state.fields, metadata, await authorityForCurrentIteration(changeDir, metadata))
      }
      if (existing !== undefined && binding !== undefined
        && state.runMetadata?.loopId === binding.loopId
        && state.runMetadata.iterationId === binding.iterationId) {
        return deriveRun(state.fields, metadata, await authorityForCurrentIteration(changeDir, metadata))
      }
      await store.writeUnderLock(changeDir, { ...state, runMetadata: metadata })
      return deriveRun(state.fields, metadata, await authorityForCurrentIteration(changeDir, metadata))
    })
  }

  async bindWorkflowActionAuthority(
    changeDir: string,
    snapshot: WorkflowActionAuthoritySnapshotV1,
  ): Promise<WorkflowRun> {
    const { store } = this.deps
    return store.withLock(changeDir, async () => {
      const state = await store.read(changeDir)
      const metadata = required(state.runMetadata)
      const workflowId = resolveWorkflowName(state)
      const track = state.fields.track
      const trackId = Array.isArray(track) ? track.join(',') : (track ?? '')
      if (snapshot.workflow_run_id !== metadata.runId
        || snapshot.workflow_id !== workflowId
        || snapshot.workflow_fingerprint !== metadata.workflowPlanFingerprint
        || snapshot.loop_id !== metadata.loopId
        || snapshot.iteration_id !== metadata.iterationId
        || snapshot.skill_bundle_id !== metadata.automationPolicy?.skill_bundle_id
        || snapshot.track_id !== trackId) {
        throw new Error('Workflow action authority snapshot does not match canonical WorkflowRun identity')
      }
      const bound = await ensureWorkflowActionAuthorityRecord(changeDir, snapshot)
      return deriveRun(state.fields, metadata, bound)
    })
  }

  async transact<T>(changeDir: string, fn: (tx: WorkflowRunTransaction) => Promise<T>): Promise<T> {
    const { store, recordStore, clock } = this.deps
    const newId = this.deps.newId ?? randomUUID
    return store.withLock(changeDir, async () => {
      const state = await store.read(changeDir)
      // beforeFields 独立于暴露给调用方的 tx.state.fields——即便调用方原地修改 tx.state.fields，
      // commit() 用来 diff 的"改动前"快照也不会被污染。metadata 同理独立于 tx.state.runMetadata
      // ——第二轮 codex review 抓到：早期实现里两者是同一个对象引用（state.runMetadata 只被
      // structuredClone 进 tx.state 一次，内部 metadata 变量却直接拿 state.runMetadata 本体），
      // 调用方一句 tx.state.runMetadata.transitionSequence = 99 就能把 commit() 算出的 sequence/
      // previousRecordId 全部污染。这里对 fields 与 runMetadata 分别做两次独立 structuredClone
      // （不是"clone 一次、共享"），确保内部快照与暴露给调用方的视图之间没有任何共享引用。
      const beforeFields = structuredClone(state.fields)
      const metadata: RunMetadata = state.runMetadata
        ? structuredClone(state.runMetadata)
        : { runId: newId(), transitionSequence: 0, transitionHead: undefined }
      const authority = await authorityForCurrentIteration(changeDir, metadata)
      const run = deriveRun(state.fields, metadata, authority)
      let committed = false

      const tx: WorkflowRunTransaction = {
        run,
        state: {
          ...state,
          fields: structuredClone(state.fields),
          runMetadata: state.runMetadata ? structuredClone(state.runMetadata) : undefined,
        },
        commit: async (nextFields, draft: TransitionDraft) => {
          if (committed) {
            throw new Error('WorkflowRunTransaction.commit: 一次 transaction 只能提交一次（重复调用是调用方 bug）')
          }
          committed = true
          const sequence = metadata.transitionSequence + 1
          const recordId = newId()
          const observedAt = clock()
          const record = {
            schemaVersion: 1 as const,
            id: recordId,
            runId: metadata.runId,
            policyId: metadata.automationPolicy?.policy_id,
            policyVersion: metadata.automationPolicy?.policy_version,
            loopId: metadata.loopId,
            iterationId: metadata.iterationId,
            sequence,
            previousRecordId: metadata.transitionHead,
            workflowId: run.workflowId,
            event: draft.event,
            from: draft.from,
            to: draft.to,
            effects: diffWireFieldsToEffects(beforeFields, nextFields),
            actor: draft.actor,
            observedAt,
          }
          // ① 先原子写不可变记录（此刻是孤儿，未被任何 head 引用）
          await recordStore.write(changeDir, record)
          // ② 再一次 rename 同时提交新 fields 与推进的 run 元数据——真正的提交点。opaqueTail
          // 恒复用本次 transact 读到的原值，runMetadata 恒由这里推进——调用方在类型上就没有
          // 机会传入这两者（commit() 只收 nextFields，见 run-types.ts 注释）。
          const newMetadata: RunMetadata = {
            runId: metadata.runId,
            transitionSequence: sequence,
            transitionHead: recordId,
            documentProfile: metadata.documentProfile,
            documentGovernanceFingerprint: metadata.documentGovernanceFingerprint,
            workflowPlanFingerprint: metadata.workflowPlanFingerprint,
            workflowPlanSnapshot: metadata.workflowPlanSnapshot,
            automationPolicy: metadata.automationPolicy,
            loopId: metadata.loopId,
            iterationId: metadata.iterationId,
          }
          const committedState: PipelineState = { fields: nextFields, runMetadata: newMetadata, opaqueTail: state.opaqueTail }
          const writeResult = await store.writeUnderLock(changeDir, committedState, {
            kind: 'transition',
            transitionRecordId: recordId,
          })
          const newRun = deriveRun(nextFields, newMetadata, authority)
          return { run: newRun, record, projection: writeResult.projection }
        },
      }
      return fn(tx)
    })
  }
}

export function createWorkflowRunRepository(deps: WorkflowRunRepositoryDeps): WorkflowRunRepository {
  return new FsWorkflowRunRepository(deps)
}
