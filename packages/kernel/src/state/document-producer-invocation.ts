import { currentDocumentSkillConfirmation } from '../skill-invocation/document-confirmation.js'
import { DocumentLedgerError } from './document-path.js'
export { currentDocumentStepVisitId } from './document-step-visit.js'
import { parseDocumentProducerInvocation as parseAnchor } from './document-producer-invocation-model.js'
export type { DocumentProducerInvocationAnchor } from './document-producer-invocation-model.js'
import type { DocumentProducerInvocationAnchor } from './document-producer-invocation-model.js'

export function parseDocumentProducerInvocation(
  value: unknown,
  recordIndex: number,
): DocumentProducerInvocationAnchor | undefined {
  return parseAnchor(value, recordIndex, (message) => new DocumentLedgerError(message))
}

export async function currentDocumentProducerInvocation(
  changeDir: string,
  producer: string,
  phase: string,
  recordedAt: string,
): Promise<DocumentProducerInvocationAnchor | undefined> {
  const confirmation = await currentDocumentSkillConfirmation(changeDir, producer, phase, recordedAt)
  return confirmation === undefined ? undefined : {
    confirmationInvocationId: confirmation.invocation_id,
    evidenceScope: confirmation.evidence_scope,
    stepVisit: {
      runId: confirmation.step_visit.run_id,
      transitionSequence: confirmation.step_visit.transition_sequence,
    },
  }
}

export async function requiredDocumentProducerInvocation(
  changeDir: string,
  producer: string,
  phase: string,
  recordedAt: string,
  allowBackfill: boolean,
): Promise<DocumentProducerInvocationAnchor | undefined> {
  const invocation = await currentDocumentProducerInvocation(changeDir, producer, phase, recordedAt)
  if (invocation === undefined && !allowBackfill) throw new DocumentLedgerError(
    `current StepVisit lacks exact host confirmation for document producer '${producer}'`
    + '；在当前阶段重新调用该技能后重试登记（Claude Code 用 Skill 工具；Codex 用单独一条 cat 读取其 SKILL.md，max_output_tokens 要足够大，输出被截断不算读取）',
  )
  return invocation
}
