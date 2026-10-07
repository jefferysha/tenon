import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '@tenon/kernel'
import { ManagedRuntimeIndeterminateError } from './installer-contract.js'
import {
  captureStableLaunchers,
  expectedStableLaunchers,
  installerOwnedStableLauncherTransition,
  writeStableLaunchers,
} from './launchers.js'
import { transactionRuntimeStore as transactionStore } from './runtime-installer-store.js'
import {
  discardUnflippedRollbackJournal,
  readRollbackJournal,
  rollbackJournalPath,
  selectionMatchesRollbackTarget,
  type RuntimeRollbackJournal,
} from './runtime-rollback-journal.js'
import type { RuntimeActivation, RuntimePaths, TrustedExecutableProof } from './types.js'

/** Everything the rollback needs from the caller's scope; the Node proof is the identity the launchers pin. */
export interface RuntimeRollbackContext {
  readonly paths: RuntimePaths
  readonly homeDir: string
  readonly trustedBashPath: string | undefined
  readonly verifyTrustedBash: (() => void) | undefined
  readonly trustedNodePath: string | undefined
  readonly trustedNodeProof: TrustedExecutableProof | undefined
  readonly verifyTrustedNode: (() => void) | undefined
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function launcherOptions(context: RuntimeRollbackContext) {
  return {
    ...(context.trustedNodePath === undefined ? {} : { nodeExecutable: context.trustedNodePath }),
    ...(context.trustedNodeProof === undefined ? {} : { nodeProof: context.trustedNodeProof }),
    ...(context.verifyTrustedNode === undefined ? {} : { verifyNode: context.verifyTrustedNode }),
  }
}

/**
 * Roll back to the previous verified release under a durable journal, or resume the journal that is already there.
 *
 * Commit order: journal (target + launcher checkpoint) -> launcher proof -> selection flip -> launcher pair -> journal removal.
 * Everything before the flip is undone by removing the journal, so a refusal there leaves the install exactly as it was.
 * After the flip the journal is the way forward: the same command finishes the launcher pair and removes it.
 */
export async function rollbackWithinTransaction(context: RuntimeRollbackContext): Promise<RuntimeActivation> {
  const { paths, homeDir, verifyTrustedNode } = context
  const store = transactionStore(
    paths,
    context.trustedBashPath,
    context.verifyTrustedBash,
    context.trustedNodePath,
    verifyTrustedNode,
  )
  let journal = await readRollbackJournal(paths)
  if (journal === null) {
    const before = await store.inspect()
    if (!before.previousValid || before.previous === null || before.selection.previousRelease === null) {
      throw new ManagedRuntimeIndeterminateError(
        '没有可回滚的已验证 runtime release；请重新运行 tenon setup --<host>',
      )
    }
    journal = {
      version: 1,
      transactionId: randomUUID(),
      beforeSelection: before.selection,
      target: {
        revision: before.selection.revision + 1,
        activeRelease: before.selection.previousRelease,
        previousRelease: before.selection.activeRelease,
      },
      launchers: await captureStableLaunchers(paths, homeDir),
    }
    await atomicWriteFile(rollbackJournalPath(paths), `${JSON.stringify(journal, null, 2)}\n`)
  }
  const launcherSnapshot = journal.launchers
  verifyTrustedNode?.()
  const launcherCommitted = expectedStableLaunchers(paths, homeDir, context.trustedNodePath, context.trustedNodeProof)
  let inspection = await store.inspect()
  if (sameJson(inspection.selection, journal.beforeSelection)) {
    // Nothing has moved yet. A launcher pair that is neither the journal checkpoint nor the target, or a target that
    // fails its integrity check, ends the rollback here and takes the journal with it; otherwise the failed attempt
    // would leave `tenon setup` and `tenon update` refusing on a rollback that never took effect.
    try {
      const current = await captureStableLaunchers(paths, homeDir)
      if (!installerOwnedStableLauncherTransition(current, launcherSnapshot, launcherCommitted)) {
        throw new Error('rollback refuses a stable launcher pair it cannot prove belongs to this install')
      }
      const committed = await store.rollbackToPrevious()
      if (!selectionMatchesRollbackTarget(committed.selection, journal.target)
        || committed.release.releaseId !== journal.target.activeRelease) {
        throw new ManagedRuntimeIndeterminateError('runtime rollback selection 未提交冻结目标')
      }
    } catch (error) {
      const after = await store.inspect().catch(() => null)
      if (after !== null && sameJson(after.selection, journal.beforeSelection)) {
        await discardUnflippedRollbackJournal(paths, journal)
      }
      throw error
    }
    inspection = await store.inspect()
  }
  if (inspection.auditPending === true) {
    throw new ManagedRuntimeIndeterminateError(
      'runtime rollback selection 已提交，但 terminal audit 尚未持久化；保留 rollback journal',
    )
  }
  if (!selectionMatchesRollbackTarget(inspection.selection, journal.target)
    || !inspection.activeValid || inspection.active?.releaseId !== journal.target.activeRelease) {
    throw new ManagedRuntimeIndeterminateError(
      'runtime rollback journal 与当前 selection 不一致；拒绝再次翻转或覆盖并发状态',
    )
  }
  try {
    await writeStableLaunchers(paths, homeDir, { checkpoint: launcherSnapshot, ...launcherOptions(context) })
    const exactLaunchers = await captureStableLaunchers(paths, homeDir)
    if (!sameJson(exactLaunchers, launcherCommitted)) {
      throw new ManagedRuntimeIndeterminateError('runtime rollback launcher pair 未收敛到冻结 Node 身份')
    }
    const persisted = await readRollbackJournal(paths)
    if (persisted === null || persisted.transactionId !== journal.transactionId) {
      throw new ManagedRuntimeIndeterminateError('runtime rollback journal owner 在提交前发生漂移')
    }
    await rm(rollbackJournalPath(paths))
    return {
      selection: inspection.selection,
      release: inspection.active,
      releaseRoot: join(paths.releasesRoot, inspection.active.releaseId),
      launcherSnapshot,
      launcherCommitted,
    }
  } catch (error) {
    throw new ManagedRuntimeIndeterminateError(
      `runtime rollback selection 已冻结；launcher 尚未收敛，请重跑同一 repair 命令：${String(error)}`,
    )
  }
}

/**
 * Settle a rollback journal that is still on disk when `tenon setup` or `tenon update` takes the exclusive transaction.
 *
 * A journal means a rollback began and never finished. v0.2.1 to v0.3.1 left exactly that behind whenever the bootstrap
 * refused the installer's launcher after it had already flipped the selection, and every release that refuses on the
 * journal keeps `setup` and `update` out of the install. This release finishes it instead of refusing:
 *  - selection still equals the journal's `beforeSelection`: the flip never happened, so the rollback never took effect.
 *    The launchers only move after the flip, so removing the journal restores the exact pre-rollback state; a private
 *    launcher copy of that transaction goes with it, but only when it is the journal's recorded checkpoint.
 *  - selection equals the journal's target: the flip happened. Finish the rollback the way `tenon runtime repair --rollback`
 *    does (launcher pair, journal removal) and let the caller continue from the rolled-back release.
 *  - anything else: another writer moved the selection since the journal was written. That stays a refusal.
 *
 * The caller holds `<managedTransactionRoot>/.pipeline.lock` (withExclusiveRuntimeTransaction). That is the lock the bootstrap's
 * rollback takes first, so a journal that is "durable, selection not flipped" here is an abandoned rollback and never one that
 * is still running; a bootstrap test freezes a real rollback between its journal and its flip to pin exactly that.
 */
export async function settlePendingRollback(
  context: RuntimeRollbackContext,
  journal: RuntimeRollbackJournal,
): Promise<void> {
  const store = transactionStore(
    context.paths,
    context.trustedBashPath,
    context.verifyTrustedBash,
    context.trustedNodePath,
    context.verifyTrustedNode,
  )
  const { selection } = await store.inspect()
  if (sameJson(selection, journal.beforeSelection)) {
    await discardUnflippedRollbackJournal(context.paths, journal)
    return
  }
  if (!selectionMatchesRollbackTarget(selection, journal.target)) {
    throw new ManagedRuntimeIndeterminateError(
      '存在未完成的 runtime rollback，且 runtime selection 既不是它的起点也不是它的目标；'
      + '拒绝覆盖并发状态，请先运行 tenon runtime status 核对',
    )
  }
  try {
    await rollbackWithinTransaction(context)
  } catch (error) {
    throw new ManagedRuntimeIndeterminateError(
      `存在未完成的 runtime rollback，收尾失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
