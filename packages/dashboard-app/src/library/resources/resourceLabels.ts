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
