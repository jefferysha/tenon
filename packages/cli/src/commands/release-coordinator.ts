import type { CliDeps } from '../deps.js'
import {
  ManagedRuntimeIndeterminateError,
  type ManagedReleaseJournalRecord,
  type ManagedRuntimeTransaction,
  type RuntimeInstaller,
} from '../runtime/installer.js'
import type { RuntimeActivation } from '../runtime/types.js'
import {
  DEFAULT_DASHBOARD_PORT,
  type ReleasedDashboardStarter,
} from './dashboard.js'
import { coordinateReleaseDashboard } from './release-dashboard-coordinator.js'
import {
  resumeManagedReleaseCompensation,
} from './release-compensation.js'
import { prepareManagedReleaseCandidate } from './release-candidate-coordinator.js'
import {
  assertManagedActivationIdentity,
  revalidateResolvedCandidate,
} from './release-activation-validation.js'
import type {
  ManagedReleaseOutcome,
  ManagedReleaseRequest,
} from './release-coordinator-contract.js'

export type {
  ManagedHostPreparationContext,
  ManagedReleaseFailureState,
  ManagedReleaseOutcome,
  ManagedReleaseRequest,
} from './release-coordinator-contract.js'

/**
 * The only coordinator allowed to couple host candidate preparation, runtime activation,
 * Dashboard readiness, and final evidence. Every phase is serialized by the installer-owned
 * cross-process lock and write-ahead journal.
 */
export async function publishManagedRelease(
  deps: CliDeps,
  request: ManagedReleaseRequest,
  installer: RuntimeInstaller,
  dashboardStarter: ReleasedDashboardStarter | undefined,
): Promise<ManagedReleaseOutcome> {
  try {
    return await installer.withManagedTransaction(
      request.runtime,
      (transaction) => publishWithinManagedTransaction(
        deps,
        request,
        transaction,
        dashboardStarter,
      ),
    )
  } catch (error) {
    const indeterminate = error instanceof ManagedRuntimeIndeterminateError
    return {
      ok: false,
      state: indeterminate ? 'indeterminate' : 'unchanged',
      detail: indeterminate
        ? `managed runtime 事务状态无法证明：${error.message}`
        : `managed runtime 事务未开始或锁定失败，当前已验证 runtime 保持不变：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function publishWithinManagedTransaction(
  deps: CliDeps,
  request: ManagedReleaseRequest,
  transaction: ManagedRuntimeTransaction,
  dashboardStarter: ReleasedDashboardStarter | undefined,
): Promise<ManagedReleaseOutcome> {
  const prepared = await prepareManagedReleaseCandidate(
    deps,
    request,
    transaction,
    dashboardStarter,
  )
  if ('outcome' in prepared) return prepared.outcome
  let { journal } = prepared
  const { candidate } = prepared

  if (journal.phase === 'candidate-resolved') {
    await revalidateResolvedCandidate(request, journal, candidate)
  }

  if (
    journal.phase === 'candidate-resolved'
    && dashboardStarter !== undefined
    && journal.dashboardBefore === undefined
  ) {
    try {
      const dashboardBefore = await dashboardStarter.inspect(deps, {
        openBrowser: false,
        port: journal.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
      })
      if (dashboardBefore !== null) {
        journal = {
          ...journal,
          dashboardBefore,
          updatedAt: deps.clock(),
        }
      } else {
        journal = {
          ...journal,
          dashboardBeforeAbsent: true,
          updatedAt: deps.clock(),
        }
      }
      await transaction.journal.write(journal)
    } catch (error) {
      return {
        ok: false,
        state: 'indeterminate',
        detail: `无法在 activation 前冻结既有 Dashboard identity；未开始 runtime 激活：`
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  let activation: RuntimeActivation
  if (journal.phase === 'candidate-resolved' && journal.activation !== undefined) {
    if (journal.activationCheckpoint === undefined) {
      throw new ManagedRuntimeIndeterminateError('Dashboard-only reconciliation 缺少 activation checkpoint')
    }
    activation = journal.activation
    if (!await transaction.proveActivation(activation)) {
      throw new ManagedRuntimeIndeterminateError('Dashboard-only reconciliation 的 current activation 已漂移')
    }
    if (activation.auditPending === true) {
      throw new ManagedRuntimeIndeterminateError(
        'runtime selection/launcher 已提交，但 terminal audit 尚未持久化；保留 activating-runtime WAL 供同一命令恢复',
      )
    }
    assertManagedActivationIdentity(activation, request, journal)
    journal = {
      ...journal,
      phase: 'runtime-activated',
      updatedAt: deps.clock(),
    }
    await transaction.journal.write(journal)
  } else if (
    journal.phase === 'runtime-activated'
    || journal.phase === 'starting-dashboard'
    || journal.phase === 'dashboard-ready'
    || journal.phase === 'evidence-committed'
  ) {
    if (journal.activation === undefined) {
      throw new ManagedRuntimeIndeterminateError('write-ahead journal 缺少 activation')
    }
    activation = journal.activation
    let proven = false
    try {
      proven = await transaction.proveActivation(activation)
    } catch (error) {
      throw new ManagedRuntimeIndeterminateError(`无法验证 journal activation：${String(error)}`)
    }
    if (!proven) {
      throw new ManagedRuntimeIndeterminateError(
        `journal 中的 activation ${activation.release.releaseId} 与当前 selection/launcher 不一致`,
      )
    }
    assertManagedActivationIdentity(activation, request, journal)
  } else {
    let recovered: Awaited<ReturnType<ManagedRuntimeTransaction['recoverActivation']>> = {
      state: 'not-started',
    }
    if (journal.phase === 'activating-runtime') {
      if (journal.activationCheckpoint === undefined) {
        throw new ManagedRuntimeIndeterminateError('write-ahead journal 缺少 activation checkpoint')
      }
      try {
        recovered = await transaction.recoverActivation(journal.activationCheckpoint, request.source)
      } catch (error) {
        throw error instanceof ManagedRuntimeIndeterminateError
          ? error
          : new ManagedRuntimeIndeterminateError(`无法从 activation checkpoint 恢复：${String(error)}`)
      }
    } else {
      try {
        const activationCheckpoint = await transaction.checkpointActivation()
        journal = {
          ...journal,
          phase: 'activating-runtime',
          activationCheckpoint,
          updatedAt: deps.clock(),
        }
        await transaction.journal.write(journal)
      } catch (error) {
        return {
          ok: false,
          state: 'indeterminate',
          detail: `无法在 activation 前持久化 checkpoint；未开始 runtime 激活：${String(error)}`,
        }
      }
    }
    if (recovered.state === 'activated') {
      activation = recovered.activation
    } else {
      await revalidateResolvedCandidate(request, journal, candidate)
      try {
        activation = await transaction.activate(
          candidate.candidateRoot,
          request.source,
          request.expectedPluginVersion ?? journal.stableTarget?.version,
          journal.stableTarget,
          request.devSource,
        )
      } catch (error) {
        const indeterminate = error instanceof ManagedRuntimeIndeterminateError
        if (!indeterminate) {
          try {
            const retryable: ManagedReleaseJournalRecord = {
              version: 1,
              transactionId: journal.transactionId,
              operation: journal.operation,
              source: journal.source,
              phase: 'preparing-host',
              startedAt: journal.startedAt,
              updatedAt: deps.clock(),
              ...(journal.dashboardPort === undefined
                ? {}
                : { dashboardPort: journal.dashboardPort }),
              ...(journal.stableTarget === undefined
                ? {}
                : { stableTarget: journal.stableTarget }),
              ...(journal.hostSteps === undefined ? {} : { hostSteps: journal.hostSteps }),
            }
            await transaction.journal.write(retryable)
          } catch (journalError) {
            return {
              ok: false,
              state: 'indeterminate',
              detail: `runtime 激活已精确补偿，但 journal 无法重置为可重试状态：${String(journalError)}`,
            }
          }
        }
        return {
          ok: false,
          state: indeterminate ? 'indeterminate' : 'unchanged',
          detail: indeterminate
            ? `managed runtime 发布后的补偿状态无法证明：${error.message}`
            : `managed runtime 校验/发布失败，当前已验证 runtime 保持不变：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    if (activation.auditPending === true) {
      throw new ManagedRuntimeIndeterminateError(
        'runtime selection/launcher 已提交，但 terminal audit 尚未持久化；保留 activating-runtime WAL 供同一命令恢复',
      )
    }
    assertManagedActivationIdentity(activation, request, journal)
    try {
      journal = {
        ...journal,
        phase: 'runtime-activated',
        activation,
        updatedAt: deps.clock(),
      }
      await transaction.journal.write(journal)
    } catch (error) {
      return {
        ok: false,
        state: 'indeterminate',
        detail: `runtime 已激活，但 write-ahead journal 提交失败；未猜测回滚安全性：`
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const dashboard = await coordinateReleaseDashboard(
    deps,
    transaction,
    journal,
    activation,
    candidate.openBrowser ?? request.openBrowser,
    journal.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
    dashboardStarter,
    request.runtime.trustedNodePath,
    request.runtime.verifyTrustedNode,
  )
  if (!dashboard.ok) return dashboard
  journal = dashboard.journal
  let dashboardFailure = dashboard.dashboardFailure
  const candidateDashboard = dashboard.candidateDashboard
  const dashboardOwner = dashboard.dashboardOwner
  const activationChangedRelease =
    journal.activationCheckpoint?.selection.activeRelease !== activation.selection.activeRelease

  if (dashboardFailure === '') {
    if (journal.phase === 'evidence-committed') {
      try {
        await transaction.journal.clear(journal.transactionId)
        return {
          ok: true,
          state: 'ready',
          activation,
          ...(journal.stableTarget === undefined ? {} : { stableTarget: journal.stableTarget }),
        }
      } catch (error) {
        return {
          ok: false,
          state: 'indeterminate',
          detail: `ready evidence 已提交，但 journal 清理失败：${String(error)}`,
        }
      }
    }
    try {
      await request.commitReadyEvidence?.(activation, candidate, journal.transactionId, {
        ...(journal.stableTarget === undefined ? {} : { stableTarget: journal.stableTarget }),
      })
    } catch (error) {
      dashboardFailure = `ready evidence 提交失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (dashboardFailure === '') {
      try {
        journal = {
          ...journal,
          phase: 'evidence-committed',
          activation,
          updatedAt: deps.clock(),
        }
        await transaction.journal.write(journal)
        await transaction.journal.clear(journal.transactionId)
        return {
          ok: true,
          state: 'ready',
          activation,
          ...(journal.stableTarget === undefined ? {} : { stableTarget: journal.stableTarget }),
        }
      } catch (error) {
        return {
          ok: false,
          state: 'indeterminate',
          detail: `ready evidence 已提交，但最终 journal commit/clear 失败；未回滚已公开状态：${String(error)}`,
        }
      }
    }
  }

  if (dashboardOwner === 'preexisting' && activationChangedRelease) {
    return {
      ok: false,
      state: 'indeterminate',
      detail: `${dashboardFailure}；候选 release 与事务前既有 Dashboard 已对齐，`
        + '但 ready evidence 尚未提交；为保留可恢复的一致状态，未回滚 activation 或清理 journal',
    }
  }

  try {
    journal = {
      ...journal,
      phase: 'stopping-candidate',
      activation,
      compensationReason: dashboardFailure.slice(0, 4_096),
      updatedAt: deps.clock(),
    }
    await transaction.journal.write(journal)
  } catch (rollbackError) {
    return {
      ok: false,
      state: 'indeterminate',
      detail: `${dashboardFailure}，且补偿 WAL 无法在副作用前提交：`
        + `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
    }
  }
  return resumeManagedReleaseCompensation(
    deps,
    request.source,
    transaction,
    journal,
    dashboardStarter,
    candidateDashboard,
    request.runtime.trustedNodePath,
    request.runtime.verifyTrustedNode,
  )
}
