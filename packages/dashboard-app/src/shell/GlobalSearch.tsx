/** 视图内的简单包含匹配（任务名 / 工作流 / 轨道 / 阶段），大小写不敏感；空查询匹配一切。 */
export function matchesQuery(query: string, ...haystack: readonly (string | undefined | null)[]): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
}
