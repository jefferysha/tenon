/**
 * 任务的「领域」：轻量任务创建时记下的另一条分支（`tenon init --domain`），之后风险升级要另起重型任务时
 * 直接用它当轨道。init 校验和升级提示读同一份「除本任务轨道之外的分支」，两边不会各算各的。
 */
import { listTracks, type TrackResolvable } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'

/** 同一工作流里除本任务轨道之外的分支 id，按声明顺序；平铺工作流只有一条与它同名的隐式分支，所以没有别的。 */
export function siblingTrackIds(workflow: TrackResolvable, own: string): readonly string[] {
  return listTracks(workflow).map((branch) => branch.id).filter((id) => id !== own)
}

/** `--domain` 不合法的原因（可直接打印）；合法 = 同一工作流里另一条分支，返回 null。 */
export function domainRefusal(deps: CliDeps, workflow: TrackResolvable, own: string, domain: string): string | null {
  const siblings = siblingTrackIds(workflow, own)
  if (siblings.includes(domain)) return null
  return siblings.length === 0
    ? msg(deps, 'init.domainNoOtherTrack', { workflow: workflow.name, track: own })
    : msg(deps, 'init.domainInvalid', { domain, workflow: workflow.name, track: own, available: siblings.join(', ') })
}
