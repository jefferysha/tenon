import { join } from 'node:path'
import type { CliDeps } from '../deps.js'
import { LEGACY_PLUGIN_IDENTITY, TENON_PLUGIN_IDENTITY } from '../migration/legacy-tenon-migration.js'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { RuntimeActivation } from '../runtime/types.js'
import type { SetupEnv } from './setupEnvironment.js'
import { nativeRuntimeInstallerScope } from './native-runtime-installer-scope.js'
import {
  nativeInstallPlan,
  nativePluginRemovalPlan,
  parseHostPluginInventory,
  type HostPluginScope,
  type NativePipelineHost,
  type ParsedHostPluginInventory,
  type RemovableHostPluginScope,
} from './plugin-host.js'
import { compareReleaseOrder, type StableReleaseTarget } from './stable-release.js'
import {
  hostPluginConvergencePaths,
  parseSessionProof,
  readHostPluginConvergenceReceipt,
  writeHostPluginConvergenceReceipt,
  type HostPluginConvergenceReceipt,
} from './host-plugin-convergence-receipt.js'

export {
  hostPluginConvergencePaths,
  readHostPluginConvergenceReceipt,
  type ConvergenceRead,
  type HostPluginConvergencePaths,
  type HostPluginConvergenceReceipt,
} from './host-plugin-convergence-receipt.js'

export type ConvergenceFinalizeResult =
  | { readonly state: 'none' | 'cleaned' | 'waiting' }
  | { readonly state: 'failed'; readonly detail: string }


export function recordPendingHostPluginConflict(
  deps: CliDeps,
  env: SetupEnv,
  host: NativePipelineHost,
  inventory: ParsedHostPluginInventory,
  activation: RuntimeActivation,
  candidateRoot: string,
  transactionId: string,
  stableTarget: StableReleaseTarget,
): boolean {
  if (!/^[a-zA-Z0-9_-]+$/.test(transactionId)) {
    deps.io.err('ERROR: managed release transaction id 非法；未创建收敛 receipt。')
    return false
  }
  const existing = readHostPluginConvergenceReceipt(env, host)
  if (existing.state === 'invalid') {
    deps.io.err(`ERROR: ${existing.detail}；拒绝覆盖不可审计的收敛 receipt。`)
    return false
  }
  if (!inventory.enabledIds.has(LEGACY_PLUGIN_IDENTITY)) {
    if (existing.state === 'none') return true
    const previous = existing.receipt
    const sameRelease = previous.releaseId === activation.release.releaseId
      && previous.releaseRoot === join(activation.releaseRoot, 'payload')
      && previous.candidateRoot === candidateRoot
    const newerRelease = previous.stableTarget === undefined
      || compareReleaseOrder(stableTarget.version, previous.stableTarget.version) > 0
    if (!sameRelease && !newerRelease) {
      deps.io.err('ERROR: 已缺席的 legacy plugin 对应另一个未被当前稳定版本超越的 receipt；拒绝覆盖。')
      return false
    }
    const updatedAt = deps.clock()
    const createdAtEpoch = Math.floor(Date.parse(updatedAt) / 1000)
    if (!Number.isSafeInteger(createdAtEpoch) || createdAtEpoch < 0) {
      deps.io.err('ERROR: 当前时钟无法完成 legacy receipt；保留原审计状态。')
      return false
    }
    const completed: HostPluginConvergenceReceipt = {
      version: 4,
      transactionId,
      state: 'completed',
      host,
      conflictPluginId: LEGACY_PLUGIN_IDENTITY,
      conflictScopes: [],
      releaseId: activation.release.releaseId,
      releaseRoot: join(activation.releaseRoot, 'payload'),
      candidateRoot,
      stableTarget,
      createdAtEpoch,
      updatedAt,
    }
    if (!writeHostPluginConvergenceReceipt(deps, env, completed)) return false
    deps.io.out('[setup] legacy plugin 已缺席；旧 pending receipt 已由当前稳定 release 完成并取代。')
    return true
  }
  if (existing.state === 'receipt') {
    const receipt = existing.receipt
    const sameRelease = receipt.releaseId === activation.release.releaseId
      && receipt.releaseRoot === join(activation.releaseRoot, 'payload')
      && receipt.candidateRoot === candidateRoot
      && (receipt.stableTarget === undefined
        || (receipt.stableTarget.version === stableTarget.version
          && receipt.stableTarget.tag === stableTarget.tag
          && receipt.stableTarget.commit === stableTarget.commit))
    if (receipt.transactionId === transactionId && !sameRelease) {
      deps.io.err('ERROR: 同一 transaction id 的收敛 receipt 与当前 activation 不一致。')
      return false
    }
    if (receipt.state === 'cleanup-pending') {
      if (receipt.transactionId === transactionId) {
        if (receipt.stableTarget !== undefined) return true
        return writeHostPluginConvergenceReceipt(deps, env, { ...receipt, stableTarget })
      }
      const supersedesOlderRelease = receipt.releaseId !== activation.release.releaseId
        && (receipt.stableTarget === undefined
          || compareReleaseOrder(stableTarget.version, receipt.stableTarget.version) > 0)
      if (!supersedesOlderRelease) {
        deps.io.err('ERROR: 冲突清理 receipt 归属于另一个 managed transaction；拒绝覆盖。')
        return false
      }
      deps.io.out('[setup] 新稳定 runtime 已就绪；将旧版 pending receipt 原子升级到当前 release。')
    }
    if (receipt.state === 'completed' && sameRelease) {
      deps.io.out('[setup] 权威 inventory 检测到 legacy plugin 已重新启用；重新创建 cleanup-pending receipt。')
    }
  }
  const conflictScopes = [...(inventory.enabledScopes.get(LEGACY_PLUGIN_IDENTITY) ?? [])]
  if (conflictScopes.length === 0) {
    deps.io.err('ERROR: 冲突插件登记缺少可验证 scope；未创建清理事务。')
    return false
  }
  const updatedAt = deps.clock()
  const createdAtEpoch = Math.floor(Date.parse(updatedAt) / 1000)
  if (!Number.isSafeInteger(createdAtEpoch) || createdAtEpoch < 0) {
    deps.io.err('ERROR: 当前时钟无法生成迁移 receipt；冲突登记保持不变。')
    return false
  }
  const receipt: HostPluginConvergenceReceipt = {
    version: 4,
    transactionId,
    state: 'cleanup-pending',
    host,
    conflictPluginId: LEGACY_PLUGIN_IDENTITY,
    conflictScopes,
    releaseId: activation.release.releaseId,
    releaseRoot: join(activation.releaseRoot, 'payload'),
    candidateRoot,
    stableTarget,
    createdAtEpoch,
    updatedAt,
  }
  if (!writeHostPluginConvergenceReceipt(deps, env, receipt)) return false
  deps.io.out(
    '[setup] Tenon 候选与 managed runtime 已验证；旧登记暂时保留。'
    + '请启动新宿主会话，让当前 release 的 SessionStart 写入证明后再次运行 setup/update 完成官方清理。',
  )
  return true
}

function inventoryCommand(host: NativePipelineHost) {
  return nativeInstallPlan(host).at(-1)
}

function commandText(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ')
}

/** Caller owns the managed transaction and must prove the full identity before invoking cleanup. */
export async function finalizePendingHostPluginConflictWithinTransaction(
  deps: CliDeps,
  env: SetupEnv,
  installer: RuntimeInstaller,
  host: NativePipelineHost,
  receipt: HostPluginConvergenceReceipt,
): Promise<ConvergenceFinalizeResult> {
  const inspection = await installer.inspect(nativeRuntimeInstallerScope(env))
  if (
    !inspection.activeValid
    || inspection.selection.activeRelease !== receipt.releaseId
    || inspection.active?.releaseId !== receipt.releaseId
  ) {
    return {
      state: 'failed',
      detail: 'cleanup-pending receipt 与当前已验证 managed runtime 不一致；保留冲突登记',
    }
  }
  const { sessionProofPath } = hostPluginConvergencePaths(env, host)
  const proof = parseSessionProof(env.readText(sessionProofPath))
  if (
    proof === null
    || proof.host !== host
    || proof.releaseId !== receipt.releaseId
    || proof.releaseRoot !== receipt.releaseRoot
    || proof.loadedAtEpoch <= receipt.createdAtEpoch
  ) {
    deps.io.out('[setup] 等待新宿主会话加载当前 Tenon release；冲突登记尚未清理。')
    return { state: 'waiting' }
  }

  const list = inventoryCommand(host)
  if (list === undefined) return { state: 'failed', detail: '宿主安装计划缺少 inventory 命令' }
  const beforeResult = env.runCommand(list.cmd, [...list.args])
  const before = beforeResult.code === 0
    ? parseHostPluginInventory(host, beforeResult.stdout)
    : null
  if (before === null) {
    return { state: 'failed', detail: '宿主 plugin inventory 不可用或响应畸形；未执行清理' }
  }
  if (!before.enabledIds.has(TENON_PLUGIN_IDENTITY)) {
    return { state: 'failed', detail: '宿主 inventory 未证明 Tenon 登记仍启用；未执行清理' }
  }
  if (receipt.stableTarget === undefined
    || before.tenonRoot !== receipt.candidateRoot
    || before.tenonVersion !== receipt.stableTarget.version) {
    return {
      state: 'failed',
      detail: '宿主 inventory 的 Tenon root/version 与已证明 receipt 不一致；未执行清理',
    }
  }
  let current = before
  if (current.enabledIds.has(receipt.conflictPluginId)) {
    const liveScopes = current.enabledScopes.get(receipt.conflictPluginId) ?? new Set<HostPluginScope>()
    if ([...liveScopes].some((scope) => !receipt.conflictScopes.includes(scope))) {
      return { state: 'failed', detail: '冲突登记 scope 已变化；拒绝按陈旧 receipt 执行清理' }
    }
    let remaining = receipt.conflictScopes.filter((scope) => liveScopes.has(scope))
    for (const scope of [...remaining]) {
      if (scope === 'managed') {
        return { state: 'failed', detail: '检测到 managed scope 冲突登记；需要宿主管理员在同一 scope 完成清理' }
      }
      const tenonScopes = current.enabledScopes.get(TENON_PLUGIN_IDENTITY) ?? new Set<HostPluginScope>()
      if (!tenonScopes.has(scope)) {
        return {
          state: 'failed',
          detail: `Tenon 尚未在 ${scope} scope 启用；拒绝删除该 scope 的旧工作流插件`,
        }
      }
      for (const item of nativePluginRemovalPlan(host, receipt.conflictPluginId, scope)) {
        deps.io.out(`[setup] 新会话已证明 Tenon 可用；通过宿主插件管理器清理：$ ${commandText(item.cmd, item.args)}`)
        const result = env.runCommand(item.cmd, [...item.args])
        if (result.code !== 0) {
          return {
            state: 'failed',
            detail: result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`,
          }
        }
      }
      const checkpointResult = env.runCommand(list.cmd, [...list.args])
      const checkpoint = checkpointResult.code === 0
        ? parseHostPluginInventory(host, checkpointResult.stdout)
        : null
      if (checkpoint === null
        || (checkpoint.enabledScopes.get(receipt.conflictPluginId) ?? new Set()).has(scope)
        || !(checkpoint.enabledScopes.get(TENON_PLUGIN_IDENTITY) ?? new Set()).has(scope)) {
        return { state: 'failed', detail: `清理 ${scope} scope 后的宿主 inventory 未收敛` }
      }
      current = checkpoint
      remaining = remaining.filter((candidate) => candidate !== scope)
      if (remaining.length > 0 && !writeHostPluginConvergenceReceipt(deps, env, {
        ...receipt,
        conflictScopes: remaining,
        updatedAt: deps.clock(),
      })) {
        return { state: 'failed', detail: `已清理 ${scope} scope，但剩余 scope checkpoint 持久化失败` }
      }
    }
  }

  const afterResult = env.runCommand(list.cmd, [...list.args])
  const after = afterResult.code === 0
    ? parseHostPluginInventory(host, afterResult.stdout)
    : null
  if (
    after === null
    || after.enabledIds.has(receipt.conflictPluginId)
    || !after.enabledIds.has(TENON_PLUGIN_IDENTITY)
  ) {
    return {
      state: 'failed',
      detail: '官方清理后的宿主 inventory 未收敛为唯一 Tenon 登记',
    }
  }
  return { state: 'cleaned' }
}
