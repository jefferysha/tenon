/**
 * Governed OpenSpec document evidence commands.
 *
 * The workflow state remains in the canonical StateStore; this command owns only the sidecar
 * evidence ledger.  Every mutation is performed under the same change lock as a transition so a
 * phase cannot move between "checked" and "recorded/read".
 */
import {
  atomicLinkPublish,
  effectiveWorkflowPlanBinding,
  ensureDocumentLedger,
  evaluateDocumentEvidence,
  isDocumentKind,
  isDocumentPolicyStep,
  migrateLegacyDeltaDocument,
  recordDocument,
  currentDocumentSkillConfirmation,
  recordDocumentReads,
  renderDocumentTemplate,
  documentPathForKind,
  documentTemplateIdForKind,
  readDocumentLedger,
} from '@tenon/kernel'
import {
  recordCanonicalDocumentSkillInvocation,
  withSkillInvocationChangeLock,
} from '../../../kernel/dist/skill-invocation/producer-internal.js'
import type {
  DocumentContractPhase,
  DocumentEvidenceReport,
  DocumentGovernancePolicy,
  DocumentKind,
  PipelineState,
  DocumentLocale,
} from '@tenon/kernel'
import { lstat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { reconcileCodexSkillEvidence } from '../codexSkillReceipt.js'
import { resolveChangeDocumentLocale } from '../documentLocale.js'
import {
  assertSafeChangeRoot,
  ensureSafeDocumentParent,
  ordinaryDocumentFile,
  requiredDeltaCapability,
} from './documentScaffoldSafety.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

interface GovernedDocumentContext {
  readonly workflowName: string
  readonly phase: string
  readonly governed: boolean
  readonly policy?: DocumentGovernancePolicy
}

function reject(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

function scalar(state: PipelineState, field: 'phase' | 'track'): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

export async function cmdDocumentScaffold(
  deps: CliDeps,
  name: string,
  kind: string,
  requestedLocale?: string,
  requestedCapability?: string,
): Promise<number> {
  const dir = assertChangeName(deps, name)
  if (!dir) return 1
  if (!isDocumentKind(kind)) return reject(deps, `未知 document kind: '${kind}'`)
  try {
    await assertSafeChangeRoot(deps.cwd, dir)
    const state = await deps.store.read(dir)
    const context = governedDocumentContext(deps, state)
    const { policy } = assertGoverned(context)
    const declared = Object.values(policy.outputsByStep)
      .some((outputs) => outputs.some((output) => output.kind === kind))
    if (!declared) {
      throw new Error(`document kind '${kind}' 未在 workflow '${context.workflowName}' 的 contract 中声明`)
    }
    const capability = kind === 'delta-spec'
      ? requiredDeltaCapability(requestedCapability)
      : undefined
    if (kind !== 'delta-spec' && requestedCapability !== undefined) {
      throw new Error('--capability 只适用于 delta-spec')
    }
    await assertSafeChangeRoot(deps.cwd, dir)
    const locale = await resolveChangeDocumentLocale(dir, requestedLocale, true)
    const targetRelative = documentPathForKind(kind, { change: name, capability })
    const target = resolve(deps.cwd, targetRelative)
    const escaped = relative(resolve(deps.cwd), target)
    if (escaped === '..' || escaped.startsWith('../') || escaped.startsWith('..\\')) {
      throw new Error(`document scaffold 路径越界: ${targetRelative}`)
    }
    const parent = await ensureSafeDocumentParent(deps.cwd, target)
    await assertSafeChangeRoot(deps.cwd, dir)
    try {
      const info = await lstat(target)
      if (!ordinaryDocumentFile(info)) throw new Error(`document scaffold 目标必须是非 symlink 普通文件: ${targetRelative}`)
      deps.io.out(targetRelative)
      return 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const plan = effectiveWorkflowForState(deps, state)
    const workflowSteps = plan?.workflow.steps.map((step) => ({ id: step.id, label: step.label }))
    const designDoc = scalar(state, 'phase') === 'open'
      ? undefined
      : String(state.fields.design_doc ?? '')
    const content = renderDocumentTemplate(documentTemplateIdForKind(kind), locale as DocumentLocale, {
      change: name,
      workflowStepLabelSource: plan?.projection.stepLabelSource,
      workflowSteps,
      ...(designDoc && designDoc !== 'null' ? { designDoc } : {}),
    })
    try {
      await assertSafeChangeRoot(deps.cwd, dir)
      await atomicLinkPublish(parent, '.pipeline-document-scaffold.tmp', target, content)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await lstat(target)
      if (!ordinaryDocumentFile(info)) {
        throw new Error(`document scaffold 目标必须是非 symlink 普通文件: ${targetRelative}`)
      }
    }
    deps.io.out(targetRelative)
    return 0
  } catch (error) {
    return reject(deps, errMsg(error))
  }
}

/** Resolve governance from the actual persisted workflow definition, never a caller-supplied flag. */
export function governedDocumentContext(deps: CliDeps, state: PipelineState): GovernedDocumentContext {
  const plan = effectiveWorkflowForState(deps, state)
  if (!plan) {
    throw new Error(`workflow '${String(state.fields.workflow ?? '')}' 未找到或不可编译`)
  }
  const workflowName = plan.id
  const policy = plan.capabilities.documents.policy
  const governed = policy !== undefined
  const phase = scalar(state, 'phase')
  if (!governed) {
    // A non-governed workflow may use arbitrary step ids.  The phase is intentionally not narrowed
    // or validated here because `document status` should correctly explain that no contract applies.
    return { workflowName, phase: 'open', governed: false }
  }
  if (!isDocumentPolicyStep(policy, phase)) {
    throw new Error(`受 document contract 治理的 workflow 当前 step 非法（当前 '${phase || '空'}'）`)
  }
  return { workflowName, phase, governed: true, policy }
}

function assertChangeName(deps: CliDeps, name: string): string | undefined {
  if (isValidChangeName(name)) return changeDir(deps.cwd, name)
  reject(deps, `change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
  return undefined
}

function assertGoverned(context: GovernedDocumentContext): {
  readonly phase: string
  readonly policy: DocumentGovernancePolicy
} {
  if (!context.governed || !context.policy) {
    throw new Error(`workflow '${context.workflowName}' 未声明 document contract；此 Change 不适用 document ledger`)
  }
  return { phase: context.phase, policy: context.policy }
}

/** `tenon document init <change>`: create the ledger for a governed existing change (migration-safe). */
export async function cmdDocumentInit(deps: CliDeps, name: string): Promise<number> {
  const dir = assertChangeName(deps, name)
  if (!dir) return 1
  try {
    const state = await deps.store.read(dir)
    const plan = effectiveWorkflowForState(deps, state)
    if (!plan) {
      throw new Error(`workflow '${String(state.fields.workflow ?? '')}' 未找到或不可编译`)
    }
    assertGoverned(governedDocumentContext(deps, state))
    // `document init` is the explicit migration boundary for a pre-WorkflowRun Change. Establish
    // its canonical visit identity and immutable governance binding before any read receipt can be
    // written. The repository mutation is independently locked; do not nest it under StateStore's
    // non-reentrant change lock.
    await deps.runRepo.establishRun(dir, effectiveWorkflowPlanBinding(plan))
    await ensureDocumentLedger(dir, deps.clock())
    return 0
  } catch (error) {
    return reject(deps, errMsg(error))
  }
}

/**
 * `tenon document record`: bind a real document plus actual Skill invocation evidence.
 *
 * `backfill` is deliberately explicit for an installed-plugin upgrade: an older Change may already
 * have passed the phase that originally owns an unrecorded document. It cannot overwrite an existing
 * record, register a future phase, bypass current producer evidence, or bypass digest/path checks.
 */
export async function cmdDocumentRecord(
  deps: CliDeps,
  name: string,
  kind: string,
  path: string,
  producer: string,
  backfill = false,
): Promise<number> {
  const dir = assertChangeName(deps, name)
  if (!dir) return 1
  if (!isDocumentKind(kind)) return reject(deps, `未知 document kind: '${kind}'`)
  if (path === '') return reject(deps, 'document path 不得为空')
  if (producer === '') return reject(deps, '--producer 不得为空')
  if (producer.includes('|')) return reject(deps, `--producer '${producer}' 必须是单个具体 skill id`)
  try {
    const recordedAt = deps.clock()
    await withSkillInvocationChangeLock(dir, async (lock) => {
      const state = await deps.store.read(dir)
      const context = governedDocumentContext(deps, state)
      const { phase, policy } = assertGoverned(context)
      const runMetadata = state.runMetadata
      if (runMetadata === undefined) throw new Error('canonical WorkflowRun StepVisit identity is missing')
      // Both adapters land one host-neutral confirmation derived from this canonical StepVisit.
      // Native Skill PostToolUse history is the fast path; Codex may instead reconcile a pending
      // receipt against its host-owned completed transcript. Neither path can accept a caller-
      // supplied run/sequence binding, and a receipt or old history row alone cannot pass.
      await reconcileCodexSkillEvidence({
        repoRoot: deps.cwd,
        changeDir: dir,
        producer,
        recordedAt,
        history: deps.history,
        evidenceScope: phase,
        stepVisit: {
          runId: runMetadata.runId,
          transitionSequence: runMetadata.transitionSequence,
        },
        applicationKey: `${kind}\0${path}`,
      })
      if (await currentDocumentSkillConfirmation(dir, producer, phase, recordedAt) === undefined) {
        throw new Error(`current StepVisit lacks exact host confirmation for document producer '${producer}'`)
      }
      let ledger: Awaited<ReturnType<typeof readDocumentLedger>>
      if (deps.artifactSubmission) {
        const submission = await deps.artifactSubmission({ changeDir: dir, phase, policy })
        const submissionPath = relative(dir, resolve(deps.cwd, path))
        const receipt = await submission.submit({
          projection: 'document',
          logicalKey: `document:${kind}`,
          path: submissionPath,
          documentKind: kind,
          producer,
          recordedAt,
          allowBackfill: backfill,
        })
        if (receipt.status !== 'committed') throw new Error(receipt.diagnostics?.join('; ') ?? 'document submission failed')
        ledger = await readDocumentLedger(dir)
        if (ledger === undefined) throw new Error('document submission committed without a document ledger')
      } else {
        ledger = await recordDocument({
          repoRoot: deps.cwd,
          changeDir: dir,
          phase,
          policy,
          kind: kind as DocumentKind,
          path,
          producer,
          recordedAt,
          allowBackfill: backfill,
        })
      }
      const requestedPath = relative(resolve(deps.cwd), resolve(deps.cwd, path))
      const canonicalRecords = ledger.records.filter((record) =>
        record.kind === kind
        && record.producer === producer
        && record.recordedAt === recordedAt
        && record.path === requestedPath)
      if (canonicalRecords.length !== 1) {
        throw new Error('canonical document record is missing or ambiguous after registration')
      }
      const canonicalRecord = canonicalRecords[0]!
      const invocation = await recordCanonicalDocumentSkillInvocation(
        dir, kind as DocumentKind, recordedAt, { lock, record: canonicalRecord },
      )
      if (invocation === undefined) {
        throw new Error('canonical document record lacks exact current-StepVisit invocation evidence')
      }
    })
    return 0
  } catch (error) {
    return reject(deps, errMsg(error))
  }
}

/** Explicitly map one legacy delta record to its canonical capability path without changing bytes. */
export async function cmdDocumentMigrateDelta(
  deps: CliDeps,
  name: string,
  legacyPath: string,
  canonicalPath: string,
): Promise<number> {
  const dir = assertChangeName(deps, name)
  if (!dir) return 1
  if (!legacyPath || !canonicalPath) return reject(deps, 'legacy-path 与 canonical-path 均不得为空')
  try {
    await deps.store.withLock(dir, async () => {
      const context = governedDocumentContext(deps, await deps.store.read(dir))
      assertGoverned(context)
      await migrateLegacyDeltaDocument({
        repoRoot: deps.cwd,
        changeDir: dir,
        legacyPath,
        canonicalPath,
      })
    })
    return 0
  } catch (error) {
    return reject(deps, errMsg(error))
  }
}

/** `tenon document read`: store a digest-bound receipt that the current phase consumed its inputs. */
export async function cmdDocumentRead(
  deps: CliDeps,
  name: string,
  kind: string,
): Promise<number> {
  const dir = assertChangeName(deps, name)
  if (!dir) return 1
  if (kind !== 'all' && !isDocumentKind(kind)) return reject(deps, `未知 document kind: '${kind}'`)
  try {
    await deps.store.withLock(dir, async () => {
      const context = governedDocumentContext(deps, await deps.store.read(dir))
      const { phase, policy } = assertGoverned(context)
      await recordDocumentReads({
        repoRoot: deps.cwd,
        changeDir: dir,
        phase,
        policy,
        kind: kind === 'all' ? 'all' : kind,
        readAt: deps.clock(),
      })
    })
    return 0
  } catch (error) {
    return reject(deps, errMsg(error))
  }
}

function renderEvidence(deps: CliDeps, report: DocumentEvidenceReport): void {
  for (const item of report.items) {
    const read = item.requiredRead ? ' · read required' : ''
    const paths = item.paths.length === 0 ? '' : ` · ${item.paths.join(', ')}`
    deps.io.out(`  [${item.status.toUpperCase()}] ${item.kind}${read}${paths}`)
  }
  for (const blocker of report.blockers) deps.io.out(`  [FAIL] ${blocker}`)
}

/** Read-only evidence report.  Exit 2 means state is valid but the governed proof is incomplete. */
export async function cmdDocumentStatus(deps: CliDeps, name: string, json: boolean): Promise<number> {
  const dir = assertChangeName(deps, name)
  if (!dir) return 1
  try {
    const state = await deps.store.read(dir)
    const context = governedDocumentContext(deps, state)
    if (!context.governed) {
      const value = { change: name, workflow: context.workflowName, governed: false }
      if (json) deps.io.out(JSON.stringify(value))
      else {
        deps.io.out(`[DOCUMENT] ${name} (workflow=${context.workflowName})`)
        deps.io.out('  [SKIP] 当前 workflow 未声明文档治理契约（自由模式）')
      }
      return 0
    }
    const report = await evaluateDocumentEvidence(deps.cwd, dir, context.phase, {}, context.policy)
    if (json) {
      deps.io.out(JSON.stringify({ change: name, workflow: context.workflowName, governed: true, ...report }))
    } else {
      deps.io.out(`[DOCUMENT] ${name} (workflow=${context.workflowName}, phase=${context.phase})`)
      renderEvidence(deps, report)
      if (report.pass) deps.io.out('  [PASS] 文档产物和读取证据完整')
    }
    return report.pass ? 0 : 2
  } catch (error) {
    return reject(deps, errMsg(error))
  }
}
