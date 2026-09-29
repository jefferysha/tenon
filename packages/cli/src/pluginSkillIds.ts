/**
 * 插件里存在的技能 id：上游来源清单 `skills/sources.yaml` 与自带技能登记 `templates/skill-sources.yaml`。
 * `tenon agent validate|add|new` 据此核对 agent 声明的技能；任一文件读不到就只少那一部分。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillSources, parseUpstreamSkillSources } from '@tenon/kernel'

export function pluginSkillIds(pluginRoot: string): ReadonlySet<string> {
  const ids = new Set<string>()
  try {
    for (const source of parseUpstreamSkillSources(readFileSync(join(pluginRoot, 'skills', 'sources.yaml'), 'utf8')).skills) {
      ids.add(source.id)
    }
  } catch {
    // 清单缺失或损坏：只少上游这一部分，validate 会把相应技能报成不存在。
  }
  try {
    for (const source of parseSkillSources(readFileSync(join(pluginRoot, 'templates', 'skill-sources.yaml'), 'utf8'))) {
      ids.add(source.token)
    }
  } catch {
    // 同上：自带技能登记读不到时只少这一部分。
  }
  return ids
}
