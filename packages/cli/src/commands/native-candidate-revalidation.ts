import type { CliDeps } from '../deps.js'
import {
  nativeInstallPlan,
  parseHostPluginInventory,
  type NativePipelineHost,
  type ParsedHostPluginInventory,
} from './plugin-host.js'
import {
  nativeHostMatchesStableTarget,
  nativeHostStableTargetMismatch,
} from './managed-host-observation.js'
import type { SetupEnv } from './setupEnvironment.js'
import { resolveStableTagTarget, type StableReleaseTarget } from './stable-release.js'

export function observeNativeStableTarget(
  env: SetupEnv,
  host: NativePipelineHost,
  target: StableReleaseTarget,
  failureLabel: string,
): boolean {
  try {
    return nativeHostMatchesStableTarget(env, host, target)
  } catch (error) {
    throw new Error(`${failureLabel}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Fresh, read-only proof that a persisted candidate still belongs to the exact stable host
 * registration. Journal inventory is recovery input only; it is never activation authority.
 */
export function revalidateNativeStableCandidate(
  deps: CliDeps,
  env: SetupEnv,
  host: NativePipelineHost,
  target: StableReleaseTarget,
  candidateRoot: string,
  verifyAssets: (root: string) => boolean,
): ParsedHostPluginInventory {
  const proven = resolveStableTagTarget(env, target.version)
  if (proven.tag !== target.tag || proven.commit !== target.commit) {
    throw new Error(
      `稳定标签 ${target.tag} 当前证明 ${proven.commit} 与冻结 commit ${target.commit} 不一致`,
    )
  }

  const inventoryCommand = nativeInstallPlan(host).at(-1)
  if (inventoryCommand === undefined) throw new Error('宿主安装计划缺少 inventory proof')
  const inventoryResult = env.runCommand(inventoryCommand.cmd, [...inventoryCommand.args])
  if (inventoryResult.code !== 0) {
    throw new Error(
      `候选重证无法读取宿主 inventory：`
      + `${inventoryResult.stderr.trim() || `退出码 ${inventoryResult.code}`}`,
    )
  }
  const inventory = parseHostPluginInventory(host, inventoryResult.stdout)
  if (inventory === null || inventory.tenonRoot === null) {
    throw new Error('候选重证未在权威宿主 inventory 中找到启用的 Tenon')
  }
  if (inventory.tenonRoot !== candidateRoot) {
    throw new Error(
      `候选根已漂移：journal=${candidateRoot}; inventory=${inventory.tenonRoot}`,
    )
  }
  if (inventory.tenonVersion !== target.version) {
    throw new Error(
      `候选版本已漂移：inventory=${inventory.tenonVersion ?? 'unknown'}; target=${target.version}`,
    )
  }
  const beforeAssets = nativeHostStableTargetMismatch(env, host, target)
  if (beforeAssets !== null) {
    throw new Error(`候选宿主不再匹配冻结稳定目标：${beforeAssets}`)
  }
  if (!verifyAssets(candidateRoot)) throw new Error('候选打包资产重证失败')
  const afterAssets = nativeHostStableTargetMismatch(env, host, target)
  if (afterAssets !== null) {
    throw new Error(`候选资产校验后宿主稳定 identity 发生漂移：${afterAssets}`)
  }
  return inventory
}
