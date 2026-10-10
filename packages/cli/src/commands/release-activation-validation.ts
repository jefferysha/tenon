import { ManagedRuntimeIndeterminateError, type ManagedReleaseJournalRecord } from '../runtime/installer.js'
import { devSourceEquals } from '../runtime/dev-source-identity.js'
import type { RuntimeActivation } from '../runtime/types.js'
import type { ManagedReleaseRequest } from './release-coordinator-contract.js'

export async function revalidateResolvedCandidate(
  request: ManagedReleaseRequest,
  journal: ManagedReleaseJournalRecord,
  candidate: { readonly candidateRoot: string; readonly evidence?: string },
): Promise<void> {
  if (request.revalidateCandidate === undefined) return
  try {
    await request.revalidateCandidate(candidate, {
      transactionId: journal.transactionId,
      ...(journal.stableTarget === undefined ? {} : { stableTarget: journal.stableTarget }),
    })
  } catch (error) {
    throw error instanceof ManagedRuntimeIndeterminateError
      ? error
      : new ManagedRuntimeIndeterminateError(
          `candidate-resolved 后的宿主/候选重证失败；拒绝开始 runtime activation：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
  }
}

export function assertManagedActivationIdentity(
  activation: RuntimeActivation,
  request: ManagedReleaseRequest,
  journal: ManagedReleaseJournalRecord,
): void {
  if (activation.selection.activeRelease !== activation.release.releaseId) {
    throw new ManagedRuntimeIndeterminateError(
      `activation selection ${activation.selection.activeRelease ?? 'missing'} `
      + `不等于 release ${activation.release.releaseId}`,
    )
  }
  if (activation.release.source.host !== request.source) {
    throw new ManagedRuntimeIndeterminateError(
      `activation source ${activation.release.source.host} 不等于 transaction source ${request.source}`,
    )
  }
  const frozenTarget = journal.stableTarget
  const releaseTarget = activation.release.version === 2
    ? activation.release.stableTarget
    : undefined
  if (frozenTarget !== undefined
    && (activation.release.version !== 2
      || releaseTarget === undefined
      || releaseTarget.version !== frozenTarget.version
      || releaseTarget.tag !== frozenTarget.tag
      || releaseTarget.commit !== frozenTarget.commit)) {
    throw new ManagedRuntimeIndeterminateError(
      `activation ${activation.release.releaseId} 的 stable target `
      + `${releaseTarget?.tag ?? 'missing'} @ ${releaseTarget?.commit ?? 'missing'} `
      + `不等于 journal 冻结目标 ${frozenTarget.tag} @ ${frozenTarget.commit}`,
    )
  }
  const releaseDev = activation.release.version === 2 ? activation.release.devSource : undefined
  if (request.devSource !== undefined) {
    if (releaseDev === undefined || !devSourceEquals(releaseDev, request.devSource)) {
      throw new ManagedRuntimeIndeterminateError(
        `activation ${activation.release.releaseId} 的 devSource 与本次冻结的源码身份不一致；`
        + '若工作区在上一次未完成的开发安装后改过，先还原到当时的状态再重试，'
        + '或运行 tenon runtime repair --rollback 放弃那次事务',
      )
    }
  } else if (releaseDev !== undefined) {
    throw new ManagedRuntimeIndeterminateError(
      `activation ${activation.release.releaseId} 带有 devSource，但本事务不是开发安装`,
    )
  }
  const expectedVersion = request.expectedPluginVersion ?? journal.stableTarget?.version
  if (expectedVersion !== undefined && activation.release.source.pluginVersion !== expectedVersion) {
    throw new ManagedRuntimeIndeterminateError(
      `activation ${activation.release.releaseId} 声明版本 `
      + `${activation.release.source.pluginVersion}，不等于冻结目标 ${expectedVersion}`,
    )
  }
}
