import type { CliDeps } from '../deps.js'
import {
  hostFlag,
  nativeInstallPlan,
  nativeUpdatePlan,
  parseHostPluginInventory,
  TENON_RELEASE_VERSION,
  type NativePipelineHost,
  type ParsedHostPluginInventory,
} from './plugin-host.js'
import { runManagedHostCommand } from './managed-host-command.js'
import type { ManagedHostPreparationContext } from './release-coordinator.js'
import type { SetupEnv } from './setupEnvironment.js'
import { nativeHostMatchesStableTarget } from './managed-host-observation.js'
import { resolveStableTagTarget, type StableReleaseTarget } from './stable-release.js'
import { verifyPackagedAssets } from './packaged-assets.js'
import {
  hostConvergenceInterruptionReport,
  nativeHostConvergenceSequence,
  nativeHostRestoreCommands,
  type NativeHostUpdateStepId,
} from './native-host-convergence-sequence.js'

function commandText(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Marketplace add is idempotent on some host versions but reports a non-zero duplicate on others. */
function isDuplicateMarketplaceResult(result: { stdout: string; stderr: string }): boolean {
  return /already|exists|registered|duplicate/i.test(`${result.stdout}\n${result.stderr}`)
}

export interface NativePluginCandidate {
  readonly root: string
  /** Existing host inventory was fully verified before reuse. */
  readonly verified: boolean
  /** Authoritative enabled ids from the same inventory snapshot that resolved `root`. */
  readonly inventory: ParsedHostPluginInventory
  readonly inventoryRaw: string
}

interface ExistingNativePlugin {
  readonly candidate: NativePluginCandidate | null
  /** Authoritative pre-mutation fact from the host-owned inventory, not a guess about the cache. */
  readonly pluginRegistered: boolean
}

class NativePluginInventoryError extends Error {
  override readonly name = 'NativePluginInventoryError'
}

function proveFrozenTarget(env: SetupEnv, frozen: StableReleaseTarget): void {
  const proven = resolveStableTagTarget(env, frozen.version)
  if (proven.tag !== frozen.tag || proven.commit !== frozen.commit) {
    throw new Error(
      `稳定标签 ${frozen.tag} 当前证明 ${proven.commit} 与冻结 commit ${frozen.commit} 不一致`,
    )
  }
}

async function verifiedInstalledNativePlugin(
  deps: CliDeps,
  env: SetupEnv,
  host: NativePipelineHost,
  transaction: ManagedHostPreparationContext,
  target: StableReleaseTarget,
): Promise<ExistingNativePlugin> {
  const inventoryCommand = nativeInstallPlan(host).at(-1)
  if (inventoryCommand === undefined) throw new NativePluginInventoryError('宿主安装计划缺少 inventory 命令')
  deps.io.out(`[setup] $ ${commandText(inventoryCommand.cmd, inventoryCommand.args)}`)
  const inventory = await runManagedHostCommand(
    transaction,
    'inventory-before',
    env,
    inventoryCommand,
  )
  if (inventory.code !== 0) {
    throw new NativePluginInventoryError(
      `宿主 plugin inventory 读取失败：${inventory.stderr.trim() || inventory.stdout.trim() || `退出码 ${inventory.code}`}`,
    )
  }
  const parsed = parseHostPluginInventory(host, inventory.stdout)
  if (parsed === null) throw new NativePluginInventoryError('宿主 plugin inventory 响应畸形')
  const root = parsed.tenonRoot
  if (root === null) return { candidate: null, pluginRegistered: parsed.tenonRegistered }
  let exactStableTarget = false
  if (parsed.tenonVersion === target.version) {
    try {
      exactStableTarget = nativeHostMatchesStableTarget(env, host, target)
    } catch {
      exactStableTarget = false
    }
  }
  if (!exactStableTarget) {
    deps.io.out(
      `[setup] ${hostFlag(host)} 已登记的 tenon 未绑定 ${target.tag}；将通过宿主 CLI 重绑正式 release。`,
    )
    return { candidate: null, pluginRegistered: true }
  }
  if (verifyPackagedAssets(deps, env, root, false, true) !== 0) {
    deps.io.out(`[setup] ${hostFlag(host)} 已登记的 tenon 不完整或未通过校验；将重新安装正式 release。`)
    return { candidate: null, pluginRegistered: true }
  }
  deps.io.out(`[setup] ${hostFlag(host)} 已有完整且已验证的 tenon；复用宿主登记的安装。`)
  return {
    candidate: { root, verified: true, inventory: parsed, inventoryRaw: inventory.stdout },
    pluginRegistered: true,
  }
}

/**
 * Resolve and freeze the release target before the first host mutation, then install the single
 * release plugin into the selected native host and resolve its root from host-owned inventory.
 *
 * The mutation sequence is register-before-remove in the only form the host CLIs allow: a removal
 * is emitted only when there is a registration to remove, and the network-dependent replacement is
 * re-proved against the remote immediately before the first destructive command.  An offline or
 * rate-limited remote therefore aborts with the host untouched instead of after the deletions.
 */
export async function installNativePluginCandidate(
  deps: CliDeps,
  env: SetupEnv,
  host: NativePipelineHost,
  transaction: ManagedHostPreparationContext,
): Promise<NativePluginCandidate | null> {
  const target = await transaction.resolveStableTarget(
    async () => resolveStableTagTarget(env, TENON_RELEASE_VERSION),
    (frozen) => proveFrozenTarget(env, frozen),
  )
  let existing: ExistingNativePlugin
  try {
    existing = await verifiedInstalledNativePlugin(deps, env, host, transaction, target)
  } catch (error) {
    if (error instanceof NativePluginInventoryError) {
      deps.io.err(`ERROR: ${error.message}；未执行安装或清理。`)
      return null
    }
    throw error
  }
  if (existing.candidate !== null) return existing.candidate

  const plan = nativeUpdatePlan(host, target)
  const steps = nativeHostConvergenceSequence(plan, { plugin: existing.pluginRegistered })
  const restoreCommands = nativeHostRestoreCommands(plan)
  const resumeCommand = `tenon setup ${hostFlag(host)}`
  const provenDestructiveStepIds: NativeHostUpdateStepId[] = []
  let replacementRegistered = false
  const reportInterruption = (stepId: string, reason: string): void => {
    if (provenDestructiveStepIds.length === 0 || replacementRegistered) return
    for (const line of hostConvergenceInterruptionReport({
      host,
      stepId,
      reason,
      target,
      provenDestructiveStepIds,
      hadInstalledPlugin: existing.pluginRegistered,
      restoreCommands,
      resumeCommand,
    })) deps.io.err(line)
  }

  if (existing.pluginRegistered) {
    // Removing a working installation is only safe once the replacement is proved obtainable.
    // Proving the frozen tag/commit against the remote here keeps an offline or rate-limited run
    // from deleting the host's only tenon and then failing at `marketplace add`.
    try {
      proveFrozenTarget(env, target)
    } catch (error) {
      deps.io.err(
        `ERROR: ${hostFlag(host)} 升级前无法向远端证明 ${target.tag} @ ${target.commit}：`
        + `${errorText(error)}`,
      )
      deps.io.err(
        '[setup] 未执行任何宿主删除或安装；当前 tenon 登记保持不变。'
        + `网络恢复后重新运行 \`${resumeCommand}\` 即可。`,
      )
      return null
    }
  }

  let inventory = ''
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) continue
    const { id: stepId, item } = step
    deps.io.out(`[setup] $ ${commandText(item.cmd, item.args)}`)
    let result
    try {
      result = await runManagedHostCommand(transaction, stepId, env, item, target)
    } catch (error) {
      reportInterruption(stepId, errorText(error))
      throw error
    }
    if (result.stdout.trim() !== '') deps.io.out(result.stdout.trimEnd())
    if (result.code === 0) {
      if (step.destructive) provenDestructiveStepIds.push(stepId)
      if (stepId === 'plugin-install') replacementRegistered = true
      if (index === steps.length - 1) inventory = result.stdout
      continue
    }

    if (stepId === 'marketplace-register' && isDuplicateMarketplaceResult(result)) {
      deps.io.out(`[setup] ${hostFlag(host)} marketplace 已存在，继续验证插件。`)
      continue
    }

    if (stepId === 'plugin-install') {
      const inventoryCommand = steps.at(-1)?.item
      if (!inventoryCommand) {
        deps.io.err(`[setup] ${hostFlag(host)} 安装计划缺少 inventory 命令。`)
        reportInterruption(stepId, '安装计划缺少 inventory 命令')
        return null
      }
      const inventoryResult = await runManagedHostCommand(
        transaction,
        'inventory-after',
        env,
        inventoryCommand,
      )
      const parsed = inventoryResult.code === 0
        ? parseHostPluginInventory(host, inventoryResult.stdout)
        : null
      if (parsed?.tenonRoot !== null && parsed?.tenonRoot !== undefined) {
        deps.io.out(`[setup] ${hostFlag(host)} 已报告 tenon；继续验证版本、tag 与 payload identity。`)
        replacementRegistered = true
        inventory = inventoryResult.stdout
        break
      }
    }

    const reason = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`
    deps.io.err(`ERROR: ${commandText(item.cmd, item.args)} 失败：${reason}`)
    reportInterruption(stepId, reason)
    return null
  }
  const parsed = parseHostPluginInventory(host, inventory)
  if (parsed === null) {
    deps.io.err(`ERROR: ${hostFlag(host)} 插件清单响应畸形；未切换 launcher。`)
    return null
  }
  if (parsed.tenonRoot === null) {
    deps.io.err(`ERROR: ${hostFlag(host)} 插件清单中没有 tenon；未切换 launcher。`)
    reportInterruption('inventory-after', `${hostFlag(host)} 插件清单中没有 tenon`)
    return null
  }
  if (parsed.tenonVersion !== target.version) {
    deps.io.err(
      `ERROR: ${hostFlag(host)} 插件版本 ${parsed.tenonVersion ?? 'unknown'} `
        + `不等于正式 release ${target.version}；未切换 launcher。`,
    )
    return null
  }
  let exactStableTarget = false
  try {
    exactStableTarget = nativeHostMatchesStableTarget(env, host, target)
  } catch (error) {
    deps.io.err(
      `ERROR: ${hostFlag(host)} 安装后无法证明 marketplace/tag identity：`
        + `${errorText(error)}`,
    )
    return null
  }
  if (!exactStableTarget) {
    deps.io.err(
      `ERROR: ${hostFlag(host)} 安装后未精确绑定 ${target.tag} @ ${target.commit}；未切换 launcher。`,
    )
    return null
  }
  return {
    root: parsed.tenonRoot,
    verified: false,
    inventory: parsed,
    inventoryRaw: inventory,
  }
}
