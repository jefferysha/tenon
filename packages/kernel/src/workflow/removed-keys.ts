/**
 * 已删除的 workflow 键：解析时点名报错，而不是当成未知字段含糊拒绝——旧 YAML 打不开时
 * 用户要立刻知道改用什么。
 */
export const REMOVED_KEY_ERROR = (key: string): string =>
  `workflow 解析错误：'${key}' 已删除——评审改用步骤 agents.reviewers`

export const REMOVED_WORKFLOW_KEYS: readonly string[] = ['review_budget', 'review_lanes', 'kind', 'review_lane']
