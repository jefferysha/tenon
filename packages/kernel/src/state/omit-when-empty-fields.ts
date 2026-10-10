import type { FieldName } from '../types.js'

/**
 * 任务级可选字段：值为空串时既不进 canonical wire，也不进 YAML 投影；缺这一键的历史 wire / 投影读成空串。
 *
 * 没设置过它的任务因此逐字节不变——revision digest、review gate 绑定摘要（对序列化后的整份状态求哈希）、
 * 旧窄解析器与 N-1 读者都不受升级影响，在途任务不会因为字段表多了一项被判成投影漂移。只有显式设置了值的
 * 任务才出现这个键。
 */
export const OMIT_WHEN_EMPTY_FIELDS = ['max_rounds'] as const satisfies readonly FieldName[]

const OMIT_WHEN_EMPTY: ReadonlySet<string> = new Set(OMIT_WHEN_EMPTY_FIELDS)

export function isOmitWhenEmpty(field: string): boolean {
  return OMIT_WHEN_EMPTY.has(field)
}
