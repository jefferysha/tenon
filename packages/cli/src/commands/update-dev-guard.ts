import type { DevInstallMarker } from '../runtime/dev-install-marker.js'
import { devVersionLabel } from '../runtime/dev-source-identity.js'
import type { RuntimeReleaseManifest } from '../runtime/types.js'
import { hostFlag, type NativePipelineHost } from './plugin-host.js'

export type DevUpdateDecision =
  | { readonly action: 'proceed'; readonly fromDev: boolean }
  | { readonly action: 'refuse'; readonly message: readonly string[] }

/** 本机 install-channel 标记，以及 runtime 是否读得出来（读不出来时标记是唯一的渠道证据）。 */
export interface DevUpdateEvidence {
  readonly marker: DevInstallMarker | null
  readonly inspectFailed: boolean
}

const NO_EVIDENCE: DevUpdateEvidence = { marker: null, inspectFailed: false }

/**
 * 开发安装之上的 `tenon update`：默认拒绝，免得一次后台或手滑的 update 把源码安装换回正式版；
 * `--to-stable` 是显式授权的切回，此时稳定路径要跳过「拒绝降级」（开发版本号来自仓库，可能高于最新正式版）。
 * runtime 读不出来（inspectFailed）时以标记为准：标记是 dev 就按开发安装处理（fail-closed），没有标记才走稳定路径。
 */
export function decideDevUpdate(
  active: RuntimeReleaseManifest | null,
  host: NativePipelineHost,
  toStable: boolean,
  evidence: DevUpdateEvidence = NO_EVIDENCE,
): DevUpdateDecision {
  const { marker } = evidence
  const activeDev = active !== null && active.version === 2 ? active.devSource : undefined
  const markerDev = active === null && evidence.inspectFailed && marker !== null ? marker.devSource : undefined
  const dev = activeDev ?? markerDev
  if (dev === undefined) return { action: 'proceed', fromDev: false }
  if (toStable) return { action: 'proceed', fromDev: true }
  // 宿主 flag 优先取标记里记录的宿主；标记属于别的 release（回滚后陈旧）时不采信。
  const markerHost = marker !== null && (active === null || marker.releaseId === active.releaseId) ? marker.host : null
  const flag = hostFlag(markerHost ?? host)
  const label = active === null
    ? `commit ${dev.commit.slice(0, 7)}`
    : devVersionLabel(active.source.pluginVersion, dev.commit)
  return {
    action: 'refuse',
    message: [
      `ERROR: 当前是源码开发安装（${label}，仓库 ${dev.repoRealpath}）；`
      + 'tenon update 只认正式稳定版，默认拒绝，以免覆盖开发安装。',
      `[update] 重新同步源码：tenon setup ${flag} --from-source ${dev.repoRealpath}`,
      `[update] 切回正式版：tenon update ${flag} --to-stable`,
    ],
  }
}
