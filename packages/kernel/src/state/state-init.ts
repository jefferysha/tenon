import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  DocumentProfileId, FieldName, InitOptions, RunMetadata,
} from '../types.js'
import { emptyFields } from './parse.js'
import {
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanBinding,
  resolveEffectiveWorkflowPlan,
} from '../workflow/effective-plan.js'

const DEFAULT_PLAN = compileEffectiveWorkflowPlan('default')
const DEFAULT_PLAN_BINDING = effectiveWorkflowPlanBinding(DEFAULT_PLAN)

/** ISO-8601 UTC seconds, aligned with the original shell state initializer. */
export function defaultStateClock(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

/** Resolve the current branch from normal repositories, worktrees, and submodules without spawn. */
export async function detectBaseBranch(repoRoot: string): Promise<string> {
  try {
    const gitPath = path.join(repoRoot, '.git')
    let gitDir = gitPath
    const entry = await stat(gitPath)
    if (!entry.isDirectory()) {
      const pointer = await readFile(gitPath, 'utf8')
      const match = /^gitdir:\s*(.+)$/m.exec(pointer)
      const target = match?.[1]?.trim()
      if (!target) return 'main'
      gitDir = path.resolve(repoRoot, target)
    }
    const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8')
    const branch = /^ref: refs\/heads\/(\S+)$/.exec(head.trim())?.[1]
    if (branch) return branch
  } catch {
    // A missing/detached repository has always used main as the compatibility fallback.
  }
  return 'main'
}

export function initialDocumentProfile(opts: InitOptions): DocumentProfileId | undefined {
  const workflow = opts.initialWorkflow
  if (workflow?.documentProfile !== undefined) return workflow.documentProfile
  if (workflow?.openspecContract === true) return 'legacy-full'
  if (workflow?.documentContract === true) return 'document-v1'
  const workflowId = workflow?.workflow ?? DEFAULT_PLAN.id
  return resolveEffectiveWorkflowPlan(workflowId, () => null)?.capabilities.documents.profile
}

export function initialDocumentGovernanceFingerprint(opts: InitOptions): string | undefined {
  const explicit = opts.initialWorkflow?.documentGovernanceFingerprint
  if (explicit !== undefined) return explicit
  return initialDocumentProfile(opts) === 'legacy-full'
    ? DEFAULT_PLAN_BINDING.documentGovernanceFingerprint
    : undefined
}

export function initialWorkflowPlanFingerprint(opts: InitOptions): string | undefined {
  const explicit = opts.initialWorkflow?.workflowPlanFingerprint
  if (explicit !== undefined) return explicit
  const workflowId = opts.initialWorkflow?.workflow ?? DEFAULT_PLAN.id
  return resolveEffectiveWorkflowPlan(workflowId, () => null)?.workflowFingerprint
}

export function initialRunMetadata(opts: InitOptions): RunMetadata | undefined {
  if (!opts.runId) return undefined
  const documentProfile = initialDocumentProfile(opts)
  const documentGovernanceFingerprint = initialDocumentGovernanceFingerprint(opts)
  const workflowPlanFingerprint = initialWorkflowPlanFingerprint(opts)
  const workflowPlanSnapshot = opts.initialWorkflow?.workflowPlanSnapshot
  return {
    runId: opts.runId,
    transitionSequence: 0,
    ...(documentProfile === undefined ? {} : { documentProfile }),
    ...(documentGovernanceFingerprint === undefined ? {} : { documentGovernanceFingerprint }),
    ...(workflowPlanFingerprint === undefined ? {} : { workflowPlanFingerprint }),
    ...(workflowPlanSnapshot === undefined ? {} : { workflowPlanSnapshot }),
  }
}

/** Canonical initial aggregate fields; persistence publication remains owned by StateStore. */
export function initialFields(
  opts: InitOptions,
  timestamp: string,
  baseBranch: string,
  createdBy: string,
): Record<FieldName, string | string[]> {
  const fields = emptyFields()
  fields.track = opts.track
  fields.preset = opts.preset
  fields.created_by = createdBy
  fields.assignee = createdBy
  fields.phase = opts.initialWorkflow?.phase ?? 'open'
  fields.phase_status = 'pending'
  fields.design_doc = 'null'
  fields.plan = 'null'
  fields.verification_report = 'null'
  fields.build_mode = 'null'
  fields.isolation = 'null'
  fields.build_sha = 'null'
  fields.agent_review_result = opts.reviewSeed
  fields.codex_review_result = opts.reviewSeed
  fields.verify_result = 'pending'
  fields.branch_status = 'pending'
  fields.pre_verify_review_result = 'pending'
  fields.direct_override = 'false'
  fields.prd_path = 'null'
  fields.pr_url = 'null'
  fields.automation = 'off'
  fields.automation_queued_at = ''
  fields.automation_sandbox = ''
  fields.automation_worktree = ''
  fields.automation_attempts = '0'
  fields.automation_last_error = ''
  fields.automation_preserved_path = ''
  fields.branch = 'null'
  fields.base_branch = baseBranch
  fields.scope = 'null'
  fields.related_files = 'null'
  fields.spec_scope = 'null'
  fields.depends_on = 'null'
  fields.created_at = timestamp
  fields.updated_at = timestamp
  fields.verified_at = 'null'
  fields.archived_at = 'null'
  fields.archived = 'false'
  if (opts.initialWorkflow) fields.workflow = opts.initialWorkflow.workflow
  fields.automation_current_phase = ''
  fields.automation_cause = ''
  fields.review_gate_phase = ''
  fields.review_gate_status = ''
  fields.review_gate_event = ''
  fields.review_requested_at = ''
  fields.review_acknowledged_at = ''
  fields.review_acknowledged_via = 'unknown'
  return fields
}
