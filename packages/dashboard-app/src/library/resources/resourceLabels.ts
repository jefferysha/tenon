import { licenseModes } from '@tenon/kernel/resources/query'
import type { ResourceEntry } from '../../api/resourceTypes'

/** 条目的许可模式：仅链接 / 可再分发 二选一，需署名附加在后。 */
export function licenseModeKeys(entry: ResourceEntry): readonly string[] {
  return licenseModes(entry).map((mode) => mode.replace(/-/gu, '_'))
}

export const licenseTone = (entry: ResourceEntry): 'done' | 'pending' =>
  (entry.license.redistributable ? 'done' : 'pending')

/** 新建条目的起始骨架：合法 schema + 空列表 + 今天的核验日期，保存后即可编辑。 */
export function resourceSkeleton(id: string, today: string): string {
  return [
    'schema: tenon-resource/v1',
    `id: ${id}`,
    `name: ${id}`,
    'category: component-lib',
    'frameworks: []',
    'styling: []',
    'baseline: false',
    'license:',
    '  spdx: MIT',
    '  url: https://example.com/LICENSE',
    '  redistributable: true',
    '  attribution: false',
    '  commercial: free',
    'install: []',
    'skills: []',
    'links:',
    '  home: https://example.com',
    `verified_at: ${today}`,
    '',
  ].join('\n')
}
