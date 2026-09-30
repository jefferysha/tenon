/**
 * 测试证据按谁的记录判定。运行记录按用户分目录，而 `tenon test run` 与 `transition` 都只认任务负责人，
 * 所以 Dashboard 上一个任务的测试状态就是负责人的记录——别人打开页面看到的不该是自己那份空目录
 * （真机验收 F15：非负责人查看时一律显示 test-not-run）。没有负责人（旧任务）才退回查看者。
 */
import { ownerOf, type PipelineState, type TenonUser } from '@tenon/kernel'

export interface EvidenceUser {
  readonly id: string
  readonly name: string
}

export function evidenceUserFor(fields: PipelineState['fields'], viewer: TenonUser | undefined): EvidenceUser | undefined {
  const owner = ownerOf(fields)
  if (owner !== null) return { id: owner.id, name: owner.name }
  return viewer === undefined ? undefined : { id: viewer.id, name: viewer.name }
}
