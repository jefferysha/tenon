/**
 * 必需技能与它本步产物的绑定：契约点名它为 producer 的文档，必须在**本次步骤访问**里由它登记过，
 * 这个技能才算做完。只有一次调用回执（第三轮真机验收里五条空 PostToolUse 就把五个技能刷成
 * done）不再够。
 *
 * 「本次步骤访问」取登记时锚定的 producer invocation（runId + transitionSequence），与当前
 * WorkflowRun 的 visit 逐字比对：上一次访问（verify-fail 回 build 再回 verify）留下的记录不算，
 * backfill 与旧台账没有锚点，也不算。
 */
import {
  documentKindsProducedBySkillAtPolicyStep,
  type DocumentGovernancePolicy,
  type DocumentKind,
} from '../workflow/document-contract.js'
import type { EffectiveSkillSlot } from '../workflow/effective-skill-resolver.js'
import { readDocumentLedger, type DocumentRecord } from './document-ledger.js'
import { skillsEquivalent } from './document-record-policy.js'
import { readCurrentRunRevision } from './run-revision-store.js'

/**
 * 当前步骤访问里登记的文档记录。
 *
 * 台账或 run identity 读不出来时返回空表：技能门因此保持未完成（fail closed），而读失败本身由
 * 文档取证（evaluateDocumentEvidence）作为出口 blocker 如实报出，这里不重复、也不让 status 崩掉。
 */
export async function documentRecordsInCurrentStepVisit(changeDir: string): Promise<readonly DocumentRecord[]> {
  let ledger
  let metadata
  try {
    ledger = await readDocumentLedger(changeDir)
    metadata = (await readCurrentRunRevision(changeDir))?.state.runMetadata
  } catch {
    return []
  }
  if (ledger === undefined || metadata === undefined) return []
  return ledger.records.filter((record) => {
    const visit = record.producerInvocation?.stepVisit
    return visit !== undefined
      && visit.runId === metadata.runId
      && visit.transitionSequence === metadata.transitionSequence
  })
}

/** 该技能在本步还欠的文档：契约绑定给它、本次访问里还没有一条由它（按别名等价）登记的 kind。 */
export function pendingSkillDocumentKinds(
  policy: DocumentGovernancePolicy | undefined,
  stepId: string,
  skill: string,
  visitRecords: readonly DocumentRecord[],
): readonly DocumentKind[] {
  if (policy === undefined) return []
  return documentKindsProducedBySkillAtPolicyStep(policy, stepId, skill).filter((kind) =>
    !visitRecords.some((record) => record.kind === kind && skillsEquivalent(record.producer, skill)))
}

/** Pipeline 自有技能在宿主里以 `tenon:<id>` 出现；workflow 数据用裸 id。 */
function canonicalSkillId(skillId: string): string {
  return skillId.startsWith('tenon:') ? skillId.slice('tenon:'.length) : skillId
}

export interface StepSkillSlotProgress {
  /** manifest/step 里逐字的 token（`a|b` 保持原样）。 */
  readonly token: string
  /** 本次步骤访问里已调用了某个备选。 */
  readonly invoked: boolean
  /**
   * 契约绑定给它、本次访问里还没由它登记的文档 kind。已调用时是它还欠的；未调用时是调用之后
   * 还要交的（首个备选的绑定）。空 = 本步不产出文档，或已全部登记。
   */
  readonly pendingDocuments: readonly DocumentKind[]
  readonly done: boolean
}

/**
 * 每个必需技能槽的完成度——CLI（check / transition / status）与 Dashboard transition 共用这一份。
 * 一个备选「已调用、且它在本步的产物都已在本次访问由它登记」即完成；本步没有绑定产物的备选，
 * 调用即完成（没有可以绑定的产物）。
 */
export function judgeStepSkillSlots(input: {
  readonly slots: readonly EffectiveSkillSlot[]
  readonly completed: ReadonlySet<string>
  readonly policy: DocumentGovernancePolicy | undefined
  readonly stepId: string
  readonly visitRecords: readonly DocumentRecord[]
}): readonly StepSkillSlotProgress[] {
  const { policy, stepId, visitRecords } = input
  const completed = new Set([...input.completed].map(canonicalSkillId))
  return input.slots.map((slot) => {
    const invoked = slot.alternatives
      .map(canonicalSkillId)
      .filter((id) => completed.has(id))
      .map((id) => pendingSkillDocumentKinds(policy, stepId, id, visitRecords))
    const done = invoked.some((pending) => pending.length === 0)
    const closest = [...invoked].sort((left, right) => left.length - right.length)[0]
    const first = slot.alternatives[0]
    const pendingDocuments = done
      ? []
      : closest
        ?? (first === undefined || policy === undefined
          ? []
          : documentKindsProducedBySkillAtPolicyStep(policy, stepId, canonicalSkillId(first)))
    return { token: slot.token, invoked: invoked.length > 0, pendingDocuments, done }
  })
}

/**
 * 未完成槽的逐条文案：token 打头，绑定了文档的点名那些文档——「调用了还差什么」必须说得出口，
 * 否则执行者只会再调用一次同一个技能。
 */
export function missingStepSkillMessages(slots: readonly StepSkillSlotProgress[]): readonly string[] {
  return slots.filter((slot) => !slot.done).map((slot) => {
    const kinds = slot.pendingDocuments.join(', ')
    if (kinds === '') return slot.token
    return slot.invoked
      ? `${slot.token}（已调用，本次步骤访问尚未登记它产出的 document：${kinds}）`
      : `${slot.token}（调用后还须在本步登记它产出的 document：${kinds}）`
  })
}
