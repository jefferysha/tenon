import type { CliDeps } from '../deps.js'
import {
  ManagedRuntimeIndeterminateError,
  type ManagedReleaseJournalRecord,
  type ManagedReleaseOperation,
  type ManagedRuntimeTransaction,
} from '../runtime/installer.js'
import type { NativeRuntimeHost } from '../runtime/types.js'
import { DEFAULT_DASHBOARD_PORT } from './dashboard.js'
import { isExactLegacyV101NativeJournal } from './release-legacy-setup-retirement.js'

interface JournalRequest {
  readonly operation: ManagedReleaseOperation
  readonly source: NativeRuntimeHost | 'adapter'
  readonly expectedPluginVersion?: string
  readonly dashboardPort?: number
  readonly requiresStableTarget?: boolean
  readonly devSource?: object
  readonly resolveStableTargetBeforeRecovery?: () =>
    | import('../runtime/installer.js').ManagedStableReleaseTarget
    | Promise<import('../runtime/installer.js').ManagedStableReleaseTarget>
  readonly proveFrozenTarget?: (
    target: import('../runtime/installer.js').ManagedStableReleaseTarget,
  ) => void | Promise<void>
}

/**
 * Resolve the one durable transaction journal and freeze its concrete Dashboard port. Existing
 * transactions always win over a changed retry environment; legacy journals are migrated only
 * while their exact port can still be inferred safely.
 */
export async function resolveManagedReleaseJournal(
  deps: CliDeps,
  request: JournalRequest,
  transaction: ManagedRuntimeTransaction,
): Promise<ManagedReleaseJournalRecord> {
  let pending: ManagedReleaseJournalRecord | null
  try {
    pending = await transaction.journal.read()
  } catch (error) {
    throw new ManagedRuntimeIndeterminateError(
      `无法读取 write-ahead journal：${String(error)}`,
      { cause: error },
    )
  }
  if (pending === null) {
    let stableTarget: import('../runtime/installer.js').ManagedStableReleaseTarget | undefined
    if (request.requiresStableTarget === true) {
      if (request.resolveStableTargetBeforeRecovery === undefined) {
        throw new Error('native managed release 缺少 mutation 前 stable target resolver')
      }
      stableTarget = await request.resolveStableTargetBeforeRecovery()
      await request.proveFrozenTarget?.(stableTarget)
    }
    const created = {
      ...transaction.journal.create(request.operation, request.source, deps.clock()),
      dashboardPort: request.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
      ...(stableTarget === undefined ? {} : { stableTarget }),
    }
    try {
      await transaction.journal.write(created)
      return created
    } catch (error) {
      throw new ManagedRuntimeIndeterminateError(
        `稳定目标已证明，但无法创建 write-ahead journal：${String(error)}`,
        { cause: error },
      )
    }
  }
  try {
    if (request.devSource !== undefined && pending.stableTarget !== undefined) {
      throw new ManagedRuntimeIndeterminateError(
        `存在未完成的正式 ${pending.operation} 事务 ${pending.transactionId}`
        + `（已冻结稳定目标 ${pending.stableTarget.tag}）；先运行 `
        + `tenon ${pending.operation === 'update' ? 'update' : 'setup'} --${request.source} 完成或恢复它，再做开发安装`,
      )
    }
    const potentialLegacyNative = request.operation === 'setup'
      && (request.source === 'codex' || request.source === 'claude')
      && request.requiresStableTarget === true
      && (pending.operation === 'setup' || pending.operation === 'update')
      && pending.source === request.source
      && pending.stableTarget === undefined
    const exactLegacyNative = potentialLegacyNative
      && isExactLegacyV101NativeJournal(request, pending)
    if (potentialLegacyNative && !exactLegacyNative) {
      throw new ManagedRuntimeIndeterminateError(
        `未完成事务 ${pending.transactionId} 缺少 stable target，但不满足精确 v1.0.1 WAL envelope；`
        + '拒绝重解释或改写第三态 journal',
      )
    }
    const legacyUpdateBridge = exactLegacyNative && pending.operation === 'update'
    if ((pending.operation !== request.operation || pending.source !== request.source)
      && !legacyUpdateBridge) {
      throw new ManagedRuntimeIndeterminateError(
        `存在未完成的 ${pending.operation}/${pending.source} 事务 ${pending.transactionId}，`
        + `拒绝启动 ${request.operation}/${request.source}`,
      )
    }
    if (pending.dashboardPort !== undefined) return pending

    const inferredPort = pending.dashboard?.port ?? pending.dashboardBefore?.port
    const canAdoptRequestedPort = pending.phase === 'preparing-host'
      || pending.phase === 'candidate-resolved'
    const legacyNativeSuccessor = exactLegacyNative
    // v1.0.1 native WALs predate both stableTarget and dashboardPort. Do not normalize them here:
    // the retirement path must first resolve and prove the successor tag, then replace the same
    // transaction in one write so a resolver failure leaves the legacy bytes untouched.
    if (legacyNativeSuccessor) return pending
    if (inferredPort === undefined && !canAdoptRequestedPort) {
      throw new ManagedRuntimeIndeterminateError(
        `未完成事务 ${pending.transactionId} 已进入 ${pending.phase}，但旧 journal 缺少 `
        + 'pre-activation Dashboard port；拒绝从 retry 环境补证',
      )
    }
    const migrated = {
      ...pending,
      dashboardPort: inferredPort ?? request.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
      updatedAt: deps.clock(),
    }
    await transaction.journal.write(migrated)
    return migrated
  } catch (error) {
    throw error instanceof ManagedRuntimeIndeterminateError
      ? error
      : new ManagedRuntimeIndeterminateError(
        `无法读取或创建 write-ahead journal：${String(error)}`,
        { cause: error },
      )
  }
}
