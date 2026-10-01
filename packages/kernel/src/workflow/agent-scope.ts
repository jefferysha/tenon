/**
 * 评审者按风险挂载（纯函数）：agent 文件的 `attach_on` 声明「只有改动碰到这几类路径才需要我」，
 * 这里把它换算成当前步骤里不必挂载的评审者名单（`StepAgentsInput.unattached`）。
 *
 * 失败关闭：读不出本任务的改动（`touched` 缺席）时一律挂载——宁可多审，不能因为 git 读不出来就悄悄少审。
 * 没声明 `attach_on` 的评审者永远挂载，所以没有这个字段的旧 agent、已冻结任务里的旧副本行为不变。
 */
import type { PathClass } from '../workspace/path-classes.js'

export function unattachedReviewers(
  reviewers: readonly { readonly agent: string }[],
  attachOnOf: (agent: string) => readonly PathClass[] | undefined,
  touched: ReadonlySet<PathClass> | undefined,
): readonly string[] {
  if (touched === undefined) return []
  return reviewers
    .filter((ref) => {
      const scope = attachOnOf(ref.agent)
      return scope !== undefined && !scope.some((pathClass) => touched.has(pathClass))
    })
    .map((ref) => ref.agent)
}
