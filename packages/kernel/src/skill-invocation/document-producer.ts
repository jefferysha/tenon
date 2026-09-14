import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readDocumentLedger, type DocumentRecord } from '../state/document-ledger.js'
import { readCurrentRunRevision } from '../state/run-revision-store.js'
import type { DocumentKind } from '../workflow/document-contract.js'
import {
  appendSkillInvocationEvent,
  appendSkillInvocationEventUnderLock,
  readSkillInvocationEventsForApplication,
  skillInvocationProjectId,
} from './repository.js'
import type { SkillInvocationChangeLock } from './repository.js'
import type { SkillInvocationEventV1, SkillInvocationSubjectV1 } from './types.js'
import {
  currentDocumentSkillConfirmation,
  type DocumentSkillConfirmationV1,
} from './document-confirmation.js'

function digest(...values: readonly string[]): string {
  const hash = createHash('sha256')
  for (const value of values) hash.update(value).update('\0')
  return hash.digest('hex')
}

async function canonicalSubject(changeDir: string): Promise<SkillInvocationSubjectV1> {
  const revision = await readCurrentRunRevision(changeDir)
  const metadata = revision?.state.runMetadata
  const workflow = revision?.state.fields.workflow
  const phase = revision?.state.fields.phase
  if (metadata === undefined || typeof workflow !== 'string' || typeof phase !== 'string') {
    throw new Error('canonical WorkflowRun StepVisit identity is missing')
  }
  return {
    project_id: await skillInvocationProjectId(join(changeDir, '..', '..', '..')),
    workflow_definition_id: workflow,
    workflow_run_id: metadata.runId,
    step_id: phase,
    step_visit: { run_id: metadata.runId, transition_sequence: metadata.transitionSequence },
  }
}

async function matchingConfirmation(
  changeDir: string,
  subject: SkillInvocationSubjectV1,
  record: DocumentRecord,
): Promise<DocumentSkillConfirmationV1 | undefined> {
  const confirmation = await currentDocumentSkillConfirmation(
    changeDir, record.producer, subject.step_id, record.recordedAt,
  )
  return confirmation?.step_visit.run_id === subject.step_visit.run_id
    && confirmation.step_visit.transition_sequence === subject.step_visit.transition_sequence
    ? confirmation
    : undefined
}

// The document gate accepts a binding only for this exact row, recording time included. Matching on
// path + digest alone treated a second `document record` of unchanged bytes as already bound while
// the ledger row carried the new `recordedAt`, leaving the gate blocked.
function intentMatchesRecord(
  event: Extract<SkillInvocationEventV1, { type: 'artifact-binding-intent' }>,
  record: DocumentRecord,
): boolean {
  return event.payload.artifact.ref === record.path
    && event.payload.artifact.digest === `sha256:${record.sha256}`
    && event.payload.artifact.document?.kind === record.kind
    && event.payload.artifact.document.recorded_at === record.recordedAt
}

/**
 * Records the one canonical document output that has a current-phase transcript confirmation.
 * Producer, time, path, digest, subject, validators and adapter proof are all derived in-kernel.
 */
export async function recordCanonicalDocumentSkillInvocation(
  changeDir: string,
  kind: DocumentKind,
  recordedAt: string,
  options: {
    readonly lock?: SkillInvocationChangeLock
    readonly record?: Pick<DocumentRecord, 'path' | 'sha256'>
  } = {},
): Promise<{ readonly invocation_id: string } | undefined> {
  const lock = options.lock
  const appendEvent = lock === undefined
    ? appendSkillInvocationEvent
    : (dir: string, event: SkillInvocationEventV1, appendOptions: Parameters<typeof appendSkillInvocationEvent>[2]) =>
        appendSkillInvocationEventUnderLock(dir, lock, event, appendOptions)
  const subject = await canonicalSubject(changeDir)
  const ledger = await readDocumentLedger(changeDir)
  const records = ledger?.records.filter((record) =>
    record.kind === kind
    && record.recordedAt === recordedAt
    && (options.record === undefined
      || (record.path === options.record.path && record.sha256 === options.record.sha256))) ?? []
  const confirmed: Array<{
    readonly record: DocumentRecord
    readonly confirmation: DocumentSkillConfirmationV1
  }> = []
  for (const record of records) {
    const confirmation = await matchingConfirmation(changeDir, subject, record)
    if (confirmation !== undefined) confirmed.push({ record, confirmation })
  }
  if (confirmed.length === 0) return undefined
  if (confirmed.length !== 1) throw new Error('canonical document producer confirmation is ambiguous')
  const { record, confirmation } = confirmed[0]!
  let invocationId = confirmation.invocation_id
  const adapter = { kind: confirmation.adapter.kind, proof_ref: confirmation.adapter.proof_ref }
  const allInvocationEvents = await readSkillInvocationEventsForApplication(changeDir)
  let invocationEvents = allInvocationEvents
    .filter((event) => event.invocation_id === invocationId)
  const existingIntent = invocationEvents.find((event): event is Extract<
    SkillInvocationEventV1, { type: 'artifact-binding-intent' }
  > =>
    event.type === 'artifact-binding-intent' && intentMatchesRecord(event, record))
  if (existingIntent !== undefined && invocationEvents.some((event) =>
    event.type === 'artifact-bound' && event.payload.binding_id === existingIntent.payload.binding_id)) {
    return { invocation_id: invocationId }
  }
  if (invocationEvents.some((event) => event.type === 'invocation-completed')) {
    // One declared output can bind only one artifact. A host Skill may legitimately produce
    // several canonical documents, so subsequent document applications derive a stable child
    // invocation from the sealed host proof plus the exact canonical record instead of reusing an
    // output id or accepting caller identity.
    invocationId = `invocation-${digest(
      'document-application', confirmation.invocation_id, record.kind,
      record.path, record.sha256, record.recordedAt,
    )}`
    invocationEvents = allInvocationEvents.filter((event) => event.invocation_id === invocationId)
    const childIntent = invocationEvents.find((event): event is Extract<
      SkillInvocationEventV1, { type: 'artifact-binding-intent' }
    > =>
      event.type === 'artifact-binding-intent' && intentMatchesRecord(event, record))
    if (childIntent !== undefined && invocationEvents.some((event) =>
      event.type === 'artifact-bound' && event.payload.binding_id === childIntent.payload.binding_id)) {
      return { invocation_id: invocationId }
    }
  }
  let started = invocationEvents.find((event): event is Extract<SkillInvocationEventV1, { type: 'invocation-started' }> =>
    event.type === 'invocation-started')
  if (started === undefined) {
    started = {
    schema_version: 'skill-invocation-evidence/v1', event_id: `${invocationId}-started`,
    invocation_id: invocationId, sequence: 1, type: 'invocation-started',
    subject, recorded_at: record.recordedAt,
    payload: {
      skill: { id: record.producer, version: '1' }, adapter,
      input: { schema_id: 'tenon-document-producer-input/v1', fields: [{
        name: 'document_kind', classification: 'configuration', digest: `sha256:${digest(record.kind)}`,
        validator: { id: 'document-kind-contract', status: 'pass' },
      }, {
        name: 'document_path', classification: 'project-data', digest: `sha256:${digest(record.path)}`,
        validator: { id: 'document-path-contract', status: 'pass' },
      }] },
    },
    }
    await appendEvent(changeDir, started, {})
    invocationEvents = [started]
  }
  let sequence = Math.max(...invocationEvents.map((event) => event.sequence)) + 1
  if (!invocationEvents.some((event) => event.type === 'invocation-completed')) {
    const completed: Extract<SkillInvocationEventV1, { type: 'invocation-completed' }> = {
      ...started, event_id: `${invocationId}-completed`, sequence, type: 'invocation-completed',
      payload: { adapter, output: { schema_id: 'tenon-document-producer-output/v1', fields: [{
        name: 'document_record', classification: 'project-data', digest: `sha256:${record.sha256}`,
        validator: { id: 'canonical-document-record', status: 'pass' },
      }] } },
    }
    await appendEvent(changeDir, completed, { verify_completed_adapter: async () => true })
    sequence += 1
  }
  const bindingId = `binding-${digest(invocationId, record.sha256)}`
  const artifactEventRef = digest(record.path, record.sha256)
  await appendEvent(changeDir, {
    ...started, event_id: `${invocationId}-artifact-intent-${artifactEventRef}`, sequence, type: 'artifact-binding-intent',
    payload: { binding_id: bindingId, output_id: 'document_record',
      artifact: { kind: 'document', ref: record.path, digest: `sha256:${record.sha256}`,
        document: { kind: record.kind, recorded_at: record.recordedAt } },
      validator_ids: ['canonical-document-record'] },
  }, {})
  sequence += 1
  await appendEvent(changeDir, {
    ...started, event_id: `${invocationId}-artifact-bound-${artifactEventRef}`, sequence, type: 'artifact-bound',
    payload: { binding_id: bindingId, artifact_digest: `sha256:${record.sha256}`,
      validators: [{ id: 'canonical-document-record', status: 'pass' }] },
  }, { verify_artifact: async () => true })
  return { invocation_id: invocationId }
}
