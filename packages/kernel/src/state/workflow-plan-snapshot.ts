import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunMetadata } from '../types.js'
import {
  effectiveWorkflowPlanFromSnapshot,
  type WorkflowPlanSnapshot,
} from '../workflow/effective-plan.js'
import type { DocumentGovernancePolicy } from '../workflow/document-contract.js'
import type { WorkflowIR } from '../workflow/ir.js'
import type {
  WorkflowDecompositionPolicyV1,
  WorkflowInteractionPolicyV1,
} from '../workflow/types.js'
import type { RetiredReviewBudget } from '../workflow/workflow-plan-snapshot-types.js'
import { atomicLinkPublish } from './atomic-publish.js'

export const WORKFLOW_PLAN_SNAPSHOT_FILE = '.pipeline-workflow-plan.json'

export interface WorkflowPlanSnapshotEnvelope {
  readonly version: 1
  readonly run_id: string
  readonly plan: WorkflowPlanSnapshot
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const value = Reflect.get(error, 'code')
  return typeof value === 'string' ? value : undefined
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function isWorkflowIr(value: unknown): value is WorkflowIR {
  const record = ownRecord(value)
  return record !== undefined
    && typeof record.name === 'string'
    && Array.isArray(record.steps)
}

export function parseWorkflowPlanSnapshot(raw: string): WorkflowPlanSnapshotEnvelope {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('workflow plan snapshot 不是合法 JSON')
  }
  const envelope = ownRecord(value)
  const plan = ownRecord(envelope?.plan)
  const planVersion = plan?.version
  const allowedPlanKeys = planVersion === 4
    ? [
        'version', 'workflowId', 'executionModel', 'workflow', 'documentPolicy',
        'decomposition', 'interaction', 'workflowFingerprint',
      ]
    : planVersion === 3
    ? [
        'version', 'workflowId', 'executionModel', 'workflow', 'documentPolicy',
        'decomposition', 'interaction', 'reviewBudget', 'workflowFingerprint',
      ]
    : planVersion === 2
      ? ['version', 'workflowId', 'executionModel', 'workflow', 'documentPolicy', 'workflowFingerprint']
      : ['version', 'workflowId', 'executionModel', 'workflow', 'workflowFingerprint']
  const documentPolicy = plan?.documentPolicy
  if (!envelope
    || Object.keys(envelope).some((key) => !['version', 'run_id', 'plan'].includes(key))
    || envelope.version !== 1
    || typeof envelope.run_id !== 'string'
    || envelope.run_id === ''
    || !plan
    || Object.keys(plan).some((key) => !allowedPlanKeys.includes(key))
    || ![1, 2, 3, 4].includes(planVersion as number)
    || typeof plan.workflowId !== 'string'
    || (plan.executionModel !== 'phase-manifest' && plan.executionModel !== 'step-graph')
    || (planVersion !== 1 && documentPolicy !== null && ownRecord(documentPolicy) === undefined)
    || ((planVersion === 3 || planVersion === 4)
      && (ownRecord(plan.decomposition) === undefined || ownRecord(plan.interaction) === undefined))
    || typeof plan.workflowFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(plan.workflowFingerprint)
    || !isWorkflowIr(plan.workflow)) {
    throw new Error('workflow plan snapshot 形状非法')
  }
  const snapshot: WorkflowPlanSnapshot = planVersion === 1
    ? {
        version: 1,
        workflowId: plan.workflowId,
        executionModel: plan.executionModel,
        workflow: plan.workflow,
        workflowFingerprint: plan.workflowFingerprint,
      }
    : planVersion === 2 ? {
        version: 2,
        workflowId: plan.workflowId,
        executionModel: plan.executionModel,
        workflow: plan.workflow,
        documentPolicy: documentPolicy as DocumentGovernancePolicy | null,
        workflowFingerprint: plan.workflowFingerprint,
      }
      : planVersion === 3 ? {
        version: 3,
        workflowId: plan.workflowId,
        executionModel: plan.executionModel,
        workflow: plan.workflow,
        documentPolicy: documentPolicy as DocumentGovernancePolicy | null,
        decomposition: plan.decomposition as WorkflowDecompositionPolicyV1,
        interaction: plan.interaction as WorkflowInteractionPolicyV1,
        ...(plan.reviewBudget === undefined
          ? {}
          : { reviewBudget: plan.reviewBudget as RetiredReviewBudget }),
        workflowFingerprint: plan.workflowFingerprint,
      }
        : {
          version: 4,
          workflowId: plan.workflowId,
          executionModel: plan.executionModel,
          workflow: plan.workflow,
          documentPolicy: documentPolicy as DocumentGovernancePolicy | null,
          decomposition: plan.decomposition as WorkflowDecompositionPolicyV1,
          interaction: plan.interaction as WorkflowInteractionPolicyV1,
          workflowFingerprint: plan.workflowFingerprint,
        }
  effectiveWorkflowPlanFromSnapshot(snapshot)
  return { version: 1, run_id: envelope.run_id, plan: snapshot }
}

export function workflowPlanSnapshotContent(
  runId: string,
  snapshot: WorkflowPlanSnapshot,
): string {
  return `${JSON.stringify({ version: 1, run_id: runId, plan: snapshot })}\n`
}

export async function readWorkflowPlanSnapshot(
  changeDir: string,
): Promise<WorkflowPlanSnapshotEnvelope | undefined> {
  const target = join(changeDir, WORKFLOW_PLAN_SNAPSHOT_FILE)
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`workflow plan snapshot 必须是非 symlink 普通文件: ${target}`)
    }
    return parseWorkflowPlanSnapshot(await readFile(target, 'utf8'))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

export async function ensureWorkflowPlanSnapshot(
  changeDir: string,
  runId: string,
  snapshot: WorkflowPlanSnapshot,
): Promise<void> {
  const requested = workflowPlanSnapshotContent(runId, snapshot)
  const existing = await readWorkflowPlanSnapshot(changeDir)
  if (existing !== undefined) {
    if (`${JSON.stringify(existing)}\n` !== requested) {
      throw new Error('Change 已固定不同的 workflow plan snapshot，拒绝覆盖')
    }
    return
  }
  const target = join(changeDir, WORKFLOW_PLAN_SNAPSHOT_FILE)
  try {
    await atomicLinkPublish(changeDir, '.pipeline-workflow-plan.tmp', target, requested)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const raced = await readWorkflowPlanSnapshot(changeDir)
    if (raced === undefined || `${JSON.stringify(raced)}\n` !== requested) {
      throw new Error('workflow plan snapshot 并发创建后内容不一致')
    }
  }
}

export function attachWorkflowPlanSnapshot(
  metadata: RunMetadata | undefined,
  envelope: WorkflowPlanSnapshotEnvelope | undefined,
): RunMetadata | undefined {
  if (metadata === undefined || envelope === undefined) return metadata
  if (envelope.run_id !== metadata.runId) {
    throw new Error('workflow plan snapshot 与 canonical runId 不一致')
  }
  if (metadata.workflowPlanFingerprint === undefined
    || envelope.plan.workflowFingerprint !== metadata.workflowPlanFingerprint) {
    throw new Error('workflow plan snapshot 与 workflow governance fingerprint 不一致')
  }
  return { ...metadata, workflowPlanSnapshot: envelope.plan }
}
