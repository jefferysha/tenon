import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  compileLedgerContextBundleWithPorts,
  DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
  isDocumentPolicyStep,
  LedgerContextBundleError,
  nodeLedgerContextBundlePrimitives,
  readsRequiredForPolicyStep,
  resolveWorkflowName,
  validateChangeName,
  type DocumentGovernancePolicy,
  type PipelineState,
} from '@tenon/kernel'
import {
  assertChangePathAnchor,
  captureChangePathAnchor,
  ContextBundlePathError,
  contextBundleErrorStatus,
  safeContextBundleErrorText,
  safeContextBundlePreview,
  safeContextBundleRepairAction,
  type ChangePathAnchor,
} from './contextBundlePreviewSupport.js'
import {
  trustedContextBundleCurrentSnapshot,
  trustedContextBundleInputs,
} from './contextBundleTrustedReader.js'
import { assertWorkflowRootAnchor, readWorkflowForApi, WorkflowNotFoundError, type WorkflowRootAnchor } from './workflows.js'
import { resolveSnapshotTrack } from './skillRuns.js'
import { resolveSnapshotEffectivePlan } from './workflowSnapshot.js'
import type { GetRouteDeps } from './serverGetRoutes.js'

/** The change's bound document policy, resolved exactly like the snapshot; undefined = not governed. */
function changeDocumentPolicy(anchor: WorkflowRootAnchor, state: PipelineState): DocumentGovernancePolicy | undefined {
  const workflowName = resolveWorkflowName(state)
  const trackValue = state.fields.track
  const trackId = Array.isArray(trackValue) ? trackValue.join(',') : (trackValue ?? '')
  return resolveSnapshotEffectivePlan(anchor.path, workflowName, {
    documentProfile: state.runMetadata?.documentProfile,
    documentGovernanceFingerprint: state.runMetadata?.documentGovernanceFingerprint,
    workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
    workflowPlanSnapshot: state.runMetadata?.workflowPlanSnapshot,
  }, (name) => {
    try {
      return readWorkflowForApi(anchor, name)
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return null
      throw error
    }
  }, resolveSnapshotTrack(anchor.path, trackId, workflowName)).capabilities.documents.policy
}

type ContextBundlePreviewDeps = Pick<
  GetRouteDeps,
  'sendJson' | 'workflowRootForRequest'
>

function invalidRequest(
  res: ServerResponse,
  sendJson: GetRouteDeps['sendJson'],
  error: string,
): void {
  sendJson(res, 400, {
    ok: false,
    code: 'CONTEXT_BUNDLE_INVALID_REQUEST',
    error,
    repairAction: '请提供已注册 root、安全 change、workflow step target 和正安全整数 budgetBytes。',
  })
}

function reportInternalFailure(
  _deps: ContextBundlePreviewDeps,
  context: string,
  error: unknown,
): void {
  const candidate = typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined
  const code = typeof candidate === 'string' && /^[A-Z0-9_-]{1,64}$/.test(candidate)
    ? candidate
    : 'REDACTED'
  process.stderr.write(`[context-bundle-preview] ${context}; code=${code}\n`)
}

/**
 * Read-only adapter around the kernel's ledger-bound compiler. This layer owns only HTTP
 * validation/status/DTO mapping: policy, materialization, byte accounting and typed failures
 * stay in @tenon/kernel so Dashboard and CLI cannot drift.
 */
export async function handleContextBundlePreview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ContextBundlePreviewDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const root = url.searchParams.get('root')
  const change = url.searchParams.get('change')
  const target = url.searchParams.get('target')
  const budgetText = url.searchParams.get('budgetBytes')
  if (root === null || root === '' || change === null || target === null || budgetText === null) {
    return invalidRequest(res, deps.sendJson, '缺少 root、change、target 或 budgetBytes 查询参数')
  }
  if (!validateChangeName(change).ok) {
    return invalidRequest(res, deps.sendJson, 'change 名非法（仅允许 a-z A-Z 0-9 - _）')
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(target)) {
    return invalidRequest(res, deps.sendJson, 'target 必须是 workflow step id')
  }
  if (!/^[1-9][0-9]*$/.test(budgetText)) {
    return invalidRequest(res, deps.sendJson, 'budgetBytes 必须是正安全整数')
  }
  const budgetBytes = Number(budgetText)
  if (!Number.isSafeInteger(budgetBytes)) {
    return invalidRequest(res, deps.sendJson, 'budgetBytes 必须是正安全整数')
  }

  const rootCheck = deps.workflowRootForRequest(root)
  if (!rootCheck.ok) {
    return deps.sendJson(res, rootCheck.code, {
      ok: false,
      error: rootCheck.code === 403
        ? 'Context Bundle root trust check failed'
        : 'Context Bundle registered root is unavailable',
    })
  }
  const anchor = rootCheck.anchor
  if (anchor.fdPath === undefined) {
    return deps.sendJson(res, 501, {
      ok: false,
      code: 'CONTEXT_BUNDLE_TRUSTED_READER_UNAVAILABLE',
      error: 'Context Bundle trusted reader is unavailable on this platform',
      repairAction: 'Run the Dashboard on a platform with fd-relative directory traversal.',
    })
  }
  let changeAnchor: ChangePathAnchor | undefined
  let changeIdentity: { readonly dev: number; readonly ino: number } | undefined
  let stateBefore: ReturnType<typeof trustedContextBundleCurrentSnapshot> | undefined
  try {
    assertWorkflowRootAnchor(anchor)
    changeAnchor = captureChangePathAnchor(anchor, change)
    const capturedChange = changeAnchor.chain[2]
    if (capturedChange === undefined) {
      throw new ContextBundlePathError(403, 'Context Bundle Change identity capture failed')
    }
    changeIdentity = {
      dev: capturedChange.dev,
      ino: capturedChange.ino,
    }
    stateBefore = trustedContextBundleCurrentSnapshot(anchor, change, changeIdentity)
    const from = stateBefore.phase
    const policy = changeDocumentPolicy(anchor, stateBefore.state)
    if (policy === undefined) return invalidRequest(res, deps.sendJson, 'workflow 未开启 openspec')
    if (!isDocumentPolicyStep(policy, target)) {
      return invalidRequest(res, deps.sendJson, `target 必须是 workflow step: ${target}`)
    }
    assertChangePathAnchor(changeAnchor)
    assertWorkflowRootAnchor(anchor)
    const trustedInputs = readsRequiredForPolicyStep(policy, target).length === 0
      ? {
          ledger: undefined,
          sourceReader: {
            read: async () => {
              throw new Error('policy-empty preview must not read a source document')
            },
          },
        }
      : trustedContextBundleInputs(
          anchor,
          change,
          changeIdentity,
          DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
        )
    const result = await compileLedgerContextBundleWithPorts({
      root: anchor.path,
      change,
      from,
      target,
      policy,
      budgetBytes,
      ledgerRepository: {
        read: async () => trustedInputs.ledger,
      },
      sourceReader: trustedInputs.sourceReader,
      primitives: nodeLedgerContextBundlePrimitives,
      resourceLimits: DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
    })
    assertChangePathAnchor(changeAnchor)
    assertWorkflowRootAnchor(anchor)
    const stateAfter = trustedContextBundleCurrentSnapshot(anchor, change, changeIdentity)
    if (stateAfter.revisionId !== stateBefore.revisionId
      || stateAfter.stateDigest !== stateBefore.stateDigest) {
      return deps.sendJson(res, 409, {
        ok: false,
        code: 'CONTEXT_BUNDLE_STATE_CORRUPT',
        error: 'Context Bundle canonical state changed during preview',
        repairAction: 'Retry after the canonical Change state is stable.',
      })
    }
    return deps.sendJson(res, 200, {
      ok: true,
      preview: safeContextBundlePreview(result.preview, true, result.bundle.aggregateDigest),
    })
  } catch (error) {
    // Any root replacement discovered during/after the read dominates domain classification:
    // never return compiler metadata after the registered identity has drifted.
    try {
      assertWorkflowRootAnchor(anchor)
    } catch (anchorError) {
      reportInternalFailure(deps, 'root anchor validation failed', anchorError)
      return deps.sendJson(res, 403, { ok: false, error: 'Context Bundle root trust check failed' })
    }
    if (changeAnchor !== undefined) {
      try {
        assertChangePathAnchor(changeAnchor)
      } catch (pathError) {
        reportInternalFailure(deps, 'change anchor validation failed', pathError)
        return deps.sendJson(res, 403, { ok: false, error: 'Context Bundle path trust check failed' })
      }
    }
    if (stateBefore !== undefined && changeIdentity !== undefined) {
      try {
        const stateAfter = trustedContextBundleCurrentSnapshot(anchor, change, changeIdentity)
        if (stateAfter.revisionId !== stateBefore.revisionId
          || stateAfter.stateDigest !== stateBefore.stateDigest) {
          return deps.sendJson(res, 409, {
            ok: false,
            code: 'CONTEXT_BUNDLE_STATE_CORRUPT',
            error: 'Context Bundle canonical state changed during preview',
            repairAction: 'Retry after the canonical Change state is stable.',
          })
        }
      } catch (snapshotError) {
        reportInternalFailure(deps, 'state snapshot revalidation failed', snapshotError)
        return deps.sendJson(res, 409, {
          ok: false,
          code: 'CONTEXT_BUNDLE_STATE_CORRUPT',
          error: 'Context Bundle canonical state changed during preview',
          repairAction: 'Retry after the canonical Change state is stable.',
        })
      }
    }
    if (error instanceof ContextBundlePathError) {
      return deps.sendJson(res, error.status, {
        ok: false,
        ...(error.status === 400 ? { code: 'CONTEXT_BUNDLE_INVALID_REQUEST' } : {}),
        error: error.status === 400
          ? 'Context Bundle Change state is unavailable'
          : 'Context Bundle path trust check failed',
        ...(error.status === 400
          ? { repairAction: '确认 Change 已创建 canonical workflow state 后重试。' }
          : {}),
      })
    }
    if (error instanceof LedgerContextBundleError) {
      if (error.cause !== undefined) {
        reportInternalFailure(deps, `${error.code} cause`, error.cause)
      }
      return deps.sendJson(res, contextBundleErrorStatus(error), {
        ok: false,
        code: error.code,
        error: safeContextBundleErrorText(error),
        repairAction: safeContextBundleRepairAction(error),
        detail: {
          ...(error.kind === undefined ? {} : { kind: error.kind }),
          ...(error.path === undefined ? {} : { path: error.path }),
          ...(error.requiredBytes === undefined ? {} : { requiredBytes: error.requiredBytes }),
          ...(error.availableBytes === undefined ? {} : { availableBytes: error.availableBytes }),
          ...(error.metric === undefined ? {} : { metric: error.metric }),
          ...(error.limit === undefined ? {} : { limit: error.limit }),
          ...(error.actual === undefined ? {} : { actual: error.actual }),
        },
        ...(error.code === 'CONTEXT_BUNDLE_BUDGET_EXCEEDED' && error.preview !== undefined
          ? { preview: safeContextBundlePreview(error.preview, false) }
          : {}),
      })
    }
    reportInternalFailure(deps, 'unexpected preview failure', error)
    return deps.sendJson(res, 500, { ok: false, error: 'Context Bundle preview failed' })
  }
}
